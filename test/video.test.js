import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs'; import path from 'node:path';
import { summaryScenes, videoPaths, videoProblems, buildVideo, sendSummaryVideo, pruneVideos, runTool } from '../src/video.js';
import { summaryData, sendSummary } from '../src/summary.js';
import { parseConfig } from '../src/config.js';
import { createTelegram } from '../src/telegram.js';
import { doctor } from '../src/doctor.js';
import { paths, loadState } from '../src/state.js';
import { appendMetric } from '../src/metrics.js';
import { cfg, bareProject, tmpDir } from './helpers.js';

const NOW = new Date(2026, 10, 16, 8, 0);
const DATA = {
  need: ['Одобрить <b>План 2</b>: кнопка «Отменить» под ответом бота (авто-одобрение 17.11 04:00)', 'Вопрос <b>Q4</b>: хранить ли историю дольше 30 дней'],
  plain: [{ slot: '04:00', text: 'Что сделано: Бот отвечает на правку одной фразой. Версия 1.4.0 лежит в ветке main.\nЗачем: Так быстрее.\nЧто дальше: Напоминания.' }],
  runStats: { ok: 2, missed: 1 }, running: false, changes: [], next: 'команда возьмёт «Напоминания» — задач 0 из 6',
};

/** Установленное окружение роликов в подставной папке. */
function fakeHome() {
  const home = tmpDir('video-home-');
  const vp = videoPaths({ ...cfg, video: { ...cfg.video, python: path.join(home, 'python'), model: path.join(home, 'model.pt') } }, { home });
  fs.mkdirSync(path.dirname(vp.cli), { recursive: true });
  for (const f of [vp.cli, vp.python, vp.model]) fs.writeFileSync(f, '');
  return vp;
}
/** Подставной запуск: «озвучка» пишет длительности, «сборка» — файл ролика. */
const fakeRun = (calls = []) => async (bin, args, opts) => {
  calls.push({ bin, args, opts });
  if (opts.label === 'озвучка') fs.writeFileSync(args[4], JSON.stringify(Object.fromEntries(Object.keys(JSON.parse(fs.readFileSync(args[2], 'utf8'))).map((k) => [k, 2]))));
  else fs.writeFileSync(args[4], 'mp4');
};

test('summaryScenes: сцены по сводке; диктору — только русские слова, на экране текст как в сводке', () => {
  const scenes = summaryScenes(DATA, cfg, { now: NOW });
  assert.deepEqual(scenes.map((s) => s.title), ['demo', 'Нужно от вас: 2', '3 прогона', 'Что сделано', 'Что дальше']);
  assert.deepEqual(scenes.map((s) => s.key), ['s0', 's1', 's2', 's3', 's4']);
  for (const s of scenes) assert.doesNotMatch(s.speech, /[0-9A-Za-z<>]/, s.speech);
  assert.match(scenes[0].speech, /Сводка по проекту демо от шестнадцатого ноября/);
  assert.match(scenes[1].speech, /От вас нужно: два пункта\. Первый: Одобрить План два/);
  assert.match(scenes[1].speech, /Остальное — на экране и в сообщении\.$/);
  assert.equal(scenes[1].lines[1], '2. Вопрос Q4: хранить ли историю дольше 30 дней');
  assert.match(scenes[2].speech, /Было три прогона: успешно — два, пропущено — один\./);
  assert.match(scenes[3].speech, /Версия один точка четыре точка ноль лежит в ветке мэйн/);
  assert.doesNotMatch(scenes[3].speech, /Так быстрее/); // в ролик идёт только «Что сделано»
  assert.match(scenes[4].speech, /задач ноль из шести\. Хорошего дня\.$/);
});

test('summaryScenes: перечень номеров и отсылку к кнопке диктор не читает', () => {
  const scenes = summaryScenes({ ...DATA, need: ['Решить по предложениям: I14, I15, I16 и ещё 7 — кнопка «💡 Предложения»'] }, cfg, { now: NOW });
  assert.match(scenes[1].speech, /Вот он: Решить по предложениям: несколько пунктов\.$/);
  assert.match(scenes[1].lines[0], /I14, I15, I16 и ещё 7/); // на экране — как в сводке
});

