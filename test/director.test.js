import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs'; import path from 'node:path';
import { MCFLY_ROOT } from '../src/prompt.js';
import { SCENE_KINDS, SCENE_ENTER, SCENE_ACCENTS, SCENE_STYLES, SCENE_ICONS } from '../src/storyboard.js';

const read = (...p) => fs.readFileSync(path.join(MCFLY_ROOT, ...p), 'utf8');

test('памятка режиссёру называет все виды сцен, появления и значения оформления из кода', () => {
  const guide = read('prompts', 'video-guide.md');
  for (const k of [...SCENE_KINDS, ...SCENE_ENTER, ...SCENE_ACCENTS, ...SCENE_STYLES, ...SCENE_ICONS]) assert.match(guide, new RegExp('`' + k + '`'), k);
});
test('шаблоны роликов знают все значки и стили из кода', () => {
  const weekly = read('video', 'src', 'Weekly.jsx'); const daily = read('video', 'src', 'Daily.jsx');
  for (const i of SCENE_ICONS) assert.match(weekly, new RegExp(`\\b${i}:`), i);
  for (const a of SCENE_ACCENTS) { assert.match(weekly, new RegExp(`\\b${a}:`), a); assert.match(daily, new RegExp(`\\b${a}:`), a); }
  for (const s of SCENE_STYLES) assert.ok((weekly + daily).includes(`'${s}'`), s);
});
test('роль режиссёра: без формата сцен (он в памятке) и без данных проектов; зритель умеет смотреть ролик', () => {
  const role = read('agents', 'director.md');
  assert.match(role, /^name: director$/m); assert.match(role, /^tools: Read, Write, Edit, Glob$/m); assert.doesNotMatch(role, /"kind"/);
  assert.match(read('agents', 'user.md'), /смотреть ролик-сводку/);
});

// --- запуск режиссёра и зрителя ---
import { directScenes, runAgent } from '../src/director.js';
import { videoPaths } from '../src/video.js';
import { parseConfig } from '../src/config.js';
import { paths } from '../src/state.js';
import { appendMetric } from '../src/metrics.js';
import { cfg, bareProject, tmpDir } from './helpers.js';

const SAMPLE = { change: 'repeat', title: 'Повторы', text: 'Твои повторы:\n1. Зарядка — каждый день\n2. Таблетка — по вторникам', buttons: [['Убрать 1', 'Вернуть']] };
const DATA = { html: '<b>сводка</b>', keyboard: [[{ text: 'x' }]], plain: [{ slot: '00:00', text: 'Что сделано: повторы.\nЗачем: удобно.' }], demos: [SAMPLE], work: [], runStats: { ok: 2 } };
const BASE = [{ key: 's0', kind: 'text', title: 'demo', lines: ['Утренняя сводка'], speech: 'Доброе утро.', hold: 0 }, { key: 's1', kind: 'text', title: 'Что дальше', lines: ['Работы нет'], speech: 'Работы в очереди нет.', hold: 3 }];
const GOOD = [
  { kind: 'hook', title: 'Повторы больше не теряются', lines: ['Два новых умения'], speech: 'За ночь бот научился сам вести повторяющиеся дела, и это ещё не всё.' },
  { kind: 'chat', title: 'Повторы', lines: ['Список одним сообщением'], speech: 'Все повторяющиеся дела теперь видны списком, лишнее убирается одним касанием.', chat: { text: SAMPLE.text, buttons: [['Убрать 1', 'Вернуть']] } },
  { kind: 'number', title: 'Ночь без сбоев', lines: [], number: { value: 2, label: 'запуска команды' }, speech: 'Команда отработала дважды, и оба раза без сбоев.' },
  { kind: 'finale', title: 'Хорошего дня', lines: [], speech: 'На сегодня это всё. Хорошего дня.' },
];
const BAD = GOOD.map((s, i) => (i === 0 ? { ...s, title: 'Пункт I22 готов' } : s));
const NOW = new Date(2026, 10, 16, 8, 0, 5);

