import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs'; import path from 'node:path';
import { makeSummaryVideo, projectSlug, summaryScenes, videoPaths, videoProblems, buildVideo, renderStills, sendSummaryVideo, pruneVideos, runTool } from '../src/video.js';
import { summaryData, sendSummary } from '../src/summary.js';
import { parseConfig } from '../src/config.js';
import { createTelegram } from '../src/telegram.js';
import { doctor } from '../src/doctor.js';
import { paths, loadState } from '../src/state.js';
import { appendMetric } from '../src/metrics.js';
import { cfg, bareProject, tmpDir } from './helpers.js';

const NOW = new Date(2026, 10, 16, 8, 0);
const SAMPLE = { change: 'I22 «Кнопка «Вернуть»»', title: 'Ты нажал «Убрать 2»', text: 'Твои повторы:\n1. Зарядка — каждый день', buttons: [['Убрать 1', 'Вернуть']] };
const DATA = {
  need: ['Одобрить <b>План 2</b>: кнопка «Отменить» (авто-одобрение 17.11 04:00)', 'Решить по предложениям: I14, I15 и ещё 7 — кнопка «💡 Предложения»', 'вписать адрес календаря в settings.env на сервере'],
  todo: ['одобрить restore-removed-repeat', 'вписать адрес календаря в settings.env на сервере', 'нажать кнопку «Готово» в боте', 'запустить скрипт переноса базы'],
  plain: [
    { slot: '00:00', text: 'Что сделано: Бот показывает встречи из Google Календаря.\nЗачем: Чтобы план дня был полным.\nЧто дальше: Напоминания.' },
    { slot: '04:00', text: 'Что сделано: бот отвечает на правку одной фразой, пункт I22 закрыт. Версия 1.4.0 лежит в ветке main.\nЗачем: Так быстрее.\nЧто дальше: Напоминания.' },
  ],
  runStats: { ok: 2 }, running: false, changes: [], next: 'команда продолжит I22 (сделано 0 из 6 шагов)',
  work: [{ title: 'I22 «Напоминания за 15 минут»', progress: 'сделано 0 из 6 шагов' }], planning: false, demos: [SAMPLE],
};
/** Без режиссёра: сцены из кода, настоящий claude в тестах не запускается. */
const noDirector = async (_p, _c, o) => ({ scenes: o.baseScenes, source: 'fallback', reason: '', workDir: null });
const all = (scenes) => scenes.map((s) => [s.title, ...s.lines, s.speech].join(' ')).join(' ');

/** Установленное окружение роликов в подставной папке. */
function fakeHome() {
  const home = tmpDir('video-home-');
  const vp = { ...videoPaths(cfg, { home }), python: path.join(home, 'python'), model: path.join(home, 'model.pt') };
  fs.mkdirSync(path.dirname(vp.cli), { recursive: true });
  for (const f of [vp.cli, vp.python, vp.model]) fs.writeFileSync(f, '');
  return vp;
}
/** Подставной запуск: «озвучка» пишет длительности, «сборка» — файл ролика. */
const fakeRun = (calls = []) => async (bin, args, opts) => {
  const call = { bin, args, opts }; calls.push(call);
  if (opts.label === 'озвучка') fs.writeFileSync(args[4], JSON.stringify(Object.fromEntries(Object.keys(JSON.parse(fs.readFileSync(args[2], 'utf8'))).map((k) => [k, 2]))));
  else if (args[1] === 'still') fs.writeFileSync(args[4], 'png');
  else if (opts.label === 'сборка ролика') { call.props = JSON.parse(fs.readFileSync(args.find((a) => a.startsWith('--props=')).slice(8), 'utf8')); fs.writeFileSync(args[4], 'mp4'); }
};
/** Свойства, с которыми собран ролик из этих сцен. */
async function builtProps(scenes, video = {}) {
  const calls = [];
  await buildVideo({ ...cfg, video: { ...cfg.video, ...video } }, { scenes, name: 'props-test', now: NOW, run: fakeRun(calls), vp: fakeHome() });
  return calls.find((c) => c.props).props;
}

