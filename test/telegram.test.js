import test from 'node:test';
import assert from 'node:assert/strict';
import { chunk, createTelegram, extractMessages } from '../src/telegram.js';
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
