import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseConfig } from '../src/config.js';
import { paths } from '../src/state.js';
import { readMetrics } from '../src/metrics.js';
import { acquireLock, releaseLock } from '../src/runner.js';
import { callbackText } from '../src/telegram.js';
import { parseMessage, applyMessages } from '../src/answers.js';
import { pullAnswers } from '../src/pull.js';
import { buildContext } from '../src/context.js';
import { sendView, mainKeyboard, botCommands, BOT_COMMANDS } from '../src/overview.js';
import { noticesPath } from '../src/notices.js';
import {
  actionErrors, getAction, issueCode, takeCode, CODE_TTL_MS, handleActionMessage, execAction, prepareAction,
  acquireActionLock, releaseActionLock, currentAction, resultLines, offerKeyboard, actionLockPath,
} from '../src/actions.js';
import { cfg, bareProject } from './helpers.js';
import { MCFLY_ROOT } from '../src/prompt.js';

const withActions = (actions, extra = {}) => ({ ...cfg, ...extra, actions });
const deploy = { title: '🚀 Выкатить', describe: 'выкат main', run: 'echo собираю; echo "@@ выкачено abc"; echo "@@ адреса 200"', followups: ['rollback'] };
const rollback = { title: '↩️ Откатить', run: 'echo откат' };
const recorder = () => { const sent = []; const send = async (text, keyboard = []) => { sent.push({ text, keyboard }); }; return { sent, send }; };

test('0.6.0: раздел actions — проверка конфигурации', () => {
  assert.deepEqual(actionErrors(undefined), []);
  assert.deepEqual(actionErrors({ deploy, rollback }), []);
  const errs = actionErrors({ 'Bad_Id': { title: 'x', run: 'y' }, noRun: { title: 'x' }, d: { title: 'x', run: 'y', followups: ['nope'], confirm: 'да', timeout_minutes: 0 } });
  assert.ok(errs.some((e) => /actions\.Bad_Id: идентификатор/.test(e)));
  assert.ok(errs.some((e) => /actions\.noRun: идентификатор/.test(e)), 'заглавные буквы в идентификаторе запрещены');
  assert.ok(errs.some((e) => /actions\.noRun\.run: обязательная команда/.test(e)));
  assert.ok(errs.some((e) => /followups: нет действия «nope»/.test(e)));
  assert.ok(errs.some((e) => /confirm: true или false/.test(e)));
  assert.ok(errs.some((e) => /timeout_minutes: больше 0/.test(e)));
  assert.throws(() => parseConfig('project: x\nactions:\n  d:\n    title: t\n'), /actions\.d\.run/);
  const c = parseConfig('project: x\nactions:\n  status:\n    title: Сервер\n    run: echo ok\n    confirm: false\n');
  const a = getAction(c, 'status');
  assert.equal(a.confirm, false); assert.equal(a.during_run, false); assert.equal(a.timeout_minutes, 60); assert.deepEqual(a.followups, []);
  assert.equal(getAction(c, 'nope'), null);
});

test('0.6.0: кнопки ac/ax/an превращаются в текст команды, текст — в тип действия', () => {
  assert.equal(callbackText('ac:deploy'), 'действие deploy');
  assert.equal(callbackText('ax:deploy:a1b2c3'), 'действие deploy да a1b2c3');
  assert.equal(callbackText('an:deploy'), 'действие deploy отмена');
  assert.equal(callbackText('ax:deploy'), null, 'без кода подтверждения кнопка ничего не значит');
  assert.deepEqual(parseMessage('🛠 Действия'), { type: 'actions' });
  assert.deepEqual(parseMessage('/actions'), { type: 'actions' });
  assert.deepEqual(parseMessage('действие deploy'), { type: 'action', id: 'deploy' });
  assert.deepEqual(parseMessage('действие deploy да a1b2c3'), { type: 'actionYes', id: 'deploy', code: 'a1b2c3' });
  assert.deepEqual(parseMessage('действие deploy отмена'), { type: 'actionNo', id: 'deploy' });
  assert.equal(parseMessage('действие deploy потом').type, 'note', 'прочий текст — заметка');
  const dir = bareProject(); const p = paths(dir);
  assert.deepEqual(applyMessages(p, [{ text: 'действие deploy' }, { text: '🛠 Действия' }]), [], 'действия не пишутся в answers.md и не дают подтверждений');
  assert.doesNotMatch(fs.readFileSync(p.answers, 'utf8'), /действие/);
});

