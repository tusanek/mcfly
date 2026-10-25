import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { run, finishMessage } from '../src/runner.js';
import { apiRetryWatch, parseResult } from '../src/claude.js';
import { pullAnswers } from '../src/pull.js';
import { enqueueNotice, flushNotices, noticesPath } from '../src/notices.js';
import { callbackText } from '../src/telegram.js';
import { sendSummary } from '../src/summary.js';
import { paths, saveState } from '../src/state.js';
import { listChanges } from '../src/approvals.js';
import { loadQuestions, addQuestion, saveQuestions } from '../src/questions.js';
import { cfg, bareProject, fakeClaudeSeq, addChange, tmpDir } from './helpers.js';

const resultEvent = (over = {}) => ({ type: 'result', subtype: 'success', is_error: false, num_turns: 1, total_cost_usd: 0.1, session_id: 's', result: 'готово', ...over });
const tgCfg = { ...cfg, telegram: { chat_id: '42', token_env: 'MCFLY_TEST_TG' } };
process.env.MCFLY_TEST_TG = 'T';
const msg = (id, text) => ({ update_id: id, message: { message_id: id, chat: { id: 42 }, text, date: 1700000000 } });
const pending = (name) => ({ schema: 'spec-driven', mcfly: { approval: 'pending', category: 'spec', requested_at: new Date().toISOString() } });
const approved = { schema: 'spec-driven', mcfly: { approval: 'approved' } };
function fakeTg(updates = [], { failSend = 0 } = {}) {
  const tg = { updates, sent: [], async getUpdates(offset) { return tg.updates.filter((u) => u.update_id >= offset); },
    async sendMessage(_chat, text, opts = {}) { if (failSend > 0) { failSend -= 1; throw new Error('fetch failed'); } tg.sent.push({ text, keyboard: opts.keyboard || [] }); return []; },
    async answerCallbackQuery() { return true; } };
  return tg;
}
const REPORT = `# Прогон r1
## Сделано
- \`site-rebuild-command\`: задачи 1.1–4.1 выполнены, слито в main
- 764 теста зелёные
## В работе
- нет
## Нужно от человека
- сверить Q2 с фронтом orbita
- одобрить \`add-y\`
`;
const record = (over = {}) => ({ id: 'r1', mode: 'day', slot: null, started_at: '2026-10-18T10:03:00.000Z', status: 'ok', turns: 20, cost_usd: 1.81, duration_ms: 8 * 60_000, ...over });