test('summaryScenes: главное — что сделано и как это выглядит; диктору — только русские слова', () => {
  const scenes = summaryScenes(DATA, cfg, { now: NOW });
  assert.deepEqual(scenes.map((s) => s.title), ['demo', 'Нужно от вас', 'Что сделано', 'Что сделано', 'Как это выглядит', 'Что дальше']);
  assert.deepEqual(scenes.map((s) => s.key), ['s0', 's1', 's2', 's3', 's4', 's5']);
  for (const s of scenes) assert.doesNotMatch(s.speech, /[0-9A-Za-z<>]/, s.speech);
  // прогоны без сбоев — одной строкой на заставке, вслух о них ни слова
  assert.deepEqual(scenes[0].lines, ['Утренняя сводка', '16 ноября', '✅ 2 прогона — все успешно']);
  assert.equal(scenes[0].speech, 'Доброе утро. Утренняя сводка.'); // название латиницей без словаря не читается
  assert.equal(scenes[2].speech, 'Бот показывает встречи из гугл Календаря. Чтобы план дня был полным.');
  assert.deepEqual(scenes[2].lines, ['Бот показывает встречи из Google Календаря.', 'Зачем: Чтобы план дня был полным.']);
  assert.match(scenes[3].speech, /^Бот отвечает на правку одной фразой, пункт закрыт\. Версия один точка четыре точка ноль лежит в ветке\./);
  assert.equal(scenes[5].speech, 'Команда продолжит: Напоминания за пятнадцать минут — сделано ноль из шести шагов. Хорошего дня.');
  assert.deepEqual(scenes[5].lines, ['Напоминания за 15 минут — сделано 0 из 6 шагов']);
});

test('заголовки диктор не читает', () => {
  for (const s of summaryScenes(DATA, cfg, { now: NOW })) assert.doesNotMatch(s.speech, /^(Что сделано|Что дальше|Дальше|Нужно от вас|Нужно сделать)[.:]/, s.speech);
});

test('дела владельца — только то, что делается вне бота; одобрения и кнопки в ролик не идут', () => {
  const scenes = summaryScenes(DATA, cfg, { now: NOW });
  assert.deepEqual(scenes[1].lines, ['1. вписать адрес календаря в settings.env на сервере', '2. запустить скрипт переноса базы']);
  assert.equal(scenes[1].speech, 'От вас нужно: вписать адрес календаря в на сервере. И ещё одно дело — на экране.');
  assert.doesNotMatch(all(scenes), /одобр|Решить по предложениям|кнопку «Готово»|I14|I22/i);
  const none = summaryScenes({ ...DATA, todo: ['одобрить restore-removed-repeat', 'ответить на вопрос в Telegram'] }, cfg, { now: NOW });
  assert.ok(!none.some((s) => s.title === 'Нужно от вас'));
});

test('прогоны: отдельной сценой и вслух — только когда что-то не удалось', () => {
  const bad = summaryScenes({ ...DATA, runStats: { ok: 2, error: 1, missed: 2 } }, cfg, { now: NOW });
  assert.equal(bad[1].title, 'Требует внимания');
  assert.deepEqual(bad[1].lines, ['❌ сбой — 1', '⚠️ пропущено — 2', '✅ успешно — 2']);
  assert.equal(bad[1].speech, 'Не все прогоны прошли гладко: сорвалось из за сбоя — один, пропущено — два.');
  assert.deepEqual(bad[0].lines, ['Утренняя сводка', '16 ноября']);
  assert.ok(!summaryScenes(DATA, cfg, { now: NOW }).some((s) => s.title === 'Требует внимания'));
});

test('демонстрация: образец изменения — сцена-чат с текстом и кнопками; держится, пока успеешь прочитать', () => {
  const demo = summaryScenes(DATA, cfg, { now: NOW })[4];
  assert.equal(demo.kind, 'chat');
  assert.deepEqual(demo.chat, { text: SAMPLE.text, buttons: [['Убрать 1', 'Вернуть']] });
  assert.deepEqual(demo.lines, ['Ты нажал «Убрать 2»']);
  assert.equal(demo.speech, 'Вот пример. Ты нажал «Убрать два».');
  assert.ok(demo.hold >= 3.5);
  // два изменения — по главному образцу от каждого; одно — два его первых образца
  const two = summaryScenes({ ...DATA, demos: [SAMPLE, { ...SAMPLE, title: 'второй' }, { ...SAMPLE, change: 'другое', title: 'из другого' }] }, cfg, { now: NOW }).filter((s) => s.kind === 'chat');
  assert.deepEqual(two.map((s) => s.lines[0]), ['Ты нажал «Убрать 2»', 'из другого']);
  assert.equal(two[1].speech, 'И ещё пример. Из другого.');
  const one = summaryScenes({ ...DATA, demos: [SAMPLE, { ...SAMPLE, title: 'второй' }, { ...SAMPLE, title: 'третий' }] }, cfg, { now: NOW }).filter((s) => s.kind === 'chat');
  assert.deepEqual(one.map((s) => s.lines[0]), ['Ты нажал «Убрать 2»', 'второй']);
});