test('0.6.0: код подтверждения одноразовый, привязан к действию и живёт 30 минут', () => {
  const dir = bareProject(); const p = paths(dir); const t0 = new Date(Date.UTC(2026, 9, 24, 10, 0));
  const code = issueCode(p, 'deploy', t0);
  assert.match(code, /^[0-9a-f]{6}$/);
  assert.equal(takeCode(p, 'rollback', code, t0), false, 'код другого действия не подходит');
  assert.equal(takeCode(p, 'deploy', code, t0), true);
  assert.equal(takeCode(p, 'deploy', code, t0), false, 'второй раз не срабатывает');
  const old = issueCode(p, 'deploy', t0);
  assert.equal(takeCode(p, 'deploy', old, new Date(t0.getTime() + CODE_TTL_MS + 1000)), false, 'устаревший код отклонён');
});

test('0.6.0: нажатие — описание и «Да» с кодом; «Да» запускает exec; повтор старого «Да» отклоняется', async () => {
  const dir = bareProject(); const p = paths(dir); const c = withActions({ deploy, rollback });
  const { sent, send } = recorder(); const spawned = [];
  const spawn = (kind, id) => spawned.push(`${kind}:${id}`);
  await handleActionMessage({ parsed: { type: 'action', id: 'deploy' }, p, cfg: c, send, spawn });
  assert.match(sent[0].text, /Что будет сделано: выкат main/);
  const yes = sent[0].keyboard[0][0].callback_data; assert.match(yes, /^ax:deploy:[0-9a-f]{6}$/);
  assert.equal(sent[0].keyboard[0][1].callback_data, 'an:deploy');
  assert.deepEqual(spawned, [], 'до подтверждения ничего не запущено');
  const parsedYes = parseMessage(callbackText(yes));
  await handleActionMessage({ parsed: parsedYes, p, cfg: c, send, spawn });
  assert.deepEqual(spawned, ['exec:deploy']); assert.match(sent[1].text, /▶️ Начинаю/);
  await handleActionMessage({ parsed: parsedYes, p, cfg: c, send, spawn });
  assert.deepEqual(spawned, ['exec:deploy'], 'старое «Да» второй раз не запускает');
  assert.match(sent[2].text, /устарело или уже использовано/);
  await handleActionMessage({ parsed: { type: 'actionNo', id: 'deploy' }, p, cfg: c, send, spawn });
  assert.match(sent[3].text, /Отменено/);
  await handleActionMessage({ parsed: { type: 'action', id: 'nope' }, p, cfg: c, send, spawn });
  assert.match(sent[4].text, /не настроено/);
});

test('0.6.0: без подтверждения — сразу exec; с prepare — подготовка в фоне', async () => {
  const dir = bareProject(); const p = paths(dir);
  const c = withActions({ status: { title: 'Сервер', run: 'echo ok', confirm: false }, evalx: { title: 'Eval', run: 'echo run', prepare: 'echo оценка' } });
  const { sent, send } = recorder(); const spawned = [];
  await handleActionMessage({ parsed: { type: 'action', id: 'status' }, p, cfg: c, send, spawn: (k, id) => spawned.push(`${k}:${id}`) });
  await handleActionMessage({ parsed: { type: 'action', id: 'evalx' }, p, cfg: c, send, spawn: (k, id) => spawned.push(`${k}:${id}`) });
  assert.deepEqual(spawned, ['exec:status', 'prepare:evalx']);
  assert.match(sent[1].text, /Готовлю/);
});

test('0.6.0: во время прогона команды и во время другого действия «Да» не запускает', async () => {
  const dir = bareProject(); const p = paths(dir); const c = withActions({ deploy, rollback, free: { title: 'Чтение', run: 'echo', during_run: true } });
  const { sent, send } = recorder(); const spawned = [];
  const lock = acquireLock(p, 'r1');
  try {
    const code = issueCode(p, 'deploy');
    await handleActionMessage({ parsed: { type: 'actionYes', id: 'deploy', code }, p, cfg: c, send, spawn: (k, id) => spawned.push(id) });
    assert.match(sent[0].text, /Идёт прогон команды/); assert.deepEqual(spawned, []);
    assert.equal(takeCode(p, 'deploy', code), true, 'код не сгорел: после прогона можно нажать снова');
    const code2 = issueCode(p, 'free');
    await handleActionMessage({ parsed: { type: 'actionYes', id: 'free', code: code2 }, p, cfg: c, send, spawn: (k, id) => spawned.push(id) });
    assert.deepEqual(spawned, ['free'], 'during_run: true — можно и во время прогона');
  } finally { releaseLock(p, lock); }
  assert.ok(acquireActionLock(p, getAction(c, 'deploy')));
  try {
    assert.equal(currentAction(p).id, 'deploy');
    await handleActionMessage({ parsed: { type: 'action', id: 'rollback' }, p, cfg: c, send, spawn: () => {} });
    assert.match(sent.at(-1).text, /Идёт действие «🚀 Выкатить»/);
  } finally { releaseActionLock(p); }
  assert.equal(currentAction(p), null);
  fs.writeFileSync(actionLockPath(p), JSON.stringify({ pid: 999999, id: 'deploy', since: new Date().toISOString() }));
  assert.equal(currentAction(p), null, 'брошенная блокировка (процесса нет) не мешает');
  assert.ok(acquireActionLock(p, getAction(c, 'rollback'))); releaseActionLock(p);
});