test('0.5.8: итог прогона — сделано, нужно от вас, что дальше и кнопки одобрения', () => {
  const dir = bareProject(); const p = paths(dir);
  fs.mkdirSync(path.join(p.runs, 'r1'), { recursive: true }); fs.writeFileSync(path.join(p.runs, 'r1', 'summary.md'), REPORT);
  addChange(dir, 'add-y', { meta: pending('add-y') });
  const m = finishMessage(cfg, record(), p);
  assert.match(m.text, /^✅ mcfly demo: прогон \d\d:\d\d завершён: ок/);
  assert.match(m.text, /Сделано:\n• site-rebuild-command: задачи 1\.1–4\.1 выполнены, слито в main\n• 764 теста зелёные/);
  assert.match(m.text, /Нужно от вас:\n• сверить Q2 с фронтом orbita/);
  assert.doesNotMatch(m.text, /одобрить add-y/, 'одобрение — кнопкой, не пунктом');
  assert.match(m.text, /Дальше: работы нет — одобрите add-y/);
  assert.deepEqual(m.keyboard.map((row) => row.map((b) => b.callback_data)), [['ap:add-y', 'rj:add-y']]);
});
test('0.5.8: итог прогона без отчёта и длинный отчёт — без пустых разделов, лишнее урезано со ссылкой', () => {
  const dir = bareProject(); const p = paths(dir);
  const bare = finishMessage(cfg, record(), p);
  assert.doesNotMatch(bare.text, /Сделано|Нужно от вас/); assert.match(bare.text, /Дальше: работы нет — одобрите изменение/);
  fs.mkdirSync(path.join(p.runs, 'r1'), { recursive: true });
  fs.writeFileSync(path.join(p.runs, 'r1', 'summary.md'), `# Прогон\n## Сделано\n${Array.from({ length: 9 }, (_, i) => `- пункт ${i} ${'x'.repeat(400)}`).join('\n')}\n`);
  const long = finishMessage(cfg, record(), p);
  const items = long.text.split('\n').filter((l) => l.startsWith('• '));
  assert.equal(items.length, 6); assert.match(items.at(-1), /… ещё 4 — mcfly\/runs\/r1\/summary\.md/);
  assert.ok(items.slice(0, 5).every((l) => l.length <= 222), 'пункт урезан');
  assert.match(finishMessage(cfg, record({ status: 'network', attempts: 2, error: 'ENOTFOUND' }), p).text, /^⚠️ .*нет доступа к API/);
});
test('0.5.8: итог не ушёл в Telegram — в очереди с кнопками, отправляется позже с пометкой', async () => {
  const dir = bareProject(); const p = paths(dir);
  addChange(dir, 'add-y', { meta: pending('add-y') });
  fakeClaudeSeq(dir, [{ lines: [resultEvent()] }]);
  const logs = [];
  const r = await run({ projectDir: dir, mode: 'day', log: (s) => logs.push(s), sleep: async () => {}, notify: async () => { throw new Error('fetch failed'); } });
  assert.equal(r.status, 'ok'); assert.ok(logs.some((s) => /поставлено в очередь/.test(s)));
  const queued = fs.readFileSync(noticesPath(p), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(queued.length, 1); assert.match(queued[0].text, /завершён: ок/); assert.equal(queued[0].keyboard[0][0].callback_data, 'ap:add-y');
  const sent = [];
  assert.equal(await flushNotices(p, async (t, kb) => { sent.push({ t, kb }); }), 1);
  assert.match(sent[0].t, /^🕓 Не дошло вовремя \(\d\d\.\d\d \d\d:\d\d\):\n✅ mcfly demo/); assert.equal(sent[0].kb[0][0].callback_data, 'ap:add-y');
  assert.equal(fs.existsSync(noticesPath(p)), false); assert.equal(await flushNotices(p, async () => {}), 0, 'очередь пуста');
});
test('0.5.8: очередь — сбой отправки оставляет хвост по порядку, устаревшее выбрасывается', async () => {
  const dir = bareProject(); const p = paths(dir); const now = new Date('2026-10-18T12:00:00Z');
  enqueueNotice(p, { text: 'старое' }, new Date('2026-10-15T12:00:00Z'));
  for (const t of ['a', 'b', 'c']) enqueueNotice(p, { text: t }, now);
  const sent = []; let n = 0;
  const send = async (t) => { if (++n === 2) throw new Error('fetch failed'); sent.push(t); };
  assert.equal(await flushNotices(p, send, { now }), 1);
  assert.deepEqual(sent.map((t) => t.split('\n')[1]), ['a']);
  assert.deepEqual(fs.readFileSync(noticesPath(p), 'utf8').trim().split('\n').map((l) => JSON.parse(l).text), ['b', 'c']);
  assert.equal(await flushNotices(p, async (t) => { sent.push(t); }, { now }), 2);
  assert.deepEqual(sent.map((t) => t.split('\n')[1]), ['a', 'b', 'c']);
});
test('0.5.8: тревога о неотправленной сводке не дошла — в очередь', async () => {
  const dir = bareProject(); const p = paths(dir);
  saveState(p, { last_summary_at: '2026-10-17T07:30:00Z' }); process.env.TOK = 'x';
  const tg = { sendMessage: async () => { throw new Error('fetch failed'); } };
  await assert.rejects(sendSummary(p, { ...cfg, telegram: { chat_id: '1', token_env: 'TOK' } }, { telegram: tg, log: () => {} }));
  assert.match(fs.readFileSync(noticesPath(p), 'utf8'), /сводка не отправлена/);
});

test('0.5.8: сторож api_retry — тишина после повторов, долгая серия; ответ модели сбрасывает серию', () => {
  let t = 0; const clock = () => t;
  const retry = JSON.stringify({ type: 'system', subtype: 'api_retry', attempt: 1, error: 'unknown' });
  const w = apiRetryWatch({ stallMs: 600_000, spanMs: 1_200_000, clock });
  assert.equal(w.check(), null, 'без повторов не срабатывает, даже в тишине');
  t = 2_000_000; assert.equal(w.check(), null);
  w.line(retry); t += 30_000; w.line(retry); t += 599_000; assert.equal(w.check(), null);
  t += 2_000; assert.match(w.check(), /2 повтор\(ов\) api_retry без ответа, потом тишина 10 мин/);
  const w2 = apiRetryWatch({ stallMs: 600_000, spanMs: 1_200_000, clock });
  w2.line(retry); for (let i = 0; i < 40; i++) { t += 30_000; w2.line(retry); }
  assert.match(w2.check(), /41 повтор\(ов\) api_retry без ответа за 20 мин/);
  w2.line(JSON.stringify({ type: 'assistant', message: { content: [] } })); assert.equal(w2.check(), null, 'модель ответила — серия сброшена');
  w2.line('не json'); w2.line(JSON.stringify({ type: 'system', subtype: 'init' })); t += 700_000; assert.equal(w2.check(), null);
});
test('0.5.8: прерванный сторожем прогон — статус network с причиной', () => {
  const r = parseResult({ exitCode: 143, stdout: '', stderr: '', timedOut: false, aborted: 'нет доступа к API: 3 повтор(ов)' });
  assert.equal(r.status, 'network'); assert.match(r.errorText, /3 повтор/);
  assert.equal(parseResult({ exitCode: 143, stdout: '', stderr: '', timedOut: true, aborted: 'x' }).status, 'timeout', 'лимит прогона важнее');
});
test('0.5.8: зависший claude прерывается сторожем, прогон повторяется и заканчивается network без ожидания лимита', async () => {
  const dir = bareProject(); const p = paths(dir);
  const bin = tmpDir('fake-claude-hang-'); const script = path.join(bin, 'claude.sh');
  fs.writeFileSync(script, `#!/bin/sh\nprintf '%s\\n' '{"type":"system","subtype":"api_retry","attempt":1,"error":"unknown"}'\nexec sleep 30\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(dir, 'mcfly', 'config.yaml'), `project: demo\nrun:\n  claude_bin: ${script}\n  max_minutes: 5\n  network_retries: 1\n  network_retry_minutes: 1\n`);
  const notes = []; const waits = []; const t0 = Date.now();
  const r = await run({ projectDir: dir, mode: 'day', log: () => {}, sleep: async (ms) => { waits.push(ms); }, notify: async (t) => { notes.push(t); }, apiWatch: { stallMs: 300, intervalMs: 50 } });
  assert.ok(Date.now() - t0 < 15_000, 'не ждал лимита прогона');
  assert.equal(r.status, 'network');
  const rec = JSON.parse(fs.readFileSync(path.join(p.runs, r.id, 'result.json'), 'utf8'));
  assert.equal(rec.attempts, 2); assert.deepEqual(waits, [60_000]);
  assert.match(fs.readFileSync(path.join(p.runs, r.id, 'events.log'), 'utf8'), /⛔ прерван: нет доступа к API: 1 повтор\(ов\) api_retry без ответа, потом тишина/);
  assert.match(notes[0], /нет доступа к API/);
});

test('0.5.8: «запусти» без работы, когда изменение ждёт одобрения — прогон не стартует, под ответом кнопки', async () => {
  const dir = bareProject(); const p = paths(dir);
  addChange(dir, 'add-y', { meta: pending('add-y') });
  const tg = fakeTg([msg(1, 'запусти')]); const started = [];
  await pullAnswers({ projectDir: dir, cfg: tgCfg, p, telegram: tg, log: () => {}, startRun: (d) => started.push(d) });
  assert.deepEqual(started, []);
  assert.match(tg.sent[0].text, /⏸ Прогон не запущен: работы нет, ждёт одобрения add-y/);
  assert.deepEqual(tg.sent[0].keyboard.map((row) => row[0].callback_data), ['ap:add-y']);
  const tg2 = fakeTg([msg(2, 'запусти всё равно')]);
  await pullAnswers({ projectDir: dir, cfg: tgCfg, p, telegram: tg2, log: () => {}, startRun: (d) => started.push(d) });
  assert.deepEqual(started, [dir]); assert.match(tg2.sent[0].text, /▶️ Запускаю/);
});
test('0.5.8: «запусти» без одобренных и без ждущих изменений — прогон стартует (планировщик может предложить новое)', async () => {
  const dir = bareProject(); const p = paths(dir);
  const tg = fakeTg([msg(1, 'запусти')]); const started = [];
  await pullAnswers({ projectDir: dir, cfg: tgCfg, p, telegram: tg, log: () => {}, startRun: (d) => started.push(d) });
  assert.deepEqual(started, [dir]);
});
test('0.5.8: одобрение кнопкой — ответ с кнопкой «Запустить»; одобрение и «запусти» в одной пачке — запуск без кнопки', async () => {
  const dir = bareProject(); const p = paths(dir);
  addChange(dir, 'add-y', { meta: pending('add-y') });
  const cb = { update_id: 1, callback_query: { id: 'c1', data: 'ap:add-y', message: { message_id: 1, chat: { id: 42 }, date: 1700000000 } } };
  const tg = fakeTg([cb]); const started = [];
  await pullAnswers({ projectDir: dir, cfg: tgCfg, p, telegram: tg, log: () => {}, startRun: (d) => started.push(d) });
  assert.match(tg.sent[0].text, /✅ одобрено: add-y/);
  assert.deepEqual(tg.sent[0].keyboard, [[{ text: '▶️ Запустить прогон', callback_data: 'rn:day' }]]);
  assert.equal(callbackText('rn:day'), 'запусти');
  addChange(dir, 'add-z', { meta: pending('add-z') });
  const tg2 = fakeTg([msg(2, 'approve add-z'), msg(3, 'запусти')]);
  await pullAnswers({ projectDir: dir, cfg: tgCfg, p, telegram: tg2, log: () => {}, startRun: (d) => started.push(d) });
  assert.deepEqual(started, [dir], 'одобренное в той же пачке — работа есть'); assert.deepEqual(tg2.sent[0].keyboard, []);
  assert.equal(listChanges(p.openspecChanges).find((c) => c.name === 'add-z').mcfly.approval, 'approved');
});
test('0.5.8: ответ не дошёл — в очередь; опрос задания answers досылает очередь, опрос прогона — нет', async () => {
  const dir = bareProject(); const p = paths(dir);
  const tg = fakeTg([msg(1, 'заметка для команды')], { failSend: 1 }); const logs = [];
  await pullAnswers({ projectDir: dir, cfg: tgCfg, p, telegram: tg, log: (s) => logs.push(s) });
  assert.ok(logs.some((s) => /поставлен в очередь/.test(s)));
  enqueueNotice(p, { text: 'итог прогона' });
  const tg2 = fakeTg();
  await pullAnswers({ projectDir: dir, cfg: tgCfg, p, telegram: tg2, log: () => {} });
  assert.equal(tg2.sent.length, 0, 'без flush очередь не трогается');
  await pullAnswers({ projectDir: dir, cfg: tgCfg, p, telegram: tg2, log: () => {}, flush: true });
  assert.deepEqual(tg2.sent.map((s) => s.text.split('\n').slice(1).join('\n')), ['📝 Записал как заметку для команды', 'итог прогона']);
});

test('0.5.9: итог прогона — текст вопросов с ответом по умолчанию и сроком, выдержка ждущих одобрения; решения важнее «Сделано»', () => {
  const dir = bareProject(); const p = paths(dir);
  const data = loadQuestions(p);
  addQuestion(data, { category: 'spec', text: 'Дата релиза при бэкфилле: дата обработки или resolvedAt?', defaultAnswer: 'Дата обработки' }, cfg);
  addQuestion(data, { category: 'prod', text: 'Выкатить на сервер?' }, cfg);
  saveQuestions(p, data);
  addChange(dir, 'add-y', { proposal: '# Proposal\n\n## Why\n\nORB-405 теряет факты: лимит целей 15.\n', meta: pending('add-y') });
  const m = finishMessage(cfg, record(), p);
  assert.match(m.text, /Решить:\n❓ Q1: Дата релиза при бэкфилле: дата обработки или resolvedAt\?\n   По умолчанию: Дата обработки \(примется \d\d\.\d\d \d\d:\d\d\)/);
  assert.match(m.text, /❓ Q2: Выкатить на сервер\?\n   Ответа по умолчанию нет — команда ждёт вас/);
  assert.match(m.text, /📋 Одобрить add-y: ORB-405 теряет факты: лимит целей 15\. \(авто-одобрение \d\d\.\d\d \d\d:\d\d\)/);
  assert.match(m.text, /Кнопки ниже; свой ответ — текстом/);
  assert.ok(m.text.indexOf('Решить:') < m.text.indexOf('Дальше:'));
  assert.deepEqual(m.keyboard.map((row) => row[0].callback_data), ['qd:Q1', 'ap:add-y']);
  fs.mkdirSync(path.join(p.runs, 'r1'), { recursive: true });
  fs.writeFileSync(path.join(p.runs, 'r1', 'summary.md'), `# Прогон\n## Сделано\n${Array.from({ length: 5 }, (_, i) => `- пункт ${i} ${'x'.repeat(400)}`).join('\n')}\n`);
  const big = loadQuestions(p);
  for (let i = 0; i < 4; i++) addQuestion(big, { category: 'spec', text: `вопрос ${i} ${'y'.repeat(500)}`, defaultAnswer: 'z'.repeat(300) }, cfg);
  saveQuestions(p, big);
  const long = finishMessage(cfg, record(), p);
  assert.ok(long.text.length <= 3800);
  assert.match(long.text, /❓ Q6:/, 'последний вопрос на месте'); assert.match(long.text, /Дальше:/);
  assert.ok(long.text.split('\n').filter((l) => l.startsWith('• пункт')).length < 5, '«Сделано» урезано ради вопросов');
});

test('0.5.10: итог прогона — «Простыми словами» сразу под строкой статуса, без обратных кавычек и не длиннее 700', () => {
  const dir = bareProject(); const p = paths(dir);
  fs.mkdirSync(path.join(p.runs, 'r1'), { recursive: true });
  fs.writeFileSync(path.join(p.runs, 'r1', 'summary.md'), `# Прогон r1\n## Простыми словами\nСтарые скриншоты элемента теперь остаются в \`истории\`.\nОт вас ничего не нужно.\n## Сделано\n- history-screenshots: задачи 1–6\n`);
  const m = finishMessage(cfg, record(), p);
  const lines = m.text.split('\n');
  assert.equal(lines[1], ''); assert.equal(lines[2], 'Простыми словами: Старые скриншоты элемента теперь остаются в истории. От вас ничего не нужно.');
  assert.ok(m.text.indexOf('Простыми словами') < m.text.indexOf('Сделано:'));
  fs.writeFileSync(path.join(p.runs, 'r1', 'summary.md'), `# Прогон r1\n## Простыми словами\n${'а'.repeat(900)}\n`);
  const long = finishMessage(cfg, record(), p).text.split('\n')[2];
  assert.ok(long.length <= 'Простыми словами: '.length + 700 && long.endsWith('…'));
  fs.writeFileSync(path.join(p.runs, 'r1', 'summary.md'), '# Прогон r1\n## Простыми словами\nнет\n');
  assert.doesNotMatch(finishMessage(cfg, record(), p).text, /Простыми словами/);
});

import { loadIdeas as li4, saveIdeas as si4, addIdea as ai4, transitionIdea as ti4 } from '../src/ideas.js';
test('0.7.0: «запусти» — взятый пункт запускает прогон, хотя изменение ждёт одобрения', async () => {
  const dir = bareProject(); const p = paths(dir);
  addChange(dir, 'add-y', { meta: pending('add-y') });
  const d = li4(p); ai4(d, { title: 'X', benefit: 'y', source: 'team', size: 'S' }); ti4(d, 'I1', 'taken', { actor: 'bot' }); si4(p, d);
  const tg = fakeTg([msg(1, 'запусти')]); const started = [];
  await pullAnswers({ projectDir: dir, cfg: tgCfg, p, telegram: tg, log: () => {}, startRun: (x) => started.push(x) });
  assert.deepEqual(started, [dir]); assert.match(tg.sent[0].text, /▶️ Запускаю/);
});