/** Подставные роли: steps[n] — что делает n-й запуск: (cwd, вызов) → { ok?, text?, reason? } или исключение. */
function scripted(steps) {
  const calls = [];
  const agent = async (_cfg, call) => { calls.push(call); const r = await steps[calls.length - 1]?.(call.cwd, call); return { ok: true, text: '', reason: '', ...(r || {}) }; };
  return { agent, calls };
}
const writes = (board) => (cwd) => { fs.writeFileSync(path.join(cwd, 'storyboard.json'), JSON.stringify(board)); };
const says = (text) => () => ({ text });
const setup = (video = {}) => { const home = tmpDir('director-home-'); const c = { ...cfg, video: { ...cfg.video, ...video } }; return { p: paths(bareProject()), c, vp: videoPaths(c, { home }), home }; };
const stills = async (_cfg, { dir }) => { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, '01.png'), 'png'); return [path.join(dir, '01.png')]; };
const direct = (s, mode, agent, extra = {}) => directScenes(s.p, s.c, { data: DATA, baseScenes: BASE, now: NOW, mode, vp: s.vp, agent, stills, ...extra });

test('настройки: director по умолчанию review, 8 минут, сборка 15 минут; ошибки называют поле', () => {
  const v = parseConfig('project: demo').video;
  assert.equal(v.director, 'review'); assert.equal(v.director_minutes, 8); assert.equal(v.timeout_minutes, 15);
  assert.throws(() => parseConfig('project: demo\nvideo:\n  director: always'), /video\.director/);
  assert.throws(() => parseConfig('project: demo\nvideo:\n  director_minutes: 0'), /video\.director_minutes/);
});

test('mode on: раскадровка принята с первого раза — сцены режиссёра, один запуск', async () => {
  const s = setup(); const { agent, calls } = scripted([writes(GOOD)]);
  const r = await direct(s, 'on', agent);
  assert.equal(r.source, 'director'); assert.equal(calls.length, 1); assert.equal(calls[0].agent, 'mcfly:director');
  assert.deepEqual(r.scenes.map((x) => x.title), GOOD.map((x) => x.title)); assert.ok(r.scenes.every((x) => x.key && x.hold === 0));
  assert.match(calls[0].prompt, /утреннего ролика/); assert.match(calls[0].prompt, /60 секунд/);
});

test('mode on: нарушения → один повтор со списком нарушений → принята', async () => {
  const s = setup(); const { agent, calls } = scripted([writes(BAD), writes({ scenes: GOOD })]);
  const r = await direct(s, 'on', agent);
  assert.equal(r.source, 'director'); assert.equal(calls.length, 2); assert.match(calls[1].prompt, /номера пунктов/);
  assert.match(fs.readFileSync(path.join(r.workDir, 'violations.txt'), 'utf8'), /номера пунктов/);
});

test('mode on: дважды не принята — запасные сцены, причина названа и попала в журнал', async () => {
  const s = setup(); const { agent, calls } = scripted([writes(BAD), writes(BAD)]); const lines = [];
  const r = await direct(s, 'on', agent, { log: (l) => lines.push(l) });
  assert.equal(r.source, 'fallback'); assert.equal(r.scenes, BASE); assert.match(r.reason, /не принята/); assert.equal(calls.length, 2); assert.match(lines.join('\n'), /запасных сцен/);
});

test('mode review: кадры → зритель → правка принята; сцена с выдумкой, оставшаяся дословно, вырезана', async () => {
  const s = setup(); const after = GOOD.map((x, i) => (i === 0 ? { ...x, title: 'Повторы под присмотром' } : x));
  const { agent, calls } = scripted([writes(GOOD), says('[{"scene":3,"kind":"fact","problem":"нет в данных","fix":"убрать"}]'), writes(after)]);
  const r = await direct(s, 'review', agent);
  assert.equal(r.source, 'review'); assert.deepEqual(calls.map((c) => c.agent), ['mcfly:director', 'mcfly:user', 'mcfly:director']);
  assert.deepEqual(r.scenes.map((x) => x.title), ['Повторы под присмотром', 'Повторы', 'Хорошего дня']);
  assert.ok(fs.existsSync(path.join(r.workDir, 'stills', '01.png'))); assert.ok(fs.existsSync(path.join(r.workDir, 'storyboard.v1.json')));
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(r.workDir, 'remarks.json'), 'utf8'))[0].scene, 3);
});