test('пустая ночь и словарь проекта', () => {
  const scenes = summaryScenes({ need: [], todo: [], plain: [], runStats: {}, running: false, changes: [], next: 'работы нет — одобрите План 2', work: [], planning: false, demos: [] }, { ...cfg, project: 'acme', video: { ...cfg.video, pronounce: { acme: '+акме' } } }, { now: NOW });
  assert.deepEqual(scenes.map((s) => s.title), ['acme', 'Что дальше']);
  assert.equal(scenes[0].speech, 'Доброе утро. Сводка по проекту +акме.');
  assert.deepEqual(scenes[0].lines, ['Утренняя сводка', '16 ноября', 'Прогонов не было']);
  assert.equal(scenes[1].speech, 'Работы в очереди у команды нет. Хорошего дня.');
  assert.match(summaryScenes({ ...DATA, work: [], planning: true }, cfg, { now: NOW }).at(-1).speech, /Команда составит план по взятым предложениям/);
});

test('длинные пересказы укладываются в video.max_seconds', () => {
  const long = `Что сделано: ${'Команда сделала ещё одну полезную вещь для владельца. '.repeat(40)}`;
  const scenes = summaryScenes({ ...DATA, plain: [{ slot: '00:00', text: long }, { slot: '04:00', text: long }] }, { ...cfg, video: { ...cfg.video, max_seconds: 30 } }, { now: NOW });
  assert.ok(scenes.reduce((n, s) => n + s.speech.length, 0) <= 30 * 14 + 250);
  assert.ok(scenes.filter((s) => s.title === 'Что сделано').every((s) => s.lines[0].length <= 301));
});

test('summaryData отдаёт те же данные, что в тексте сводки', () => {
  const p = paths(bareProject());
  appendMetric(p, { type: 'run', mode: 'night', id: '20261116-0400', slot: '04:00', started_at: new Date(2026, 10, 16, 4, 0).toISOString(), status: 'ok', duration_ms: 600_000 });
  fs.mkdirSync(path.join(p.runs, '20261116-0400'), { recursive: true });
  fs.writeFileSync(path.join(p.runs, '20261116-0400', 'summary.md'), '# Прогон\n## Простыми словами\nЧто сделано: починили вход.\n## Нужно от человека\n- проверить вход с телефона\n');
  const d = summaryData(p, cfg, { now: NOW, since: new Date(2026, 10, 15, 8, 0) });
  assert.match(d.html, /Нужно от вас \(1\)/);
  assert.deepEqual(d.need, ['проверить вход с телефона']);
  assert.deepEqual(d.todo, ['проверить вход с телефона']);
  assert.deepEqual(d.work, []);
  assert.deepEqual(d.demos, []);
  assert.deepEqual(d.plain, [{ slot: '04:00', text: 'Что сделано: починили вход.' }]);
  assert.equal(d.runStats.ok, 1);
  assert.ok(d.next);
});

test('videoProblems: чего не хватает и подсказка mcfly video setup', () => {
  const empty = videoPaths(cfg, { home: tmpDir('video-empty-') });
  const missing = videoProblems(cfg, { ...empty, python: path.join(empty.home, 'нет'), model: path.join(empty.home, 'нет.pt') });
  assert.equal(missing.length, 3);
  assert.ok(missing.every((m) => /mcfly video setup/.test(m.hint)));
  assert.deepEqual(videoProblems(cfg, fakeHome()), []);
});

