import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { MCFLY_ROOT } from '../src/prompt.js';
import { parseReminder, whenText, addReminder, pendingReminders, listReminders, cancelReminder, snoozeReminder,
  reminderMessage, deliverDueReminders, remindersView, remindersPath, KEEP_DONE_MS } from '../src/reminders.js';
import { parseMessage, applyMessages } from '../src/answers.js';
import { callbackText } from '../src/telegram.js';
import { pollAnswers, pullAnswers } from '../src/pull.js';
import { parseConfig } from '../src/config.js';
import { paths } from '../src/state.js';
import { readText } from '../src/util.js';
import { cfg, bareProject } from './helpers.js';

const tgCfg = { ...cfg, telegram: { chat_id: '42', token_env: 'MCFLY_TEST_TG' } };
process.env.MCFLY_TEST_TG = 'T';
const withEval = { ...parseConfig('project: demo\nactions:\n  eval:\n    title: "🧪 Eval промптов"\n    run: "true"\n'), telegram: tgCfg.telegram };
const at = (y, mo, d, h, mi, sec = 0) => new Date(y, mo - 1, d, h, mi, sec);
const NOW = at(2026, 11, 6, 15, 30);

/** Подставной Telegram: отправленные сообщения с кнопками; fail — сколько следующих отправок бросают ошибку. */
function fakeTg({ updates = [], fail = 0, failText = 'fetch failed' } = {}) {
  const tg = { sent: [], updates: [...updates], fail,
    async getUpdates(offset) { const got = tg.updates.filter((u) => u.update_id >= offset); return got; },
    async sendMessage(chatId, text, o = {}) {
      if (tg.fail > 0) { tg.fail -= 1; throw new Error(failText); }
      tg.sent.push({ text, keyboard: o.keyboard || null }); return [];
    },
    async answerCallbackQuery() { return true; },
  };
  return tg;
}
const msg = (id, text) => ({ update_id: id, message: { message_id: id, chat: { id: 42 }, text, date: 1700000000 } });

test('0.8.0: время напоминания — сегодня, завтра, дата, «через»; прошедшее «19:00» — завтра', () => {
  const r = parseReminder('19:00 нажать 🧪 Eval промптов', NOW);
  assert.deepEqual([r.at, r.text], [at(2026, 11, 6, 19, 0), 'нажать 🧪 Eval промптов']);
  assert.deepEqual(parseReminder('в 9:05 кофе', NOW).at, at(2026, 11, 7, 9, 5), 'время сегодня прошло — завтра');
  assert.deepEqual(parseReminder('завтра в 10:00 x', NOW).at, at(2026, 11, 7, 10, 0));
  assert.deepEqual(parseReminder('послезавтра 10:00 x', NOW).at, at(2026, 11, 8, 10, 0));
  assert.deepEqual(parseReminder('сегодня 18:00 x', NOW).at, at(2026, 11, 6, 18, 0));
  assert.deepEqual(parseReminder('08.11 10:00 x', NOW).at, at(2026, 11, 8, 10, 0));
  assert.deepEqual(parseReminder('08.11.2027 в 10:00 x', NOW).at, at(2027, 11, 8, 10, 0));
  assert.deepEqual(parseReminder('02.01 10:00 x', NOW).at, at(2027, 1, 2, 10, 0), 'дата без года прошла — следующий год');
  assert.deepEqual(parseReminder('через 2 ч x', NOW).at, at(2026, 11, 6, 17, 30));
  assert.deepEqual(parseReminder('через 30 мин x', NOW).at, at(2026, 11, 6, 16, 0));
  assert.deepEqual(parseReminder('через час x', NOW).at, at(2026, 11, 6, 16, 30));
  assert.deepEqual(parseReminder('мне в 19:00 позвонить', NOW).text, 'позвонить');
});

test('0.8.0: непонятное время, прошедшая дата, пустой текст — ошибка с примерами', () => {
  assert.match(parseReminder('вечером нажать eval', NOW).error, /Не понял.*напомни 19:00/);
  assert.match(parseReminder('25:00 x', NOW).error, /Нет такого времени/);
  assert.match(parseReminder('31.02 10:00 x', NOW).error, /Нет такой даты/);
  assert.match(parseReminder('сегодня 10:00 x', NOW).error, /уже прошло/);
  assert.match(parseReminder('01.11.2026 10:00 x', NOW).error, /уже прошло/);
  assert.match(parseReminder('19:00', NOW).error, /О чём напомнить/);
  assert.match(parseReminder('19.00 x', NOW).error, /Не понял/, 'точка вместо двоеточия — не время');
});