test('mode review: зритель ответил прозой или пустым списком — остаётся раскадровка режиссёра, правки нет', async () => {
  for (const answer of ['Ролик хороший, замечаний нет.', '[]', '']) {
    const s = setup(); const { agent, calls } = scripted([writes(GOOD), says(answer)]);
    const r = await direct(s, 'review', agent);
    assert.equal(r.source, 'director'); assert.equal(calls.length, 2); assert.equal(r.scenes.length, 4);
  }
});

test('mode review: правка не принята или зритель упал — раскадровка до правки без сцен с выдумкой', async () => {
  const fact = says('[{"scene":3,"kind":"fact","problem":"п","fix":"ф"}]');
  let s = setup(); let r = await direct(s, 'review', scripted([writes(GOOD), fact, writes(BAD), writes(BAD)]).agent);
  assert.equal(r.source, 'director'); assert.deepEqual(r.scenes.map((x) => x.title), [GOOD[0].title, GOOD[1].title, GOOD[3].title]);
  s = setup(); r = await direct(s, 'review', scripted([writes(GOOD), fact, () => ({ ok: false, reason: 'quota: лимит' })]).agent);
  assert.equal(r.source, 'director'); assert.equal(r.scenes.length, 3);
  s = setup(); r = await direct(s, 'review', scripted([writes(GOOD), () => { throw new Error('зритель упал'); }]).agent);
  assert.equal(r.source, 'director'); assert.equal(r.scenes.length, 4);
  s = setup(); r = await direct(s, 'review', scripted([writes(GOOD)]).agent, { stills: async () => { throw new Error('кадры не собрались'); } });
  assert.equal(r.source, 'director'); assert.equal(r.scenes.length, 4);
});

test('mode review: правка с нарушениями — одна попытка исправить; принята — идёт в ролик, нет — отвергнутая сохранена для разбора', async () => {
  const view = says('[{"scene":1,"kind":"view","problem":"п","fix":"ф"}]'); const better = GOOD.map((x, i) => (i === 0 ? { ...x, title: 'Повторы под присмотром' } : x));
  let s = setup(); let sc = scripted([writes(GOOD), view, writes(BAD), writes(better)]);
  let r = await direct(s, 'review', sc.agent);
  assert.equal(r.source, 'review'); assert.equal(sc.calls.length, 4); assert.match(sc.calls[3].prompt, /номера пунктов/); assert.equal(r.scenes[0].title, 'Повторы под присмотром');
  s = setup(); sc = scripted([writes(GOOD), view, writes(BAD), writes(BAD)]); const lines = [];
  r = await direct(s, 'review', sc.agent, { log: (l) => lines.push(l) });
  assert.equal(r.source, 'director'); assert.equal(r.scenes[0].title, GOOD[0].title); assert.match(lines.join('\n'), /не принята проверкой: сцена 1/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(r.workDir, 'storyboard.rejected.json'), 'utf8'))[0].title, 'Пункт I22 готов');
});

test('mode review: после вырезания выдумок осталось две сцены — запасные', async () => {
  const s = setup(); const two = '[{"scene":1,"kind":"fact","problem":"п","fix":"ф"},{"scene":3,"kind":"fact","problem":"п","fix":"ф"}]';
  const r = await direct(s, 'review', scripted([writes(GOOD), says(two), writes(GOOD)]).agent);
  assert.equal(r.source, 'fallback'); assert.equal(r.scenes, BASE); assert.match(r.reason, /после замечаний зрителя/);
});

test('режиссёр недоступен: отказ запуска, исключение, не JSON, файла нет — запасные сцены без исключения', async () => {
  for (const step of [() => ({ ok: false, reason: 'quota: лимит подписки' }), () => { throw new Error('spawn claude ENOENT'); }, (cwd) => fs.writeFileSync(path.join(cwd, 'storyboard.json'), 'это не JSON'), () => {}]) {
    const s = setup(); const r = await direct(s, 'review', scripted([step, step]).agent);
    assert.equal(r.source, 'fallback'); assert.equal(r.scenes, BASE); assert.ok(r.reason);
  }
});

test('недельный лимит подписки 90 % и больше — режиссёр не запускается', async () => {
  const s = setup(); const { agent, calls } = scripted([writes(GOOD)]);
  appendMetric(s.p, { type: 'run', id: 'r1', status: 'ok', started_at: NOW.toISOString(), usage: { five_hour: 0.1, seven_day: 0.92 } });
  const r = await direct(s, 'on', agent);
  assert.equal(r.source, 'fallback'); assert.equal(calls.length, 0); assert.match(r.reason, /лимит подписки/); assert.equal(r.workDir, null);
});

