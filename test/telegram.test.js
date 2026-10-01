import test from 'node:test';
import assert from 'node:assert/strict';
import { chunk, createTelegram, extractMessages, callbackText } from '../src/telegram.js';
import { pullAnswers } from '../src/pull.js';
import { paths, loadState } from '../src/state.js';
import { loadQuestions, addQuestion, saveQuestions } from '../src/questions.js';
import { cfg, bareProject } from './helpers.js';

function fakeFetch(responses) {
  const calls = [];
  const f = async (url, init) => { calls.push({ url, body: JSON.parse(init.body) }); const method = url.split('/').pop(); return { status: 200, json: async () => ({ ok: true, result: responses[method] ?? [] }) }; };
  f.calls = calls; return f;
}
test('chunk режет по переносам строк', () => {
  const parts = chunk('a\n'.repeat(3000), 4000);
  assert.ok(parts.length >= 2); assert.ok(parts.every((x) => x.length <= 4000));
  assert.deepEqual(chunk('короткий'), ['короткий']);
});
test('sendMessage и getUpdates ходят в API', async () => {
  const f = fakeFetch({ sendMessage: { message_id: 1 }, getUpdates: [] });
  const tg = createTelegram({ token: 'T', fetchImpl: f });
  await tg.sendMessage('42', 'привет'); await tg.getUpdates(5, 0);
  assert.equal(f.calls[0].url, 'https://api.telegram.org/botT/sendMessage');
  assert.deepEqual(f.calls[0].body, { chat_id: '42', text: 'привет', disable_web_page_preview: true });
  assert.equal(f.calls[1].body.offset, 5);
  assert.throws(() => createTelegram({ token: '' }), /токена/);
});
test('extractMessages фильтрует по чату и считает offset', () => {
  const updates = [{ update_id: 10, message: { message_id: 1, chat: { id: 42 }, text: 'Q1: a', date: 1700000000, from: { username: 'u' } } }, { update_id: 11, message: { message_id: 2, chat: { id: 99 }, text: 'чужой', date: 1700000000 } }, { update_id: 12 }];
  const { messages, nextOffset } = extractMessages(updates, '42');
  assert.equal(messages.length, 1); assert.equal(messages[0].text, 'Q1: a'); assert.equal(nextOffset, 13);
});
test('pullAnswers применяет ответы, сдвигает offset и подтверждает', async () => {
  const dir = bareProject(); const p = paths(dir);
  const data = loadQuestions(p); addQuestion(data, { category: 'spec', text: 'x', defaultAnswer: 'y' }, cfg); saveQuestions(p, data);
  const f = fakeFetch({ getUpdates: [{ update_id: 7, message: { message_id: 1, chat: { id: 42 }, text: 'Q1: b', date: 1700000000 } }], sendMessage: {} });
  const tg = createTelegram({ token: 'T', fetchImpl: f });
  const c = { ...cfg, telegram: { chat_id: '42', token_env: 'X' } };
  process.env.X = 'T';
  const r = await pullAnswers({ projectDir: dir, cfg: c, p, telegram: tg, log: () => {} });
  assert.equal(r.applied, 1); assert.equal(loadState(p).telegram_offset, 8);
  assert.match(f.calls[1].body.text, /Q1/);
});