test('buildVideo: озвучка → длительности → сборка; рабочая папка удаляется', async () => {
  const vp = fakeHome(); const calls = [];
  const scenes = summaryScenes(DATA, cfg, { now: NOW });
  const r = await buildVideo(cfg, { scenes, name: 'summary-test', now: NOW, run: fakeRun(calls), vp });
  assert.equal(r.file, path.join(vp.out, 'summary-test.mp4'));
  assert.ok(fs.existsSync(r.file));
  assert.ok(r.seconds >= 10);
  assert.deepEqual(calls.map((c) => c.opts.label), ['озвучка', 'ускорение голоса', 'сборка ролика']);
  assert.ok(calls[1].args.includes('atempo=1.1'));
  assert.equal(calls[0].args[0], '-I'); // питон без подхвата модулей из текущей папки
  assert.equal(calls[0].args[5], 'eugene');
  assert.ok(calls[2].args.some((a) => a.startsWith('--props=')));
  assert.ok(!fs.existsSync(path.dirname(calls[0].args[2])), 'временная папка убрана');
  assert.ok(fs.existsSync(path.join(vp.app, 'src', 'Daily.jsx')), 'шаблон ролика скопирован из комплекта');
});

test('buildVideo: нет окружения — понятная ошибка, ничего не запускается', async () => {
  const calls = [];
  const vp = { ...videoPaths(cfg, { home: tmpDir('video-empty-') }), python: '/нет/python', model: '/нет/model.pt' };
  await assert.rejects(buildVideo(cfg, { scenes: [], name: 'x', run: fakeRun(calls), vp }), /mcfly video setup/);
  assert.equal(calls.length, 0);
});

test('runTool: по истечении времени процесс убивается, ошибка называет шаг', async () => {
  await assert.rejects(runTool('sleep', ['5'], { cwd: tmpDir(), timeoutMs: 150, label: 'сборка ролика' }), /сборка ролика: не уложилось/);
  await assert.rejects(runTool('sh', ['-c', 'echo плохо >&2; exit 3'], { cwd: tmpDir(), timeoutMs: 5000, label: 'озвучка' }), /озвучка: код 3 — плохо/);
});

test('sendSummaryVideo: ролик уходит ответом на сводку с подписью', async () => {
  const p = paths(bareProject()); const sent = [];
  const tg = { sendVideo: async (chat, file, opts) => { sent.push({ chat, file, opts }); }, sendMessage: async () => assert.fail('сообщений о сбое быть не должно') };
  const r = await sendSummaryVideo(p, { ...cfg, telegram: { ...cfg.telegram, chat_id: '7' } }, { data: DATA, tg, now: NOW, replyTo: 42, log: () => {}, direct: noDirector, build: async () => ({ file: '/tmp/x/summary.mp4', seconds: 57 }) });
  assert.equal(r.sent, true);
  assert.equal(sent[0].chat, '7');
  assert.equal(sent[0].opts.replyTo, 42);
  assert.equal(sent[0].opts.caption, '🎬 Сводка за 16.11 · 0:57');
});

test('sendSummaryVideo: сбой сборки не бросает исключение; строка в чат — один раз в сутки', async () => {
  const p = paths(bareProject()); const msgs = []; const logs = [];
  const tg = { sendVideo: async () => {}, sendMessage: async (_c, t) => { msgs.push(t); } };
  const opts = { data: DATA, tg, now: NOW, log: (s) => logs.push(s), direct: noDirector, build: async () => { throw new Error('сборка ролика: не уложилось в 600 с'); } };
  const c = { ...cfg, telegram: { ...cfg.telegram, chat_id: '7' } };
  assert.deepEqual(await sendSummaryVideo(p, c, opts), { sent: false, error: 'сборка ролика: не уложилось в 600 с' });
  await sendSummaryVideo(p, c, opts);
  assert.equal(msgs.length, 1);
  assert.match(msgs[0], /Ролик сводки не собрался: сборка ролика: не уложилось в 600 с\. Текст сводки выше — полный/);
  assert.equal(loadState(p).video_failed_on, '2026-11-16');
  await sendSummaryVideo(p, c, { ...opts, now: new Date(2026, 10, 17, 8, 0) });
  assert.equal(msgs.length, 2, 'на следующий день — снова');
});