test('0.6.0: exec — журнал, итог по строкам «@@», кнопки followups, запись в metrics', async () => {
  const dir = bareProject(); const p = paths(dir); const c = withActions({ deploy, rollback });
  const { sent, send } = recorder();
  const r = await execAction({ p, cfg: c, id: 'deploy', send });
  assert.equal(r.status, 'ok');
  assert.match(sent[0].text, /✅ <b>🚀 Выкатить<\/b> — готово/);
  assert.match(sent[0].text, /выкачено abc\nадреса 200/); assert.doesNotMatch(sent[0].text, /собираю/);
  assert.deepEqual(sent[0].keyboard, [[{ text: '↩️ Откатить', callback_data: 'ac:rollback' }]]);
  const logs = fs.readdirSync(path.join(p.logs, 'actions'));
  assert.equal(logs.length, 1); assert.match(fs.readFileSync(path.join(p.logs, 'actions', logs[0]), 'utf8'), /собираю/);
  const m = readMetrics(p).filter((x) => x.type === 'action');
  assert.equal(m.length, 1); assert.equal(m[0].id, 'deploy'); assert.equal(m[0].status, 'ok');
  assert.equal(currentAction(p), null, 'блокировка снята');
});

test('0.6.0: exec — ошибка с хвостом вывода, предел времени, итог в очередь без связи', async () => {
  const dir = bareProject(); const p = paths(dir);
  const c = withActions({ bad: { title: 'Плохое', run: 'for i in $(seq 1 30); do echo строка$i; done; echo "<b>" >&2; exit 3' }, slow: { title: 'Долгое', run: 'sleep 30', timeout_minutes: 0.005 } });
  const { sent, send } = recorder();
  const bad = await execAction({ p, cfg: c, id: 'bad', send });
  assert.equal(bad.status, 'error'); assert.equal(bad.code, 3);
  assert.match(sent[0].text, /❌ <b>Плохое<\/b> — ошибка \(код 3\)/);
  assert.match(sent[0].text, /строка30/); assert.doesNotMatch(sent[0].text, /строка10\n/, 'только хвост');
  assert.match(sent[0].text, /&lt;b&gt;/, 'вывод экранирован');
  const t = Date.now();
  const slow = await execAction({ p, cfg: c, id: 'slow', send });
  assert.equal(slow.status, 'timeout'); assert.ok(Date.now() - t < 15_000);
  assert.match(sent[1].text, /⏱ <b>Долгое<\/b> — прервано/);
  await execAction({ p, cfg: c, id: 'bad', send: async () => { throw new Error('fetch failed'); } });
  assert.match(fs.readFileSync(noticesPath(p), 'utf8'), /Плохое/, 'итог не потерян');
});

test('0.6.0: exec во время прогона команды не выполняет команду', async () => {
  const dir = bareProject(); const p = paths(dir); const marker = path.join(dir, 'ran');
  const c = withActions({ deploy: { title: 'Выкат', run: `touch ${marker}` } });
  const { sent, send } = recorder();
  const lock = acquireLock(p, 'r1');
  try { assert.equal((await execAction({ p, cfg: c, id: 'deploy', send })).status, 'busy'); } finally { releaseLock(p, lock); }
  assert.equal(fs.existsSync(marker), false); assert.match(sent[0].text, /Идёт прогон/);
});

test('0.6.0: prepare — вывод и «Да» с кодом; сбой подготовки — без кнопки', async () => {
  const dir = bareProject(); const p = paths(dir);
  const c = withActions({ ev: { title: 'Eval', run: 'echo', prepare: 'echo "@@ оценка ~827568"' }, bad: { title: 'Плохое', run: 'echo', prepare: 'echo нет сети; exit 2' } });
  const { sent, send } = recorder();
  assert.equal((await prepareAction({ p, cfg: c, id: 'ev', send })).status, 'ok');
  assert.match(sent[0].text, /оценка ~827568/); assert.match(sent[0].keyboard[0][0].callback_data, /^ax:ev:/);
  assert.equal((await prepareAction({ p, cfg: c, id: 'bad', send })).status, 'error');
  assert.match(sent[1].text, /Подготовка «Плохое» не удалась \(код 2\)/); assert.deepEqual(sent[1].keyboard, []);
});

