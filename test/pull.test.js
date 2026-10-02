import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pullAnswers, pollAnswers, acquirePullLock, releasePullLock } from '../src/pull.js';
import { acquireLock, releaseLock, currentRun } from '../src/runner.js';
import { paths, loadState } from '../src/state.js';
import { loadQuestions, addQuestion, saveQuestions } from '../src/questions.js';
import { readText } from '../src/util.js';
import { cfg, bareProject } from './helpers.js';

const tgCfg = { ...cfg, telegram: { chat_id: '42', token_env: 'MCFLY_TEST_TG' } };
process.env.MCFLY_TEST_TG = 'T';
const msg = (id, text) => ({ update_id: id, message: { message_id: id, chat: { id: 42 }, text, date: 1700000000 } });

/** Подставной Telegram: очередь обновлений, getUpdates отдаёт всё с update_id >= offset; длинный опрос без сообщений «ждёт» timeout по часам clock. */
function fakeTg({ clock = null, updates = [], failures = [] } = {}) {
  const tg = { updates: [...updates], sent: [], callbacks: [], polls: [], gate: null,
    async getUpdates(offset, timeoutSec) {
      tg.polls.push({ offset, timeoutSec });
      const fail = failures.shift(); if (fail) throw new Error(fail);
      if (tg.gate) await tg.gate;
      const got = tg.updates.filter((u) => u.update_id >= offset);
      if (!got.length && clock) clock.advance(timeoutSec * 1000);
      return got;
    },
    async sendMessage(chatId, text) { tg.sent.push(text); return []; },
    async answerCallbackQuery(id) { tg.callbacks.push(id); return true; },
  };
  return tg;
}
function fakeClock(start = Date.UTC(2026, 9, 2, 10, 0)) {
  let t = start;
  const c = () => t; c.advance = (ms) => { t += ms; }; return c;
}
const fakeSleep = (clock, log = []) => async (ms) => { log.push(ms); clock.advance(ms); };

test('0.5.4: цикл обрабатывает сообщение в первой же итерации и сразу отвечает', async () => {
  const dir = bareProject(); const p = paths(dir);
  const data = loadQuestions(p); addQuestion(data, { category: 'spec', text: 'x', defaultAnswer: 'y' }, cfg); saveQuestions(p, data);
  const clock = fakeClock();
  const tg = fakeTg({ clock, updates: [msg(7, 'Q1: b'), { update_id: 8, callback_query: { id: 'cb1', data: 'qd:Q1', message: { message_id: 1, chat: { id: 42 }, date: 1700000000 } } }] });
  const started = [];
  // после первой итерации обновлений больше нет: дальше пустые длинные опросы до конца окна
  const orig = tg.getUpdates; let n = 0;
  tg.getUpdates = async (o, t) => { const r = await orig(o, t); n += 1; if (n === 1) { tg.updates = []; tg.updates.push(msg(9, 'запусти')); } return r; };
  await pollAnswers({ projectDir: dir, cfg: tgCfg, p, telegram: tg, log: () => {}, clock, sleep: fakeSleep(clock), durationMs: 60_000, startRun: (d) => started.push(d) });
  assert.equal(tg.polls[0].offset, 0); assert.equal(tg.polls[0].timeoutSec, 25, 'длинный опрос 25 с');
  assert.match(tg.sent[0], /Q1: ответ записан/);
  assert.deepEqual(tg.callbacks, ['cb1'], 'нажатие кнопки подтверждено сразу');
  assert.equal(tg.polls[1].offset, 9, 'offset сохранён после первой итерации');
  assert.deepEqual(started, [dir]); assert.match(tg.sent[1], /▶️ Запускаю дневной прогон/);
  assert.equal(loadState(p).telegram_offset, 10);
});

test('0.5.4: «запусти» дважды подряд в одном задании — второй прогон не стартует, пока первый поднимается', async () => {
  const dir = bareProject(); const p = paths(dir); const clock = fakeClock();
  const tg = fakeTg({ clock, updates: [msg(1, 'запусти')] });
  const orig = tg.getUpdates; let n = 0;
  tg.getUpdates = async (o, t) => { const r = await orig(o, t); n += 1; if (n === 1) tg.updates = [msg(2, 'запусти')]; return r; };
  const started = [];
  await pollAnswers({ projectDir: dir, cfg: tgCfg, p, telegram: tg, log: () => {}, clock, sleep: fakeSleep(clock), durationMs: 30_000, startRun: (d) => started.push(d) });
  assert.equal(started.length, 1);
  assert.match(tg.sent[1], /уже запускается/);
});