test('0.8.0: «сегодня в», «завтра в», дата — в подтверждении', () => {
  assert.equal(whenText(at(2026, 11, 6, 19, 0), NOW), 'сегодня в 19:00');
  assert.equal(whenText(at(2026, 11, 7, 9, 5), NOW), 'завтра в 09:05');
  assert.equal(whenText(at(2026, 11, 9, 9, 5), NOW), '09.11 в 09:05');
});

test('0.8.0: сообщения бота — «напомни …», «напоминания», кнопки отложить и отменить', () => {
  assert.deepEqual(parseMessage('напомни 19:00 нажать Eval'), { type: 'remind', text: '19:00 нажать Eval' });
  assert.deepEqual(parseMessage('Напомни, завтра 10:00 x'), { type: 'remind', text: 'завтра 10:00 x' });
  assert.deepEqual(parseMessage('напомнить через час x'), { type: 'remind', text: 'через час x' });
  for (const t of ['напоминания', '🔔 Напоминания', '/reminders', '/reminders@mcfly_bot']) assert.deepEqual(parseMessage(t), { type: 'reminders' }, t);
  assert.deepEqual(parseMessage('отменить r3'), { type: 'remindCancel', id: 'R3' });
  assert.deepEqual(parseMessage('отложить R3'), { type: 'remindSnooze', id: 'R3' });
  assert.equal(parseMessage('напоминаю, что сайт лежит').type, 'note', 'не команда — заметка');
  assert.equal(callbackText('rs:R3'), 'отложить R3');
  assert.equal(callbackText('rx:R3'), 'отменить R3');
});

test('0.8.0: «напомни» в Telegram ставит напоминание и отвечает когда; ошибка — подсказка; в answers.md не пишется', () => {
  const dir = bareProject(); const p = paths(dir);
  const before = readText(p.answers);
  const acks = applyMessages(p, [{ text: 'напомни 19:00 нажать 🧪 Eval промптов' }, { text: 'напомни вечером' }], { now: NOW });
  assert.equal(acks[0], '🔔 R1: напомню сегодня в 19:00 — нажать 🧪 Eval промптов');
  assert.match(acks[1], /^⚠️ Не понял/);
  assert.equal(readText(p.answers), before);
  const [r] = pendingReminders(p);
  assert.equal(r.id, 'R1'); assert.equal(new Date(r.at).getTime(), at(2026, 11, 6, 19, 0).getTime());
  // переживает перезапуск: новый объект путей читает тот же файл
  assert.equal(pendingReminders(paths(dir)).length, 1);
  assert.equal(addReminder(p, { at: at(2026, 11, 7, 10, 0), text: 'y', now: NOW }).id, 'R2', 'номера растут');
});

test('0.8.0: напоминание приходит один раз, с кнопкой действия и «Через час»; раннее не приходит', async () => {
  const dir = bareProject(); const p = paths(dir);
  addReminder(p, { at: at(2026, 11, 6, 19, 0), text: 'нажать 🧪 Eval промптов', now: NOW });
  addReminder(p, { at: at(2026, 11, 7, 10, 0), text: 'завтрашнее', now: NOW });
  const tg = fakeTg(); const send = (text, kb) => tg.sendMessage('42', text, { keyboard: kb });
  assert.equal(await deliverDueReminders({ p, cfg: withEval, now: at(2026, 11, 6, 18, 59), send }), 0);
  assert.equal(await deliverDueReminders({ p, cfg: withEval, now: at(2026, 11, 6, 19, 0, 20), send }), 1);
  assert.equal(await deliverDueReminders({ p, cfg: withEval, now: at(2026, 11, 6, 19, 1), send }), 0, 'повтор не приходит');
  assert.equal(tg.sent.length, 1);
  assert.equal(tg.sent[0].text, '🔔 Напоминание R1: нажать 🧪 Eval промптов');
  assert.deepEqual(tg.sent[0].keyboard, [[{ text: '🧪 Eval промптов', callback_data: 'ac:eval' }], [{ text: '⏰ Через час', callback_data: 'rs:R1' }]]);
  assert.deepEqual(pendingReminders(p).map((r) => r.id), ['R2']);
  // без действий в тексте — только «Через час»
  assert.deepEqual(reminderMessage(withEval, { id: 'R5', at: NOW.toISOString(), text: 'позвонить' }, NOW).keyboard, [[{ text: '⏰ Через час', callback_data: 'rs:R5' }]]);
});