test('sendSummary: текст уходит первым, ролик — после и только при video.enabled', async () => {
  const order = [];
  const tg = { sendMessage: async () => { order.push('текст'); return [{ message_id: 5 }]; } };
  const video = async (_p, _c, o) => { order.push(`ролик → ответ на ${o.replyTo}`); return { sent: true }; };
  process.env.TOK = 'x';
  const tcfg = { ...cfg, telegram: { chat_id: '1', token_env: 'TOK' } };
  const off = await sendSummary(paths(bareProject()), tcfg, { telegram: tg, now: NOW, log: () => {}, video });
  assert.deepEqual(order, ['текст']); assert.equal(off.video, null);
  const p = paths(bareProject());
  const on = await sendSummary(p, { ...tcfg, video: { ...cfg.video, enabled: true } }, { telegram: tg, now: NOW, log: () => {}, video });
  assert.deepEqual(order, ['текст', 'текст', 'ролик → ответ на 5']);
  assert.equal(on.sent, true);
  assert.ok(loadState(p).last_summary_at, 'сводка отмечена отправленной до ролика');
});

test('telegram.sendVideo: файл и поля уходят формой; большой файл и отказ — понятные ошибки', async () => {
  const file = path.join(tmpDir(), 'clip.mp4'); fs.writeFileSync(file, 'video-bytes');
  let req = null;
  const tg = createTelegram({ token: 'T', fetchImpl: async (url, init) => { req = { url, init }; return { status: 200, json: async () => ({ ok: true, result: { message_id: 9 } }) }; } });
  const r = await tg.sendVideo('7', file, { caption: 'подпись', replyTo: 42, duration: 57, width: 1080, height: 1920 });
  assert.equal(r.message_id, 9);
  assert.match(req.url, /botT\/sendVideo$/);
  const form = req.init.body;
  assert.equal(form.get('chat_id'), '7'); assert.equal(form.get('caption'), 'подпись'); assert.equal(form.get('duration'), '57');
  assert.deepEqual(JSON.parse(form.get('reply_parameters')), { message_id: 42, allow_sending_without_reply: true });
  assert.equal(form.get('video').name, 'clip.mp4');
  assert.equal(await form.get('video').text(), 'video-bytes');
  const bad = createTelegram({ token: 'T', fetchImpl: async () => ({ status: 400, json: async () => ({ ok: false, description: 'Bad Request: file is too big' }) }) });
  await assert.rejects(bad.sendVideo('7', file), /sendVideo: Bad Request: file is too big/);
});