test('пустая ночь и пустая неделя — режиссёр не запускается', async () => {
  const s = setup(); const { agent, calls } = scripted([writes(GOOD)]);
  let r = await directScenes(s.p, s.c, { data: { plain: [], demos: [], work: [] }, baseScenes: BASE, now: NOW, mode: 'review', vp: s.vp, agent, stills });
  assert.equal(r.source, 'fallback'); assert.match(r.reason, /нечего/);
  r = await directScenes(s.p, s.c, { data: { features: [], goals: null }, baseScenes: BASE, weekly: true, now: NOW, mode: 'review', vp: s.vp, agent, stills });
  assert.equal(r.source, 'fallback'); assert.equal(calls.length, 0);
});

test('mode off — запасные сцены сразу, рабочая папка не создаётся, в журнале пусто', async () => {
  const s = setup(); const { agent, calls } = scripted([]); const lines = [];
  const r = await direct(s, 'off', agent, { log: (l) => lines.push(l) });
  assert.equal(r.source, 'fallback'); assert.equal(r.reason, ''); assert.equal(calls.length, 0); assert.deepEqual(lines, []); assert.ok(!fs.existsSync(path.join(s.home, 'work')));
});

test('рабочая папка: вне проекта, имя проекта из папки не выводит, данные без html и keyboard, хранится 8 последних', async () => {
  const s = setup(); s.c = { ...s.c, project: '../../etc' }; s.vp = videoPaths(s.c, { home: s.home });
  let last;
  for (let i = 0; i < 10; i += 1) last = await directScenes(s.p, s.c, { data: DATA, baseScenes: BASE, now: new Date(2026, 10, 16, 8, 0, i), mode: 'on', vp: s.vp, agent: scripted([writes(GOOD)]).agent, stills });
  const root = path.dirname(last.workDir);
  assert.ok(root.startsWith(path.join(s.home, 'work') + path.sep)); assert.ok(!last.workDir.startsWith(s.p.root ?? '\0'));
  assert.equal(fs.readdirSync(root).length, 8);
  const data = JSON.parse(fs.readFileSync(path.join(last.workDir, 'data.json'), 'utf8'));
  assert.ok(!('html' in data) && !('keyboard' in data)); assert.equal(data.demos[0].title, 'Повторы');
  assert.ok(fs.existsSync(path.join(last.workDir, 'GUIDE.md'))); assert.ok(!('hold' in JSON.parse(fs.readFileSync(path.join(last.workDir, 'base.json'), 'utf8'))[0]));
});

test('общий предел director_minutes: время вышло — следующие запуски не начинаются', async () => {
  const s = setup({ director_minutes: 8 }); let t = 0; const { agent, calls } = scripted([(cwd) => { t = 9 * 60_000; writes(BAD)(cwd); }, writes(GOOD)]);
  const r = await direct(s, 'on', agent, { clock: () => t });
  assert.equal(r.source, 'fallback'); assert.equal(calls.length, 1); assert.match(r.reason, /вышло время/); assert.ok(calls[0].timeoutMs <= 8 * 60_000);
});

test('недельный ролик: в задании — итоги недели и свой лимит; образцы из features', async () => {
  const s = setup(); const { agent, calls } = scripted([writes(GOOD)]);
  const weekly = { features: [{ title: 'Повторы', benefit: 'удобно', weight: 2, sample: { text: SAMPLE.text, buttons: SAMPLE.buttons } }] };
  const r = await directScenes(s.p, s.c, { data: weekly, baseScenes: BASE, weekly: true, now: NOW, mode: 'on', vp: s.vp, agent, stills });
  assert.equal(r.source, 'director'); assert.match(calls[0].prompt, /итоги недели/); assert.match(calls[0].prompt, /120 секунд/);
});