test('0.8.0: просроченное, пока Mac спал, — с пометкой об опоздании; меньше 5 минут — без неё', () => {
  const r = { id: 'R1', at: at(2026, 11, 6, 19, 0).toISOString(), text: 'x' };
  assert.equal(reminderMessage(cfg, r, at(2026, 11, 6, 21, 10)).text, '🕓 Опоздало на 2 ч 10 мин (срок был 19:00) — Mac спал или не было связи\n🔔 Напоминание R1: x');
  assert.match(reminderMessage(cfg, r, at(2026, 11, 7, 8, 0)).text, /^🕓 Опоздало на 13 ч 00 мин \(срок был 06\.11 19:00\)/);
  assert.equal(reminderMessage(cfg, r, at(2026, 11, 6, 19, 4)).text, '🔔 Напоминание R1: x');
});

test('0.8.0: нет связи — напоминание остаётся и уходит в следующий раз; Bad Request не держит остальные', async () => {
  const dir = bareProject(); const p = paths(dir); const logs = [];
  addReminder(p, { at: at(2026, 11, 6, 19, 0), text: 'a', now: NOW });
  addReminder(p, { at: at(2026, 11, 6, 19, 0), text: 'b', now: NOW });
  const tg = fakeTg({ fail: 1 }); const send = (text, kb) => tg.sendMessage('42', text, { keyboard: kb });
  assert.equal(await deliverDueReminders({ p, cfg, now: at(2026, 11, 6, 19, 1), send, log: (l) => logs.push(l) }), 0);
  assert.match(logs[0], /R1 не отправлено: fetch failed/);
  assert.equal(pendingReminders(p).length, 2);
  assert.equal(await deliverDueReminders({ p, cfg, now: at(2026, 11, 6, 19, 2), send }), 2);
  const bad = fakeTg({ fail: 1, failText: 'Telegram sendMessage: Bad Request: message is too long' });
  addReminder(p, { at: at(2026, 11, 6, 19, 0), text: 'c', now: NOW }); addReminder(p, { at: at(2026, 11, 6, 19, 0), text: 'd', now: NOW });
  assert.equal(await deliverDueReminders({ p, cfg, now: at(2026, 11, 6, 19, 3), send: (t, kb) => bad.sendMessage('42', t, { keyboard: kb }), log: () => {} }), 1);
  assert.equal(pendingReminders(p).length, 0, 'отклонённое Telegram не повторяется');
  assert.equal(listReminders(p).find((r) => r.text === 'c').status, 'failed');
});

test('0.8.0: «Через час» переносит пришедшее; «отменить» — ожидающее; повторные нажатия понятны', () => {
  const dir = bareProject(); const p = paths(dir);
  addReminder(p, { at: at(2026, 11, 6, 19, 0), text: 'x', now: NOW });
  assert.equal(snoozeReminder(p, 'R1', at(2026, 11, 6, 19, 5)), '⏰ R1: напомню сегодня в 20:05 — x');
  assert.equal(new Date(pendingReminders(p)[0].at).getTime(), at(2026, 11, 6, 20, 5).getTime());
  assert.equal(cancelReminder(p, 'R1', NOW), '✖️ R1 отменено: x');
  assert.equal(cancelReminder(p, 'R1', NOW), 'ℹ️ R1 уже отменено');
  assert.match(snoozeReminder(p, 'R1', NOW), /R1 отменено — поставьте новое/);
  assert.equal(cancelReminder(p, 'R9', NOW), '⚠️ R9: такого напоминания нет');
  const acks = applyMessages(p, [{ text: 'отложить R9' }], { now: NOW });
  assert.deepEqual(acks, ['⚠️ R9: такого напоминания нет']);
});

test('0.8.0: «напоминания» — список ожидающих с кнопками отмены; пусто — как поставить', () => {
  const dir = bareProject(); const p = paths(dir);
  assert.match(remindersView(p, NOW).text, /Напоминаний нет.*напомни 19:00/s);
  assert.deepEqual(remindersView(p, NOW).keyboard, []);
  addReminder(p, { at: at(2026, 11, 7, 10, 0), text: 'второе', now: NOW });
  addReminder(p, { at: at(2026, 11, 6, 19, 0), text: 'первое', now: NOW });
  const v = remindersView(p, NOW);
  assert.match(v.text, /R2 — сегодня в 19:00: первое\nR1 — завтра в 10:00: второе/);
  assert.deepEqual(v.keyboard, [[{ text: '✖️ Отменить R2', callback_data: 'rx:R2' }], [{ text: '✖️ Отменить R1', callback_data: 'rx:R1' }]]);
});