test('0.6.0: resultLines и offerKeyboard', () => {
  assert.deepEqual(resultLines(['a', '@@ x', 'b', '@@ y']), ['x', 'y']);
  assert.deepEqual(resultLines(['', 'a', 'b']), ['a', 'b']);
  const dir = bareProject(); const p = paths(dir);
  const c = withActions({ yes: { title: 'Да', run: 'x', offer: 'exit 0' }, no: { title: 'Нет', run: 'x', offer: 'exit 1' }, none: { title: 'Без', run: 'x' }, slow: { title: 'Медленно', run: 'x', offer: 'sleep 5' } });
  assert.deepEqual(offerKeyboard(p, c, { timeoutMs: 500 }), [[{ text: 'Да', callback_data: 'ac:yes' }]]);
});

test('0.6.0: «где мы» с действиями — кнопки «Можно сделать», клавиатура и меню с «🛠 Действия»; список действий', async () => {
  const dir = bareProject(); const p = paths(dir); const c = withActions({ deploy, rollback });
  const sent = [];
  const tg = { async sendMessage(chatId, text, opts) { sent.push({ text, opts }); return []; } };
  await sendView(tg, '42', 'status', p, c, { offerKeyboard: () => [[{ text: '🚀 Выкатить', callback_data: 'ac:deploy' }]] });
  assert.match(sent.at(-1).text, /Можно сделать кнопкой/); assert.equal(sent.at(-1).opts.keyboard[0][0].callback_data, 'ac:deploy');
  assert.deepEqual(sent[0].opts.replyKeyboard.at(-1), [{ text: '🛠 Действия' }]);
  assert.deepEqual(mainKeyboard(cfg).length, 2, 'без действий клавиатура прежняя');
  assert.equal(botCommands(cfg), BOT_COMMANDS); assert.ok(botCommands(c).some((x) => x.command === 'actions'));
  const r = recorder();
  await handleActionMessage({ parsed: { type: 'actions' }, p, cfg: c, send: r.send, spawn: () => {} });
  assert.deepEqual(r.sent[0].keyboard.map((row) => row[0].callback_data), ['ac:deploy', 'ac:rollback']);
  assert.match(buildContext(p, c), /кнопка «<название>» в боте/);
});

test('0.6.0: кнопка из Telegram доходит до действия в том же опросе', async () => {
  const dir = bareProject(); const p = paths(dir);
  process.env.MCFLY_TEST_TG_A = 'T';
  const c = withActions({ status: { title: 'Сервер', run: 'echo ok', confirm: false } }, { telegram: { chat_id: '42', token_env: 'MCFLY_TEST_TG_A' } });
  const sent = []; const started = [];
  const tg = { async getUpdates() { return [{ update_id: 5, callback_query: { id: 'cb', data: 'ac:status', message: { message_id: 1, chat: { id: 42 }, date: 1700000000 } } }]; },
    async sendMessage(chatId, text, opts) { sent.push({ text, opts }); return []; }, async answerCallbackQuery() { return true; } };
  await pullAnswers({ projectDir: dir, cfg: c, p, telegram: tg, log: () => {}, startAction: (k, id) => started.push(`${k}:${id}`) });
  assert.deepEqual(started, ['exec:status']); assert.match(sent.at(-1).text, /Сервер — итог придёт/);
  const other = { ...tg, async getUpdates() { return [{ update_id: 6, callback_query: { id: 'cb', data: 'ac:status', message: { message_id: 1, chat: { id: 777 }, date: 1700000000 } } }]; } };
  await pullAnswers({ projectDir: dir, cfg: c, p, telegram: other, log: () => {}, startAction: (k, id) => started.push(id) });
  assert.deepEqual(started, ['exec:status'], 'кнопка из чужого чата игнорируется');
});

test('0.6.0: mcfly action в прогоне команды запрещён', () => {
  const dir = bareProject();
  fs.writeFileSync(path.join(dir, 'mcfly', 'config.yaml'), `project: demo\nactions:\n  hi:\n    title: Привет\n    run: touch ${path.join(dir, 'ran')}\n    confirm: false\n`);
  const bin = path.join(MCFLY_ROOT, 'bin', 'mcfly');
  const inRun = spawnSync(process.execPath, [bin, 'action', 'run', 'hi', '--project', dir], { encoding: 'utf8', env: { ...process.env, MCFLY_RUN_ID: 'r1' } });
  assert.equal(inRun.status, 1); assert.match(inRun.stderr, /в прогоне команды mcfly action запрещён/);
  assert.equal(fs.existsSync(path.join(dir, 'ran')), false);
  const env = { ...process.env }; delete env.MCFLY_RUN_ID; delete env.MCFLY_TELEGRAM_TOKEN;
  const own = spawnSync(process.execPath, [bin, 'action', 'run', 'hi', '--project', dir], { encoding: 'utf8', env });
  assert.equal(own.status, 0, own.stderr); assert.equal(fs.existsSync(path.join(dir, 'ran')), true);
});