test('sendMessage с HTML и кнопками; getUpdates просит и нажатия кнопок', async () => {
  const f = fakeFetch({ sendMessage: { message_id: 1 }, getUpdates: [], answerCallbackQuery: true });
  const tg = createTelegram({ token: 'T', fetchImpl: f });
  await tg.sendMessage('42', '<b>x</b>', { html: true, keyboard: [[{ text: 'a', callback_data: 'ap:x' }]] });
  assert.deepEqual(f.calls[0].body, { chat_id: '42', text: '<b>x</b>', disable_web_page_preview: true, parse_mode: 'HTML', reply_markup: { inline_keyboard: [[{ text: 'a', callback_data: 'ap:x' }]] } });
  await tg.getUpdates(0, 0);
  assert.deepEqual(f.calls[1].body.allowed_updates, ['message', 'callback_query']);
  await tg.answerCallbackQuery('cb1', 'ок');
  assert.deepEqual(f.calls[2].body, { callback_query_id: 'cb1', text: 'ок' });
});
test('callbackText переводит кнопку в команду', () => {
  assert.equal(callbackText('ap:fix-x'), 'approve fix-x');
  assert.equal(callbackText('rj:fix-x'), 'reject fix-x отклонено кнопкой в Telegram');
  assert.equal(callbackText('qd:Q3'), 'Q3: по умолчанию');
  assert.equal(callbackText('мусор'), null);
});
test('extractMessages: нажатие кнопки из нужного чата — сообщение с id нажатия', () => {
  const updates = [{ update_id: 20, callback_query: { id: 'cb1', data: 'ap:fix-x', from: { username: 'u' }, message: { message_id: 5, chat: { id: 42 }, date: 1700000000 } } },
    { update_id: 21, callback_query: { id: 'cb2', data: 'ap:fix-x', message: { message_id: 5, chat: { id: 99 }, date: 1700000000 } } }];
  const { messages, nextOffset } = extractMessages(updates, '42');
  assert.equal(messages.length, 1); assert.equal(messages[0].text, 'approve fix-x'); assert.equal(messages[0].callbackId, 'cb1'); assert.equal(nextOffset, 22);
});
test('pullAnswers отвечает на нажатие кнопки', async () => {
  const dir = bareProject(); const p = paths(dir);
  const data = loadQuestions(p); addQuestion(data, { category: 'spec', text: 'x', defaultAnswer: 'y' }, cfg); saveQuestions(p, data);
  const f = fakeFetch({ getUpdates: [{ update_id: 7, callback_query: { id: 'cb9', data: 'qd:Q1', message: { message_id: 1, chat: { id: 42 }, date: 1700000000 } } }], sendMessage: {}, answerCallbackQuery: true });
  const tg = createTelegram({ token: 'T', fetchImpl: f });
  process.env.X = 'T';
  await pullAnswers({ projectDir: dir, cfg: { ...cfg, telegram: { chat_id: '42', token_env: 'X' } }, p, telegram: tg, log: () => {} });
  assert.equal(loadQuestions(p).questions[0].answer, 'y', 'кнопка «по умолчанию» отвечает текстом по умолчанию');
  assert.ok(f.calls.some((c) => c.url.endsWith('/answerCallbackQuery') && c.body.callback_query_id === 'cb9'));
});

import fs from 'node:fs'; import path from 'node:path';
import { spawn } from 'node:child_process';
const startMsg = (id) => ({ update_id: id, message: { message_id: id, chat: { id: 42 }, text: 'запусти', date: 1700000000 } });
const tgCfg = (extra = {}) => ({ ...cfg, telegram: { chat_id: '42', token_env: 'X' }, run: { ...cfg.run, ...extra } });
test('0.5.2: «запусти» из Telegram стартует дневной прогон и сразу отвечает', async () => {
  const dir = bareProject(); const p = paths(dir); process.env.X = 'T';
  const f = fakeFetch({ getUpdates: [startMsg(30)], sendMessage: {} });
  const started = [];
  await pullAnswers({ projectDir: dir, cfg: tgCfg(), p, telegram: createTelegram({ token: 'T', fetchImpl: f }), log: () => {}, startRun: (d) => started.push(d) });
  assert.deepEqual(started, [dir]);
  assert.match(f.calls.find((c) => c.url.endsWith('/sendMessage')).body.text, /▶️ Запускаю дневной прогон/);
});
test('0.5.2: «запусти» во время прогона — ответ «идёт прогон», второй не стартует', async () => {
  const dir = bareProject(); const p = paths(dir); process.env.X = 'T';
  const runner = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)', 'mcfly', 'run'], { stdio: 'ignore' });
  fs.writeFileSync(path.join(dir, 'mcfly', '.lock'), JSON.stringify({ pid: runner.pid, at: new Date(2026, 9, 1, 17, 53).toISOString(), id: '20261001-1753' }));
  const f = fakeFetch({ getUpdates: [startMsg(31)], sendMessage: {} });
  const started = [];
  try { await pullAnswers({ projectDir: dir, cfg: tgCfg(), p, telegram: createTelegram({ token: 'T', fetchImpl: f }), log: () => {}, startRun: (d) => started.push(d) }); } finally { runner.kill(); }
  assert.deepEqual(started, []);
  assert.match(f.calls.find((c) => c.url.endsWith('/sendMessage')).body.text, /⏳ Идёт прогон 20261001-1753 с 17:53/);
});
test('0.5.2: run.telegram_start: false — «запусти» только записывается, как раньше', async () => {
  const dir = bareProject(); const p = paths(dir); process.env.X = 'T';
  const f = fakeFetch({ getUpdates: [startMsg(32)], sendMessage: {} });
  const started = [];
  await pullAnswers({ projectDir: dir, cfg: tgCfg({ telegram_start: false }), p, telegram: createTelegram({ token: 'T', fetchImpl: f }), log: () => {}, startRun: (d) => started.push(d) });
  assert.deepEqual(started, []);
  assert.match(f.calls.find((c) => c.url.endsWith('/sendMessage')).body.text, /Запрос записан/);
});