test('безопасность: имя проекта не выводит из папки роликов, пути к питону и модели из настроек не берутся', () => {
  const home = tmpDir('video-home-');
  for (const name of ['../../etc', '..', '/abs/path', 'a/../../b', '.ssh']) {
    const out = videoPaths({ ...cfg, project: name }, { home }).out;
    assert.equal(path.dirname(out), path.join(home, 'out'), name);
    assert.doesNotMatch(path.basename(out), /^\.|\//, name);
  }
  assert.equal(projectSlug('demo.v2'), 'demo-v2');
  assert.equal(projectSlug('..'), 'project');
  const vp = videoPaths({ ...cfg, video: { ...cfg.video, python: '/tmp/evil', model: '/tmp/evil.pt' } }, { home });
  assert.ok(!vp.python.includes('evil') && !vp.model.includes('evil'));
});

test('pruneVideos оставляет последние ролики', () => {
  const dir = tmpDir();
  for (const n of ['summary-2026-11-10-0800', 'summary-2026-11-11-0800', 'summary-2026-11-12-0800']) fs.writeFileSync(path.join(dir, `${n}.mp4`), '');
  pruneVideos(dir, 2);
  assert.deepEqual(fs.readdirSync(dir).sort(), ['summary-2026-11-11-0800.mp4', 'summary-2026-11-12-0800.mp4']);
});

test('настройки video: по умолчанию выключено; ошибки называют поле', () => {
  assert.equal(parseConfig('project: demo\n').video.enabled, false);
  assert.equal(parseConfig('project: demo\nvideo:\n  enabled: true\n  pronounce:\n    acme: "+акме"\n').video.pronounce.acme, '+акме');
  assert.throws(() => parseConfig('project: demo\nvideo:\n  voice: bob\n'), /video\.voice/);
  assert.throws(() => parseConfig('project: demo\nvideo:\n  max_seconds: 5\n'), /video\.max_seconds/);
  assert.throws(() => parseConfig('project: demo\nvideo:\n  enabled: да\n'), /video\.enabled/);
});

test('doctor проверяет окружение ролика только при video.enabled', () => {
  const dir = bareProject();
  assert.ok(!doctor({ projectDir: dir, log: () => {}, power: null }).some((c) => /ролик-сводка/.test(c.label)));
  fs.writeFileSync(path.join(dir, 'mcfly', 'config.yaml'), 'project: demo\nvideo:\n  enabled: true\n');
  const empty = videoPaths(cfg, { home: tmpDir('video-empty-') });
  const checks = doctor({ projectDir: dir, log: () => {}, power: null, video: (c) => videoProblems(c, { ...empty, python: '/нет/python', model: '/нет/model.pt' }) });
  assert.ok(checks.some((c) => !c.ok && /ролик-сводка: нет окружения озвучки/.test(c.label) && /mcfly video setup/.test(c.hint)));
});

test('0.15.0 настройки: voice_speed по умолчанию 1.1; вне 0.9–1.3 — ошибка называет поле', () => {
  assert.equal(parseConfig('project: demo').video.voice_speed, 1.1);
  assert.throws(() => parseConfig('project: demo\nvideo:\n  voice_speed: 2'), /video\.voice_speed/);
});

test('0.15.0 темп: сцена режиссёра (hold 0) длится как речь; сцена из кода — не дольше речи плюс 2 с', async () => {
  const props = await builtProps([{ key: 's0', kind: 'text', title: 'а', lines: [], speech: 'р', hold: 0 }, { key: 's1', kind: 'chat', title: 'б', lines: [], speech: 'р', hold: 9, chat: { text: 'т', buttons: [] } }, { key: 's2', kind: 'text', title: 'в', lines: [], speech: 'р', hold: 3 }], { voice_speed: 1 });
  assert.deepEqual(props.scenes.map((s) => s.duration), [2, 4, 3]);
  assert.ok(props.scenes.every((s) => !('speech' in s) && !('hold' in s)));
});

test('0.15.0 скорость голоса: при 1.25 речь 2 с занимает 1.6 с; при 1 ускорение не запускается; поля оформления доходят до шаблона', async () => {
  const props = await builtProps([{ key: 's0', kind: 'hook', title: 'а', lines: [], speech: 'р', hold: 0, accent: '#ffb648', tag: 'Новое' }], { voice_speed: 1.25 });
  assert.equal(props.scenes[0].voice, 1.6); assert.equal(props.scenes[0].accent, '#ffb648'); assert.equal(props.scenes[0].tag, 'Новое');
  const calls = [];
  await buildVideo({ ...cfg, video: { ...cfg.video, voice_speed: 1 } }, { scenes: [{ key: 's0', kind: 'text', title: 'а', lines: [], speech: 'р', hold: 0 }], name: 'x', now: NOW, run: fakeRun(calls), vp: fakeHome() });
  assert.deepEqual(calls.map((c) => c.opts.label), ['озвучка', 'сборка ролика']);
});

test('0.15.0 запасные сцены: у образца чата речь о сути, фраз-пустышек нет', () => {
  const chats = summaryScenes(DATA, cfg, { now: NOW }).filter((s) => s.kind === 'chat');
  assert.ok(chats.length > 0);
  for (const s of chats) { assert.doesNotMatch(s.speech, /Вот как это выглядит|И ещё один пример/); assert.ok(s.speech.length >= 20); }
});

const TWO = [{ key: 's0', kind: 'hook', title: 'а', lines: [], speech: 'Первая сцена ролика.', hold: 0 }, { key: 's1', kind: 'finale', title: 'б', lines: [], speech: 'Вторая сцена.', hold: 0 }];

test('0.15.0 buildVideo: утренний ролик — оформление Daily, недельный — Weekly; возвращает размер файла', async () => {
  const calls = []; const vp = fakeHome();
  const r = await buildVideo(cfg, { scenes: TWO, name: 'a', run: fakeRun(calls), vp });
  const w = await buildVideo(cfg, { scenes: TWO, name: 'b', run: fakeRun(calls), vp, weekly: true });
  const renders = calls.filter((c) => c.opts.label === 'сборка ролика');
  assert.deepEqual(renders.map((c) => c.args[3]), ['Daily', 'Weekly']); assert.deepEqual(renders.map((c) => c.props.kind), ['Утренняя сводка', 'Итоги недели']);
  assert.equal(r.bytes, 3); assert.equal(w.bytes, 3); assert.ok(renders[0].args.includes('--crf=30'));
});

test('0.15.0 buildVideo: файл больше 45 МБ пересобирается сильнее сжатым', async () => {
  const calls = []; let n = 0;
  const run = async (bin, args, opts) => {
    if (opts.label !== 'сборка ролика') return fakeRun(calls)(bin, args, opts);
    calls.push({ bin, args, opts }); n += 1;
    fs.writeFileSync(args[4], Buffer.alloc(n === 1 ? 46 * 1024 * 1024 : 1024));
  };
  const r = await buildVideo(cfg, { scenes: TWO, name: 'big', run, vp: fakeHome() });
  const renders = calls.filter((c) => c.opts.label === 'сборка ролика');
  assert.equal(renders.length, 2); assert.ok(renders[1].args.includes('--crf=36') && renders[1].args.includes('--scale=0.75')); assert.equal(r.bytes, 1024);
});

test('0.15.0 buildVideo: свой предел времени (timeoutMs) вместо video.timeout_minutes', async () => {
  const calls = [];
  await buildVideo(cfg, { scenes: TWO, name: 't', run: fakeRun(calls), vp: fakeHome(), timeoutMs: 5 * 60_000 });
  assert.ok(calls.every((c) => c.opts.timeoutMs <= 5 * 60_000 && c.opts.timeoutMs > 4 * 60_000));
});

test('0.15.0 renderStills: кадр на сцену, без озвучки, в оформлении своего ролика', async () => {
  const calls = []; const dir = path.join(tmpDir('stills-'), 'stills');
  const files = await renderStills(cfg, { scenes: TWO, dir, weekly: true, run: fakeRun(calls), vp: fakeHome() });
  assert.deepEqual(files.map((f) => path.basename(f)), ['01.png', '02.png']); assert.ok(files.every((f) => fs.existsSync(f)));
  assert.ok(calls.every((c) => c.args[1] === 'still' && c.args[3] === 'Weekly')); assert.equal(calls.length, 2);
});

test('0.15.0 makeSummaryVideo: сцены режиссёра уходят в сборку; его время вычитается из общего предела', async () => {
  const p = paths(bareProject()); const built = []; let t = 0;
  const direct = async () => { t = 6 * 60_000; return { scenes: TWO, source: 'review', reason: '', workDir: '/w' }; };
  const r = await makeSummaryVideo(p, cfg, { data: DATA, now: NOW, name: 'n', direct, clock: () => t, build: async (_c, o) => { built.push(o); return { file: '/f.mp4', seconds: 9, bytes: 5 }; } });
  assert.deepEqual(r, { file: '/f.mp4', seconds: 9, bytes: 5, source: 'review', workDir: '/w' });
  assert.equal(built[0].scenes, TWO); assert.equal(built[0].timeoutMs, 9 * 60_000);
});

test('0.15.0 makeSummaryVideo: сборка сцен режиссёра упала — вторая сборка из запасных сцен со своими 5 минутами', async () => {
  const p = paths(bareProject()); const built = []; const logs = [];
  const direct = async () => ({ scenes: TWO, source: 'director', reason: '', workDir: '/w' });
  const build = async (_c, o) => { built.push(o); if (built.length === 1) throw new Error('сборка ролика: код 1'); return { file: '/f.mp4', seconds: 9, bytes: 5 }; };
  const r = await makeSummaryVideo(p, cfg, { data: DATA, now: NOW, name: 'n', direct, build, log: (l) => logs.push(l) });
  assert.equal(r.source, 'fallback'); assert.equal(built.length, 2); assert.equal(built[1].timeoutMs, 5 * 60_000);
  assert.deepEqual(built[1].scenes.map((s) => s.title), summaryScenes(DATA, cfg, { now: NOW }).map((s) => s.title)); assert.match(logs.join('\n'), /запасных сцен/);
});

test('0.15.0 makeSummaryVideo: упала и запасная сборка — исключение уходит наверх, sendSummaryVideo пишет одну строку', async () => {
  const p = paths(bareProject());
  await assert.rejects(makeSummaryVideo(p, cfg, { data: DATA, now: NOW, name: 'n', direct: noDirector, build: async () => { throw new Error('нет сборщика'); } }), /нет сборщика/);
});