test('summaryScenes: пустая ночь — без сцены «Что сделано»; словарь проекта правит произношение', () => {
  const scenes = summaryScenes({ need: [], plain: [], runStats: {}, running: false, changes: [], next: 'работы нет' }, { ...cfg, project: 'acme', video: { ...cfg.video, pronounce: { acme: '+акме' } } }, { now: NOW });
  assert.deepEqual(scenes.map((s) => s.title), ['acme', 'От вас ничего не нужно', 'Прогонов не было', 'Что дальше']);
  assert.match(scenes[0].speech, /проекту \+акме от/);
});

test('summaryScenes: длинный пересказ укладывается в video.max_seconds', () => {
  const long = `Что сделано: ${'Команда сделала ещё одну полезную вещь для владельца. '.repeat(40)}`;
  const scenes = summaryScenes({ ...DATA, plain: [{ slot: '04:00', text: long }] }, { ...cfg, video: { ...cfg.video, max_seconds: 30 } }, { now: NOW });
  assert.ok(scenes.reduce((n, s) => n + s.speech.length, 0) <= 30 * 14 + 200);
  assert.ok(scenes[3].lines[0].length <= 331);
});

test('summaryData отдаёт те же данные, что в тексте сводки', () => {
  const p = paths(bareProject());
  appendMetric(p, { type: 'run', mode: 'night', id: '20261116-0400', slot: '04:00', started_at: new Date(2026, 10, 16, 4, 0).toISOString(), status: 'ok', duration_ms: 600_000 });
  fs.mkdirSync(path.join(p.runs, '20261116-0400'), { recursive: true });
  fs.writeFileSync(path.join(p.runs, '20261116-0400', 'summary.md'), '# Прогон\n## Простыми словами\nЧто сделано: починили вход.\n## Нужно от человека\n- проверить вход с телефона\n');
  const d = summaryData(p, cfg, { now: NOW, since: new Date(2026, 10, 15, 8, 0) });
  assert.match(d.html, /Нужно от вас \(1\)/);
  assert.deepEqual(d.need, ['проверить вход с телефона']);
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
  assert.deepEqual(calls.map((c) => c.opts.label), ['озвучка', 'сборка ролика']);
  assert.equal(calls[0].args[0], '-I'); // питон без подхвата модулей из текущей папки
  assert.equal(calls[0].args[5], 'eugene');
  assert.ok(calls[1].args.some((a) => a.startsWith('--props=')));
  assert.ok(!fs.existsSync(path.dirname(calls[0].args[2])), 'временная папка убрана');
  assert.ok(fs.existsSync(path.join(vp.app, 'src', 'Summary.jsx')), 'шаблон ролика скопирован из комплекта');
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
  const r = await sendSummaryVideo(p, { ...cfg, telegram: { ...cfg.telegram, chat_id: '7' } }, { data: DATA, tg, now: NOW, replyTo: 42, log: () => {}, build: async () => ({ file: '/tmp/x/summary.mp4', seconds: 57 }) });
  assert.equal(r.sent, true);
  assert.equal(sent[0].chat, '7');
  assert.equal(sent[0].opts.replyTo, 42);
  assert.equal(sent[0].opts.caption, '🎬 Сводка за 16.11 · 0:57');
});

test('sendSummaryVideo: сбой сборки не бросает исключение; строка в чат — один раз в сутки', async () => {
  const p = paths(bareProject()); const msgs = []; const logs = [];
  const tg = { sendVideo: async () => {}, sendMessage: async (_c, t) => { msgs.push(t); } };
  const opts = { data: DATA, tg, now: NOW, log: (s) => logs.push(s), build: async () => { throw new Error('сборка ролика: не уложилось в 600 с'); } };
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
  fs.writeFileSync(path.join(dir, 'mcfly', 'config.yaml'), 'project: demo\nvideo:\n  enabled: true\n  python: /нет/python\n  model: /нет/model.pt\n');
  const checks = doctor({ projectDir: dir, log: () => {}, power: null });
  assert.ok(checks.some((c) => !c.ok && /ролик-сводка: нет окружения озвучки/.test(c.label) && /mcfly video setup/.test(c.hint)));
});