test('runAgent: роль, папка плагина и режим правок в аргументах; ответ и отказ', async () => {
  const seen = [];
  const run = async (o) => { seen.push(o); return { exitCode: 0, stdout: `${JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: '[]' })}\n`, stderr: '', timedOut: false }; };
  const ok = await runAgent(cfg, { agent: 'mcfly:director', prompt: 'задание', cwd: '/tmp/x', timeoutMs: 1000, run });
  assert.deepEqual(ok, { ok: true, text: '[]', reason: '', usage: null, sessionId: '' });
  assert.equal(seen[0].cwd, '/tmp/x'); assert.equal(seen[0].timeoutMs, 1000); assert.equal(seen[0].args.at(-1), 'задание');
  assert.ok(seen[0].args.join(' ').includes(`--plugin-dir ${MCFLY_ROOT} --agent mcfly:director`)); assert.ok(seen[0].args.join(' ').includes('--permission-mode acceptEdits'));
  const late = await runAgent(cfg, { agent: 'mcfly:user', prompt: 'п', cwd: '/tmp/x', timeoutMs: 1, run: async () => ({ exitCode: null, stdout: '', stderr: '', timedOut: true }) });
  assert.equal(late.ok, false); assert.match(late.reason, /^timeout/);
  const none = await runAgent(cfg, { agent: 'mcfly:user', prompt: 'п', cwd: '/tmp/x', timeoutMs: 1, run: async () => ({ exitCode: -1, stdout: '', stderr: 'Error: spawn claude ENOENT', timedOut: false }) });
  assert.equal(none.ok, false); assert.match(none.reason, /ENOENT/);
});

// --- по итогам проверки ветки ---
test('runAgent: роли не видят токен бота и секреты проекта; набор инструментов ограничен, подключённые серверы не грузятся', async () => {
  process.env.TOK_DIRECTOR_TEST = 'secret'; process.env.PROJECT_SECRET_TEST = 'secret2';
  const seen = []; const run = async (o) => { seen.push(o); return { exitCode: 0, stdout: `${JSON.stringify({ type: 'result', is_error: false, result: 'ок' })}\n`, stderr: '', timedOut: false }; };
  const c = { ...cfg, telegram: { ...cfg.telegram, token_env: 'TOK_DIRECTOR_TEST' } };
  await runAgent(c, { agent: 'mcfly:director', prompt: 'задание', cwd: '/tmp/x', timeoutMs: 1000, run, tools: 'Read,Write,Glob', hide: ['PROJECT_SECRET_TEST'] });
  delete process.env.TOK_DIRECTOR_TEST; delete process.env.PROJECT_SECRET_TEST;
  assert.ok(!('TOK_DIRECTOR_TEST' in seen[0].env) && !('PROJECT_SECRET_TEST' in seen[0].env)); assert.ok(seen[0].env.PATH);
  const a = seen[0].args; assert.equal(a[a.indexOf('--tools') + 1], 'Read,Write,Glob'); assert.ok(a.includes('--strict-mcp-config'));
  assert.equal(a.at(-1), 'задание'); assert.equal(a.at(-3), '--agent'); // задание — последним и не сразу после списка инструментов
});

test('directScenes: режиссёру — чтение и запись, зрителю — только чтение; секреты из mcfly/.env скрыты', async () => {
  const s = setup(); fs.writeFileSync(s.p.env, 'MY_DEPLOY_KEY=abc\n# комментарий\nOTHER=1\n');
  const { agent, calls } = scripted([writes(GOOD), says('[]')]);
  await direct(s, 'review', agent);
  assert.deepEqual(calls.map((c) => c.tools), ['Read,Write,Edit,Glob', 'Read,Glob']);
  assert.ok(calls.every((c) => c.hide.includes('MY_DEPLOY_KEY') && c.hide.includes('OTHER')));
});

test('directScenes: ответ зрителя не разобрался — строка в журнале и ответ сохранён для разбора', async () => {
  const s = setup(); const lines = [];
  const r = await direct(s, 'review', scripted([writes(GOOD), says('Кадры [01.png] хорошие, но [{"scene": 1, оборвано')]).agent, { log: (l) => lines.push(l) });
  assert.equal(r.source, 'director'); assert.match(lines.join('\n'), /ответ зрителя не разобран/); assert.match(fs.readFileSync(path.join(r.workDir, 'viewer.txt'), 'utf8'), /оборвано/);
});