test('0.5.4: ошибка сети — одна строка в журнал, пауза и следующая попытка', async () => {
  const dir = bareProject(); const p = paths(dir); const clock = fakeClock();
  const tg = fakeTg({ clock, updates: [msg(5, 'заметка')], failures: ['fetch failed', 'Telegram getUpdates: HTTP 504 Gateway Timeout'] });
  const lines = []; const slept = [];
  await pollAnswers({ projectDir: dir, cfg: tgCfg, p, telegram: tg, log: (s) => lines.push(s), clock, sleep: fakeSleep(clock, slept), durationMs: 60_000 });
  const errs = lines.filter((l) => /недоступен/.test(l));
  assert.equal(errs.length, 2); assert.ok(errs.every((l) => !l.includes('\n') && !/at .*\.js/.test(l)), 'без стека');
  assert.match(errs[0], /fetch failed/); assert.match(errs[1], /504/);
  assert.ok(slept.slice(0, 2).every((ms) => ms >= 10_000 && ms <= 15_000), `пауза 10–15 с: ${slept}`);
  assert.match(tg.sent[0], /заметку/, 'после ошибок сообщение обработано');
});

test('0.5.4: выход по времени — не позже конца окна, последний опрос укорочен', async () => {
  const dir = bareProject(); const p = paths(dir); const clock = fakeClock(); const t0 = clock();
  const tg = fakeTg({ clock });
  const lines = [];
  await pollAnswers({ projectDir: dir, cfg: tgCfg, p, telegram: tg, log: (s) => lines.push(s), clock, sleep: fakeSleep(clock), durationMs: 570_000 });
  assert.ok(clock() - t0 <= 570_000, `вышел через ${clock() - t0} мс`);
  assert.ok(clock() - t0 >= 560_000, 'окно использовано почти целиком');
  assert.ok(tg.polls.length >= 20 && tg.polls.length <= 24, `опросов ${tg.polls.length}`);
  assert.ok(tg.polls.every((x) => x.timeoutSec >= 1 && x.timeoutSec <= 25));
  assert.equal(lines.filter((l) => /Telegram: сообщений/.test(l)).length, 0, 'пустые опросы не шумят в журнале');
  assert.match(lines.at(-1), /Опрос Telegram завершён: запросов \d+, сообщений 0, ошибок 0/);
});

test('0.5.4: блокировка опроса — два параллельных pullAnswers не применяют одно сообщение дважды', async () => {
  const dir = bareProject(); const p = paths(dir);
  const tg = fakeTg({ updates: [msg(7, 'заметка раз')] });
  let open; tg.gate = new Promise((r) => { open = r; }); // первый держит getUpdates, пока второй пытается читать
  setTimeout(() => open(), 50); // и без блокировки тест не виснет, а падает на двойном применении
  const sleep = async () => { await new Promise((r) => setImmediate(r)); open(); };
  const opts = { projectDir: dir, cfg: tgCfg, p, telegram: tg, log: () => {}, sleep, lockWaitMs: 5_000 };
  const [a, b] = await Promise.all([pullAnswers(opts), pullAnswers(opts)]);
  assert.equal(a.applied + b.applied, 1, 'применено ровно один раз');
  assert.deepEqual(tg.polls.map((x) => x.offset), [0, 8], 'второй читал после сохранения offset первым');
  assert.equal(readText(p.answers).match(/заметка раз/g).length, 1);
  assert.equal(fs.existsSync(path.join(p.logs, '.pull.lock')), false, 'блокировка снята');
});

test('0.5.4: занятая блокировка без ожидания — опрос пропущен; блокировка мёртвого процесса устарела', () => {
  const dir = bareProject(); const p = paths(dir);
  const own = acquirePullLock(p);
  assert.ok(own);
  assert.equal(acquirePullLock(p), null, 'занята — даже тем же процессом (другой вызов pullAnswers)');
  releasePullLock(p, own);
  assert.equal(fs.existsSync(path.join(p.logs, '.pull.lock')), false);
  fs.mkdirSync(p.logs, { recursive: true });
  const lockFile = path.join(p.logs, '.pull.lock');
  fs.writeFileSync(lockFile, JSON.stringify({ pid: 999999, at: new Date().toISOString() }));
  const stale = acquirePullLock(p);
  assert.ok(stale, 'pid мёртв — блокировка брошена');
  releasePullLock(p, stale);
  const live = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'ignore' });
  try {
    fs.writeFileSync(lockFile, JSON.stringify({ pid: live.pid, at: new Date().toISOString() }));
    assert.equal(acquirePullLock(p), null, 'живой держатель');
    fs.writeFileSync(lockFile, JSON.stringify({ pid: live.pid, at: new Date(Date.now() - 11 * 60_000).toISOString() }));
    const old = acquirePullLock(p);
    assert.ok(old, 'старше 10 минут — pid мог достаться другому процессу');
    releasePullLock(p, old);
  } finally { live.kill(); }
});

