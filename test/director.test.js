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
  assert.match(role, /^name: director$/m); assert.match(role, /^tools: Read, Write, Glob$/m); assert.doesNotMatch(role, /"kind"/);
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
  let s = setup(); let r = await direct(s, 'review', scripted([writes(GOOD), fact, writes(BAD)]).agent);
  assert.equal(r.source, 'director'); assert.deepEqual(r.scenes.map((x) => x.title), [GOOD[0].title, GOOD[1].title, GOOD[3].title]);
  s = setup(); r = await direct(s, 'review', scripted([writes(GOOD), fact, () => ({ ok: false, reason: 'quota: лимит' })]).agent);
  assert.equal(r.source, 'director'); assert.equal(r.scenes.length, 3);
  s = setup(); r = await direct(s, 'review', scripted([writes(GOOD), () => { throw new Error('зритель упал'); }]).agent);
  assert.equal(r.source, 'director'); assert.equal(r.scenes.length, 4);
  s = setup(); r = await direct(s, 'review', scripted([writes(GOOD)]).agent, { stills: async () => { throw new Error('кадры не собрались'); } });
  assert.equal(r.source, 'director'); assert.equal(r.scenes.length, 4);
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
  assert.deepEqual(ok, { ok: true, text: '[]', reason: '' });
  assert.equal(seen[0].cwd, '/tmp/x'); assert.equal(seen[0].timeoutMs, 1000); assert.equal(seen[0].args.at(-1), 'задание');
  assert.ok(seen[0].args.join(' ').includes(`--plugin-dir ${MCFLY_ROOT} --agent mcfly:director`)); assert.ok(seen[0].args.join(' ').includes('--permission-mode acceptEdits'));
  const late = await runAgent(cfg, { agent: 'mcfly:user', prompt: 'п', cwd: '/tmp/x', timeoutMs: 1, run: async () => ({ exitCode: null, stdout: '', stderr: '', timedOut: true }) });
  assert.equal(late.ok, false); assert.match(late.reason, /^timeout/);
  const none = await runAgent(cfg, { agent: 'mcfly:user', prompt: 'п', cwd: '/tmp/x', timeoutMs: 1, run: async () => ({ exitCode: -1, stdout: '', stderr: 'Error: spawn claude ENOENT', timedOut: false }) });
  assert.equal(none.ok, false); assert.match(none.reason, /ENOENT/);
});