test('0.8.0: отправленные и отменённые старше 7 дней удаляются из файла', async () => {
  const dir = bareProject(); const p = paths(dir);
  addReminder(p, { at: at(2026, 11, 6, 19, 0), text: 'old', now: NOW });
  await deliverDueReminders({ p, cfg, now: at(2026, 11, 6, 19, 1), send: async () => {} });
  addReminder(p, { at: new Date(at(2026, 11, 6, 19, 1).getTime() + KEEP_DONE_MS + 60_000), text: 'new', now: new Date(at(2026, 11, 6, 19, 1).getTime() + KEEP_DONE_MS + 60_000) });
  assert.deepEqual(listReminders(p).map((r) => r.text), ['new']);
  assert.equal(addReminder(p, { at: at(2027, 1, 1, 10, 0), text: 'z', now: NOW }).id, 'R3', 'номер не переиспользуется');
});

test('0.8.0: повреждённый файл напоминаний не затирается', () => {
  const dir = bareProject(); const p = paths(dir);
  fs.mkdirSync(p.logs, { recursive: true }); fs.writeFileSync(remindersPath(p), '{битый');
  assert.throws(() => addReminder(p, { at: at(2026, 11, 7, 10, 0), text: 'x', now: NOW }), /reminders\.json/);
  assert.equal(fs.readFileSync(remindersPath(p), 'utf8'), '{битый');
});

test('0.8.0: задание answers — «напомни» из чата, срок наступил посреди цикла, приходит один раз', async () => {
  const dir = bareProject(); const p = paths(dir);
  let t = at(2026, 11, 6, 18, 59, 30).getTime(); const clock = () => t; const sleep = async (ms) => { t += ms; };
  const tg = fakeTg({ updates: [msg(1, 'напомни 19:00 нажать 🧪 Eval промптов')] });
  const orig = tg.getUpdates; tg.getUpdates = async (o) => { const r = await orig(o); t += 5_000; return r; };
  await pollAnswers({ projectDir: dir, cfg: { ...withEval, telegram: tgCfg.telegram }, p, telegram: tg, log: () => {}, durationMs: 120_000, clock, sleep, startRun: () => {} });
  const texts = tg.sent.map((s) => s.text);
  assert.ok(texts.includes('🔔 R1: напомню сегодня в 19:00 — нажать 🧪 Eval промптов'), texts.join('|'));
  assert.equal(texts.filter((x) => x === '🔔 Напоминание R1: нажать 🧪 Eval промптов').length, 1, texts.join('|'));
});

test('0.8.0: «напоминания» в чате — список отдельным сообщением с кнопками', async () => {
  const dir = bareProject(); const p = paths(dir);
  addReminder(p, { at: at(2026, 11, 6, 19, 0), text: 'x', now: NOW });
  const tg = fakeTg({ updates: [msg(1, '/reminders')] });
  await pullAnswers({ projectDir: dir, cfg: tgCfg, p, telegram: tg, log: () => {}, now: NOW, startRun: () => {} });
  assert.equal(tg.sent.length, 1);
  assert.match(tg.sent[0].text, /R1 — сегодня в 19:00: x/);
  assert.deepEqual(tg.sent[0].keyboard, [[{ text: '✖️ Отменить R1', callback_data: 'rx:R1' }]]);
});

test('0.8.0: mcfly remind list и rm — список и отмена; в прогоне команды отмена запрещена', () => {
  const dir = bareProject(); const p = paths(dir);
  const soon = new Date(Date.now() + 3_600_000);
  addReminder(p, { at: soon, text: 'нажать eval', now: new Date() });
  const cli = (args, runId = '') => spawnSync(process.execPath, [path.join(MCFLY_ROOT, 'bin', 'mcfly'), ...args, '--project', dir], { encoding: 'utf8', env: { ...process.env, MCFLY_PROJECT_DIR: '', MCFLY_RUN_ID: runId } });
  assert.match(cli(['remind', 'list']).stdout, /R1 — .* в \d\d:\d\d .*: нажать eval/);
  const inRun = cli(['remind', 'rm', 'R1'], '20261106-1900');
  assert.equal(inRun.status, 1); assert.match(inRun.stderr, /только он/);
  const bad = cli(['remind', 'rm']); assert.equal(bad.status, 1); assert.match(bad.stderr, /mcfly remind rm R3/);
  const ok = cli(['remind', 'rm', 'r1']); assert.equal(ok.status, 0, ok.stderr); assert.match(ok.stdout, /R1 отменено/);
  assert.match(cli(['remind', 'list']).stdout, /Напоминаний нет/);
});