test('0.5.4: прогон нового кода помечает лок; currentRun это видит', () => {
  const dir = bareProject(); const p = paths(dir);
  assert.equal(acquireLock(p, { id: '20261002-1000' }), true);
  try {
    assert.equal(JSON.parse(fs.readFileSync(p.lock, 'utf8')).pull_lock, true);
    assert.equal(currentRun(p).pullLock, true);
  } finally { releaseLock(p); }
});

const fakeRunner = () => spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)', 'mcfly', 'run'], { stdio: 'ignore' });

test('0.5.4: во время прогона нового кода цикл читает: «запусти» сразу получает «идёт прогон»', async () => {
  const dir = bareProject(); const p = paths(dir); const clock = fakeClock();
  const runner = fakeRunner();
  fs.writeFileSync(p.lock, JSON.stringify({ pid: runner.pid, at: new Date(2026, 9, 2, 9, 5).toISOString(), id: '20261002-0905', pull_lock: true }));
  const tg = fakeTg({ clock, updates: [msg(3, 'запусти')] });
  const started = [];
  try { await pollAnswers({ projectDir: dir, cfg: tgCfg, p, telegram: tg, log: () => {}, clock, sleep: fakeSleep(clock), durationMs: 30_000, startRun: (d) => started.push(d) }); } finally { runner.kill(); }
  assert.deepEqual(started, []);
  assert.match(tg.sent[0], /⏳ Идёт прогон 20261002-0905 с 09:05/);
});

test('0.5.4: прогон старого кода (лок без pull_lock) — цикл не читает до его конца, потом читает', async () => {
  const dir = bareProject(); const p = paths(dir); const clock = fakeClock();
  const runner = fakeRunner();
  fs.writeFileSync(p.lock, JSON.stringify({ pid: runner.pid, at: new Date().toISOString(), id: '20261002-0200' }));
  const tg = fakeTg({ clock, updates: [msg(4, 'Q1: да')] });
  const t0 = clock(); let firstPollAt = null;
  const orig = tg.getUpdates; tg.getUpdates = async (o, t) => { firstPollAt ??= clock(); return orig(o, t); };
  const lines = []; let pauses = 0;
  // третья пауза — прогон закончился (лок снят)
  const sleep = async (ms) => { pauses += 1; clock.advance(ms); if (pauses === 3) fs.unlinkSync(p.lock); };
  try { await pollAnswers({ projectDir: dir, cfg: tgCfg, p, telegram: tg, log: (s) => lines.push(s), clock, sleep, durationMs: 300_000 }); } finally { runner.kill(); }
  assert.equal(lines.filter((l) => /старой версии/.test(l)).length, 1, 'одна строка на всё ожидание');
  assert.ok(tg.polls.length >= 1, 'после конца прогона опрос пошёл');
  assert.equal(tg.polls[0].offset, 0);
  assert.ok(firstPollAt - t0 >= 90_000, 'пока шёл старый прогон (три паузы по 30 с), getUpdates не вызывался');
  assert.match(tg.sent[0], /Q1/);
});

test('0.5.4: Telegram не настроен — цикл сразу выходит', async () => {
  const dir = bareProject(); const p = paths(dir); const clock = fakeClock(); const t0 = clock();
  const lines = [];
  await pollAnswers({ projectDir: dir, cfg: { ...cfg, telegram: { chat_id: '', token_env: 'MCFLY_TEST_TG' } }, p, log: (s) => lines.push(s), clock, sleep: fakeSleep(clock), durationMs: 570_000 });
  assert.equal(clock(), t0); assert.match(lines[0], /не настроен/);
});

test('0.5.6: сбой применения сообщения — offset всё равно сохранён, повторного применения нет, человеку предупреждение', async () => {
  const dir = bareProject(); const p = paths(dir);
  const data = loadQuestions(p); addQuestion(data, { category: 'spec', text: 'x', defaultAnswer: 'y' }, cfg); saveQuestions(p, data);
  fs.rmSync(p.answers); fs.mkdirSync(p.answers); // запись в answers.md упадёт (EISDIR)
  const tg = fakeTg({ updates: [msg(7, 'Q1: b')] });
  const lines = [];
  await pullAnswers({ projectDir: dir, cfg: tgCfg, p, telegram: tg, log: (s) => lines.push(s), startRun: () => {} });
  assert.equal(loadState(p).telegram_offset, 8, 'offset сдвинут — сообщение не будет применяться каждые 12 с');
  assert.match(tg.sent.join('\n'), /⚠️/, 'человек узнаёт, что сообщение не применено');
  const again = await pullAnswers({ projectDir: dir, cfg: tgCfg, p, telegram: tg, log: () => {}, startRun: () => {} });
  assert.equal(again.messages.length, 0);
});