test('0.15.2 данные режиссёру: при списке done отдельно идут только образцы того, что ещё в работе; образец из done годится для сцены чата', async () => {
  const s = setup(); const { agent } = scripted([writes(GOOD)]);
  const data = { plain: [], demos: [{ change: 'готовое', title: 'а', text: 'Сделано', buttons: [] }, { change: 'будущее', title: 'б', text: 'Впереди', buttons: [], ahead: true }], done: [{ title: 'Повторы', benefit: 'удобно', visible: true, sample: { text: SAMPLE.text, buttons: SAMPLE.buttons } }] };
  const r = await directScenes(s.p, s.c, { data, baseScenes: BASE, now: NOW, mode: 'on', vp: s.vp, agent, stills });
  assert.equal(r.source, 'director'); // чат GOOD взят из done[0].sample
  const written = JSON.parse(fs.readFileSync(path.join(r.workDir, 'data.json'), 'utf8'));
  assert.deepEqual(written.demos.map((d) => d.change), ['будущее']); assert.equal(written.done.length, 1);
});

test('0.15.2 пустые пересказы, но есть завершённое — режиссёр запускается', async () => {
  const s = setup(); const { agent, calls } = scripted([writes(GOOD)]);
  await directScenes(s.p, s.c, { data: { plain: [], demos: [], done: [{ title: 'Повторы', benefit: '', visible: true, sample: { text: SAMPLE.text, buttons: SAMPLE.buttons } }] }, baseScenes: BASE, now: NOW, mode: 'on', vp: s.vp, agent, stills });
  assert.equal(calls.length, 1);
});

test('0.15.4 учёт расхода: usage.json в рабочей папке, сумма в результате и строка в журнале', async () => {
  const s = setup(); const lines = [];
  const u = (input, read, out) => ({ usage: { input, cache_write: 0, cache_read: read, output: out, turns: 2, cost_usd: 0.01 } });
  const sc = scripted([(cwd) => { writes(GOOD)(cwd); return u(100, 5000, 900); }, () => ({ text: '[]', ...u(50, 7000, 200) })]);
  const r = await direct(s, 'review', sc.agent, { log: (l) => lines.push(l) });
  assert.deepEqual(r.usage, { calls: 2, input: 150, cache_write: 0, cache_read: 12000, output: 1100, tokens: 13250, cost_usd: 0.02 });
  const saved = JSON.parse(fs.readFileSync(path.join(r.workDir, 'usage.json'), 'utf8'));
  assert.deepEqual(saved.calls.map((c) => c.role), ['mcfly:director', 'mcfly:user']); assert.equal(saved.total.tokens, 13250);
  assert.match(lines.join('\n'), /запусков 2, токенов 13250/);
});
test('0.15.4 usageOf: поля итогового события claude; нет usage — null', async () => {
  const { usageOf } = await import('../src/director.js');
  assert.deepEqual(usageOf({ usage: { input_tokens: 3, cache_creation_input_tokens: 10, cache_read_input_tokens: 20, output_tokens: 4 }, num_turns: 5, total_cost_usd: 0.5 }), { input: 3, cache_write: 10, cache_read: 20, output: 4, turns: 5, cost_usd: 0.5 });
  assert.equal(usageOf({ result: 'x' }), null); assert.equal(usageOf(null), null);
});

test('0.15.4 экономия: повторные запуски режиссёра продолжают его сессию, зритель — отдельная; сессия не продолжилась — один запуск с нуля', async () => {
  const sid = (id) => (cwd) => { writes(GOOD)(cwd); return { sessionId: id }; };
  let s = setup(); let sc = scripted([(cwd) => { writes(BAD)(cwd); return { sessionId: 'S1' }; }, sid('S1'), says('[{"scene":1,"kind":"view","problem":"п","fix":"ф"}]'), sid('S1')]);
  await direct(s, 'review', sc.agent);
  assert.deepEqual(sc.calls.map((c) => [c.agent, c.resume]), [['mcfly:director', ''], ['mcfly:director', 'S1'], ['mcfly:user', ''], ['mcfly:director', 'S1']]);
  s = setup(); sc = scripted([(cwd) => { writes(BAD)(cwd); return { sessionId: 'S1' }; }, () => ({ ok: false, reason: 'error: сессия не найдена' }), sid('S2')]);
  const r = await direct(s, 'on', sc.agent);
  assert.equal(r.source, 'director'); assert.deepEqual(sc.calls.map((c) => c.resume || ''), ['', 'S1', '']); assert.match(sc.calls[2].prompt, /Сначала прочитай GUIDE\.md/);
});
test('0.15.4 экономия: в задании — бюджет речи в знаках; данные без служебных полей и отступов; --resume в аргументах', async () => {
  const s = setup(); const { agent, calls } = scripted([writes(GOOD)]);
  const many = { ...DATA, need: ['x'], next: 'y', running: false, planning: true, done: Array.from({ length: 8 }, (_, i) => ({ title: `В ${i}`, benefit: 'п', visible: true, sample: i ? null : { text: SAMPLE.text, buttons: SAMPLE.buttons } })) };
  const r = await directScenes(s.p, s.c, { data: many, baseScenes: BASE, now: NOW, mode: 'on', vp: s.vp, agent, stills });
  assert.match(calls[0].prompt, /не больше \d+ знаков, а раз заметных пунктов в данных много \(8\) — не меньше \d+/); assert.doesNotMatch(calls[0].prompt, /base\.json/);
  const text = fs.readFileSync(path.join(r.workDir, 'data.json'), 'utf8'); const d = JSON.parse(text);
  assert.ok(!text.includes('\n')); for (const k of ['html', 'keyboard', 'need', 'next', 'running', 'planning']) assert.ok(!(k in d), k);
  const seen = []; const run = async (o) => { seen.push(o); return { exitCode: 0, stdout: `${JSON.stringify({ type: 'result', is_error: false, result: 'ок', session_id: 'abc' })}\n`, stderr: '', timedOut: false }; };
  const a = await runAgent(cfg, { agent: 'mcfly:director', prompt: 'п', cwd: '/tmp/x', timeoutMs: 1, run, resume: 'abc' });
  assert.equal(a.sessionId, 'abc'); assert.equal(seen[0].args[seen[0].args.indexOf('--resume') + 1], 'abc'); assert.equal(seen[0].args.at(-1), 'п');
});

test('0.15.4 учёт: цена продолженной сессии считается приростом, а не нарастающим итогом', async () => {
  const s = setup(); const u = (cost) => ({ input: 1, cache_write: 0, cache_read: 0, output: 1, turns: 1, cost_usd: cost });
  const sc = scripted([(cwd) => { writes(BAD)(cwd); return { sessionId: 'S1', usage: u(0.10) }; }, (cwd) => { writes(GOOD)(cwd); return { sessionId: 'S1', usage: u(0.13) }; }]);
  const r = await direct(s, 'on', sc.agent);
  assert.equal(r.usage.cost_usd, 0.13); // 0.10 + прирост 0.03, а не 0.23
});

test('0.15.4 экономия: зритель работает на лёгкой модели из video.viewer_model, режиссёр — на модели роли', async () => {
  const s = setup(); const { agent, calls } = scripted([writes(GOOD), says('[]')]);
  await direct(s, 'review', agent);
  assert.deepEqual(calls.map((c) => c.model), ['', 'claude-haiku-5-5']);
  const s2 = setup({ viewer_model: '' }); const sc = scripted([writes(GOOD), says('[]')]);
  await direct(s2, 'review', sc.agent);
  assert.deepEqual(sc.calls.map((c) => c.model), ['', '']);
  assert.throws(() => parseConfig('project: demo\nvideo:\n  viewer_model: "a b"'), /video\.viewer_model/);
});

test('0.15.4 данные режиссёру: при списке сделанного пересказы последних прогонов не передаются; без списка — остаются', async () => {
  const s = setup();
  let r = await directScenes(s.p, s.c, { data: { ...DATA, done: [{ title: 'Повторы', benefit: 'п', visible: true, sample: { text: SAMPLE.text, buttons: SAMPLE.buttons } }] }, baseScenes: BASE, now: NOW, mode: 'on', vp: s.vp, agent: scripted([writes(GOOD)]).agent, stills });
  assert.ok(!('plain' in JSON.parse(fs.readFileSync(path.join(r.workDir, 'data.json'), 'utf8'))));
  r = await directScenes(s.p, s.c, { data: { ...DATA, done: [] }, baseScenes: BASE, now: new Date(NOW.getTime() + 1000), mode: 'on', vp: s.vp, agent: scripted([writes(GOOD)]).agent, stills });
  assert.equal(JSON.parse(fs.readFileSync(path.join(r.workDir, 'data.json'), 'utf8')).plain.length, 1);
});
