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
  trustActions, isTrusted, actionsDigest, issueTicket, takeTicket,
} from '../src/actions.js';
import { cfg, bareProject, tmpDir } from './helpers.js';
import { MCFLY_ROOT } from '../src/prompt.js';

process.env.MCFLY_TRUST_FILE = path.join(tmpDir('mcfly-trust-'), 'trusted.json');
/** Проект с подтверждённым разделом actions (как после mcfly action trust). */
function trustedProject(c) { const dir = bareProject(); const p = paths(dir); trustActions(p, c); return { dir, p }; }
const ticketFor = (p, c, id) => issueTicket(p, id, new Date(), actionsDigest(c, p.projectDir));

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
  const c = withActions({ deploy, rollback }); const { p } = trustedProject(c);
  const { sent, send } = recorder(); const spawned = [];
  const tickets = [];
  const spawn = (kind, id, ticket) => { spawned.push(`${kind}:${id}`); tickets.push(ticket); };
  await handleActionMessage({ parsed: { type: 'action', id: 'deploy' }, p, cfg: c, send, spawn });
  assert.match(sent[0].text, /Что будет сделано: выкат main/);
  const yes = sent[0].keyboard[0][0].callback_data; assert.match(yes, /^ax:deploy:[0-9a-f]{6}$/);
  assert.equal(sent[0].keyboard[0][1].callback_data, 'an:deploy');
  assert.deepEqual(spawned, [], 'до подтверждения ничего не запущено');
  const parsedYes = parseMessage(callbackText(yes));
  await handleActionMessage({ parsed: parsedYes, p, cfg: c, send, spawn });
  assert.deepEqual(spawned, ['exec:deploy']); assert.match(sent[1].text, /▶️ Начинаю/);
  assert.match(tickets[0], /^[0-9a-f]{32}$/, 'процесс получает пропуск');
  assert.equal(takeTicket(p, 'deploy', tickets[0], new Date(), actionsDigest(c, p.projectDir)), true);
  await handleActionMessage({ parsed: parsedYes, p, cfg: c, send, spawn });
  assert.deepEqual(spawned, ['exec:deploy'], 'старое «Да» второй раз не запускает');
  assert.match(sent[2].text, /устарело или уже использовано/);
  await handleActionMessage({ parsed: { type: 'actionNo', id: 'deploy' }, p, cfg: c, send, spawn });
  assert.match(sent[3].text, /Отменено/);
  await handleActionMessage({ parsed: { type: 'action', id: 'nope' }, p, cfg: c, send, spawn });
  assert.match(sent[4].text, /не настроено/);
});

test('0.6.0: без подтверждения — сразу exec; с prepare — подготовка в фоне', async () => {
  const c = withActions({ status: { title: 'Сервер', run: 'echo ok', confirm: false }, evalx: { title: 'Eval', run: 'echo run', prepare: 'echo оценка' } });
  const { p } = trustedProject(c);
  const { sent, send } = recorder(); const spawned = [];
  await handleActionMessage({ parsed: { type: 'action', id: 'status' }, p, cfg: c, send, spawn: (k, id) => spawned.push(`${k}:${id}`) });
  await handleActionMessage({ parsed: { type: 'action', id: 'evalx' }, p, cfg: c, send, spawn: (k, id) => spawned.push(`${k}:${id}`) });
  assert.deepEqual(spawned, ['exec:status', 'prepare:evalx']);
  assert.match(sent[1].text, /Готовлю/);
});

test('0.6.0: во время прогона команды и во время другого действия «Да» не запускает', async () => {
  const c = withActions({ deploy, rollback, free: { title: 'Чтение', run: 'echo', during_run: true } }); const { p } = trustedProject(c);
  const dg = actionsDigest(c, p.projectDir);
  const { sent, send } = recorder(); const spawned = [];
  const lock = acquireLock(p, 'r1');
  try {
    const code = issueCode(p, 'deploy', new Date(), dg);
    await handleActionMessage({ parsed: { type: 'actionYes', id: 'deploy', code }, p, cfg: c, send, spawn: (k, id) => spawned.push(id) });
    assert.match(sent[0].text, /Идёт прогон команды/); assert.deepEqual(spawned, []);
    assert.equal(takeCode(p, 'deploy', code, new Date(), dg), true, 'код не сгорел: после прогона можно нажать снова');
    const code2 = issueCode(p, 'free', new Date(), dg);
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
  const c = withActions({ deploy, rollback }); const { p } = trustedProject(c);
  const { sent, send } = recorder();
  const r = await execAction({ p, cfg: c, id: 'deploy', send, ticket: ticketFor(p, c, 'deploy') });
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
  const c = withActions({ bad: { title: 'Плохое', run: 'for i in $(seq 1 30); do echo строка$i; done; echo "<b>" >&2; exit 3' }, slow: { title: 'Долгое', run: 'sleep 30', timeout_minutes: 0.005 } });
  const { p } = trustedProject(c);
  const { sent, send } = recorder();
  const bad = await execAction({ p, cfg: c, id: 'bad', send, ticket: ticketFor(p, c, 'bad') });
  assert.equal(bad.status, 'error'); assert.equal(bad.code, 3);
  assert.match(sent[0].text, /❌ <b>Плохое<\/b> — ошибка \(код 3\)/);
  assert.match(sent[0].text, /строка30/); assert.doesNotMatch(sent[0].text, /строка10\n/, 'только хвост');
  assert.match(sent[0].text, /&lt;b&gt;/, 'вывод экранирован');
  const t = Date.now();
  const slow = await execAction({ p, cfg: c, id: 'slow', send, ticket: ticketFor(p, c, 'slow') });
  assert.equal(slow.status, 'timeout'); assert.ok(Date.now() - t < 15_000);
  assert.match(sent[1].text, /⏱ <b>Долгое<\/b> — прервано/);
  await execAction({ p, cfg: c, id: 'bad', ticket: ticketFor(p, c, 'bad'), send: async () => { throw new Error('fetch failed'); } });
  assert.match(fs.readFileSync(noticesPath(p), 'utf8'), /Плохое/, 'итог не потерян');
});

test('0.6.0: exec во время прогона команды не выполняет команду', async () => {
  const dir0 = tmpDir(); const marker = path.join(dir0, 'ran');
  const c = withActions({ deploy: { title: 'Выкат', run: `touch ${marker}` } }); const { p } = trustedProject(c);
  const { sent, send } = recorder();
  const lock = acquireLock(p, 'r1');
  try { assert.equal((await execAction({ p, cfg: c, id: 'deploy', send, ticket: ticketFor(p, c, 'deploy') })).status, 'busy'); } finally { releaseLock(p, lock); }
  assert.equal(fs.existsSync(marker), false); assert.match(sent[0].text, /Идёт прогон/);
});

test('0.6.0: prepare — вывод и «Да» с кодом; сбой подготовки — без кнопки', async () => {
  const c = withActions({ ev: { title: 'Eval', run: 'echo', prepare: 'echo "@@ оценка ~827568"' }, bad: { title: 'Плохое', run: 'echo', prepare: 'echo нет сети; exit 2' } });
  const { p } = trustedProject(c);
  const { sent, send } = recorder();
  assert.equal((await prepareAction({ p, cfg: c, id: 'ev', send, ticket: ticketFor(p, c, 'ev') })).status, 'ok');
  assert.match(sent[0].text, /оценка ~827568/); assert.match(sent[0].keyboard[0][0].callback_data, /^ax:ev:/);
  assert.equal((await prepareAction({ p, cfg: c, id: 'bad', send, ticket: ticketFor(p, c, 'bad') })).status, 'error');
  assert.match(sent[1].text, /Подготовка «Плохое» не удалась \(код 2\)/); assert.deepEqual(sent[1].keyboard, []);
});

test('0.6.0: resultLines и offerKeyboard', async () => {
  assert.deepEqual(resultLines(['a', '@@ x', 'b', '@@ y']), ['x', 'y']);
  assert.deepEqual(resultLines(['', 'a', 'b']), ['a', 'b']);
  const c = withActions({ yes: { title: 'Да', run: 'x', offer: 'exit 0' }, no: { title: 'Нет', run: 'x', offer: 'exit 1' }, none: { title: 'Без', run: 'x' }, slow: { title: 'Медленно', run: 'x', offer: 'sleep 5' } });
  const { p } = trustedProject(c);
  const t0 = Date.now();
  assert.deepEqual(await offerKeyboard(p, c, { timeoutMs: 500 }), [[{ text: 'Да', callback_data: 'ac:yes' }]]);
  assert.ok(Date.now() - t0 < 3_000, 'offer параллельно и с пределом');
});

test('0.6.0: «где мы» с действиями — кнопки «Можно сделать», клавиатура и меню с «🛠 Действия»; список действий', async () => {
  const c = withActions({ deploy, rollback }); const { p } = trustedProject(c);
  const sent = [];
  const tg = { async sendMessage(chatId, text, opts) { sent.push({ text, opts }); return []; } };
  await sendView(tg, '42', 'status', p, c, { offerKeyboard: () => [[{ text: '🚀 Выкатить', callback_data: 'ac:deploy' }]] });
  assert.match(sent.at(-1).text, /Можно сделать кнопкой/); assert.equal(sent.at(-1).opts.keyboard[0][0].callback_data, 'ac:deploy');
  assert.deepEqual(sent[0].opts.replyKeyboard.at(-1), [{ text: '💡 Предложения' }, { text: '🛠 Действия' }]);
  assert.deepEqual(mainKeyboard({ ...cfg, ideas: { ...cfg.ideas, enabled: false } }).length, 2, 'без действий и предложений клавиатура прежняя');
  assert.equal(botCommands(cfg), BOT_COMMANDS); assert.ok(botCommands(c).some((x) => x.command === 'actions'));
  const r = recorder();
  await handleActionMessage({ parsed: { type: 'actions' }, p, cfg: c, send: r.send, spawn: () => {} });
  assert.deepEqual(r.sent[0].keyboard.map((row) => row[0].callback_data), ['ac:deploy', 'ac:rollback']);
  assert.match(buildContext(p, c), /кнопка «<название>» в боте/);
});

test('0.6.0: кнопка из Telegram доходит до действия в том же опросе; только от владельца', async () => {
  process.env.MCFLY_TEST_TG_A = 'T';
  const c = withActions({ status: { title: 'Сервер', run: 'echo ok', confirm: false } }, { telegram: { chat_id: '42', token_env: 'MCFLY_TEST_TG_A' } });
  const { dir, p } = trustedProject(c);
  const cb = (uid, data, from = 42, chat = 42) => ({ update_id: uid, callback_query: { id: 'cb', data, from: { id: from }, message: { message_id: 1, chat: { id: chat }, date: 1700000000 } } });
  const sent = []; const started = [];
  const tg = { async getUpdates() { return [cb(5, 'ac:status')]; },
    async sendMessage(chatId, text, opts) { sent.push({ text, opts }); return []; }, async answerCallbackQuery() { return true; } };
  await pullAnswers({ projectDir: dir, cfg: c, p, telegram: tg, log: () => {}, startAction: (k, id) => started.push(`${k}:${id}`) });
  assert.deepEqual(started, ['exec:status']); assert.match(sent.at(-1).text, /Сервер — итог придёт/);
  const other = { ...tg, async getUpdates() { return [cb(6, 'ac:status', 777, 777)]; } };
  await pullAnswers({ projectDir: dir, cfg: c, p, telegram: other, log: () => {}, startAction: (k, id) => started.push(id) });
  assert.deepEqual(started, ['exec:status'], 'кнопка из чужого чата игнорируется');
  const stranger = { ...tg, async getUpdates() { return [cb(7, 'ac:status', 555, 42)]; } };
  await pullAnswers({ projectDir: dir, cfg: c, p, telegram: stranger, log: () => {}, startAction: (k, id) => started.push(id) });
  assert.deepEqual(started, ['exec:status'], 'чужой человек в том же чате действие не запускает');
  assert.match(sent.at(-1).text, /только от владельца/);
  const group = { ...c, telegram: { chat_id: '-100', token_env: 'MCFLY_TEST_TG_A' } };
  const inGroup = { ...tg, async getUpdates() { return [cb(8, 'ac:status', 42, -100)]; } };
  await pullAnswers({ projectDir: dir, cfg: group, p, telegram: inGroup, log: () => {}, startAction: (k, id) => started.push(id) });
  assert.deepEqual(started, ['exec:status']); assert.match(sent.at(-1).text, /owner_id/, 'в группе без owner_id действия выключены');
});

test('0.6.0: раздел actions без подтверждения владельца или после правки — кнопки выключены, команды не выполняются', async () => {
  const dir0 = tmpDir(); const marker = path.join(dir0, 'ran');
  const c = withActions({ hi: { title: 'Привет', run: `touch ${marker}`, offer: `touch ${marker}`, confirm: false } });
  const dir = bareProject(); const p = paths(dir);
  assert.equal(isTrusted(p, c), false);
  const { sent, send } = recorder(); const spawned = [];
  await handleActionMessage({ parsed: { type: 'action', id: 'hi' }, p, cfg: c, send, spawn: (k, id) => spawned.push(id) });
  await handleActionMessage({ parsed: { type: 'actions' }, p, cfg: c, send, spawn: (k, id) => spawned.push(id) });
  assert.deepEqual(spawned, []); assert.match(sent[0].text, /mcfly action trust/); assert.match(sent[1].text, /mcfly action trust/);
  assert.deepEqual(await offerKeyboard(p, c), [], 'offer не выполняется');
  trustActions(p, c);
  const t = ticketFor(p, c, 'hi');
  const changed = withActions({ hi: { ...c.actions.hi, run: `touch ${marker}; echo подмена` } });
  assert.equal(isTrusted(p, changed), false, 'правка команды снимает подтверждение');
  assert.equal((await execAction({ p, cfg: changed, id: 'hi', send, ticket: t })).status, 'untrusted');
  assert.equal(fs.existsSync(marker), false);
});

test('0.6.0: exec и prepare без пропуска (в обход кнопки) отклоняются; код «Да» не годится после правки команды', async () => {
  const dir0 = tmpDir(); const marker = path.join(dir0, 'ran');
  // команда ссылается на каталог, а не на файл: созданный файл не меняет сумму подтверждения
  const c = withActions({ hi: { title: 'Привет', run: `cd ${dir0} && touch ran`, prepare: `cd ${dir0} && touch ran` } }); const { p } = trustedProject(c);
  const { sent, send } = recorder();
  assert.equal((await execAction({ p, cfg: c, id: 'hi', send })).status, 'refused');
  assert.equal((await execAction({ p, cfg: c, id: 'hi', send, ticket: 'deadbeef' })).status, 'refused');
  assert.equal((await prepareAction({ p, cfg: c, id: 'hi', send })).status, 'refused');
  assert.equal(fs.existsSync(marker), false); assert.match(sent[0].text, /без подтверждения кнопкой отклонён/);
  const t = ticketFor(p, c, 'hi');
  assert.equal((await execAction({ p, cfg: c, id: 'hi', send, ticket: t })).status, 'ok'); assert.equal(fs.existsSync(marker), true);
  assert.equal((await execAction({ p, cfg: c, id: 'hi', send, ticket: t })).status, 'refused', 'пропуск одноразовый');
  const code = issueCode(p, 'hi', new Date(), actionsDigest(c, p.projectDir));
  const changed = withActions({ hi: { ...c.actions.hi, run: 'echo другое' } });
  assert.equal(takeCode(p, 'hi', code, new Date(), actionsDigest(changed, p.projectDir)), false);
});

test('0.6.0: mcfly action в прогоне команды запрещён', () => {
  const dir = bareProject();
  fs.writeFileSync(path.join(dir, 'mcfly', 'config.yaml'), `project: demo\nactions:\n  hi:\n    title: Привет\n    run: touch ${path.join(dir, 'ran')}\n    confirm: false\n`);
  const bin = path.join(MCFLY_ROOT, 'bin', 'mcfly');
  const inRun = spawnSync(process.execPath, [bin, 'action', 'run', 'hi', '--project', dir], { encoding: 'utf8', env: { ...process.env, MCFLY_RUN_ID: 'r1' } });
  assert.equal(inRun.status, 1); assert.match(inRun.stderr, /в прогоне команды mcfly action запрещён/);
  assert.equal(fs.existsSync(path.join(dir, 'ran')), false);
  const env = { ...process.env }; delete env.MCFLY_RUN_ID; delete env.MCFLY_TELEGRAM_TOKEN;
  const noTty = spawnSync(process.execPath, [bin, 'action', 'run', 'hi', '--yes', '--project', dir], { encoding: 'utf8', env });
  assert.equal(noTty.status, 1); assert.match(noTty.stderr, /только в терминале владельца/, 'без терминала (агент) run не работает');
  const trust = spawnSync(process.execPath, [bin, 'action', 'trust', '--project', dir], { encoding: 'utf8', env, input: 'да\n' });
  assert.equal(trust.status, 1); assert.match(trust.stderr, /только в терминале владельца/, 'trust без терминала не работает');
  const exec = spawnSync(process.execPath, [bin, 'action', 'exec', 'hi', '--project', dir], { encoding: 'utf8', env });
  assert.equal(exec.status, 1, 'exec без пропуска'); assert.equal(fs.existsSync(path.join(dir, 'ran')), false);
});

test('0.6.0: по таймауту гибнет вся группа процессов, даже потомок, игнорирующий SIGTERM', async () => {
  const dir0 = tmpDir(); const pidFile = path.join(dir0, 'pid');
  const { runCommand } = await import('../src/actions.js');
  const r = await runCommand(`(trap '' TERM; sleep 30) >/dev/null & echo $! > ${pidFile}; sleep 30`, { cwd: dir0, timeoutMs: 300 });
  assert.equal(r.timedOut, true);
  const pid = Number(fs.readFileSync(pidFile, 'utf8'));
  await new Promise((res) => setTimeout(res, 200));
  assert.throws(() => process.kill(pid, 0), 'сирота не осталась');
});

test('0.6.0: блокировка действия старше предела + 10 минут считается брошенной', () => {
  const dir = bareProject(); const p = paths(dir);
  const old = new Date(Date.now() - 2 * 3600_000).toISOString();
  fs.mkdirSync(p.logs, { recursive: true });
  fs.writeFileSync(actionLockPath(p), JSON.stringify({ pid: process.pid, id: 'deploy', since: old, max_ms: 45 * 60_000 }));
  assert.equal(currentAction(p), null);
  assert.ok(acquireActionLock(p, { id: 'x', title: 'X', timeout_minutes: 1 }));
  assert.equal(acquireActionLock(p, { id: 'y', title: 'Y', timeout_minutes: 1 }), false, 'живая блокировка держит');
  releaseActionLock(p); assert.equal(currentAction(p), null);
});

test('0.6.0: итог действия из очереди уходит с HTML; отклонённое Telegram (Bad Request) не держит очередь', async () => {
  const { enqueueNotice, flushNotices } = await import('../src/notices.js');
  const dir = bareProject(); const p = paths(dir);
  enqueueNotice(p, { text: '<b>bad</b>', html: true }); enqueueNotice(p, { text: '<b>итог</b>', html: true }); enqueueNotice(p, { text: 'обычное' });
  const got = []; let first = true;
  const n = await flushNotices(p, async (text, kb, o) => { if (first) { first = false; throw new Error('Telegram sendMessage: Bad Request: can\'t parse entities'); } got.push({ text, html: o.html }); });
  assert.equal(n, 2); assert.deepEqual(got.map((g) => g.html), [true, false]);
  assert.equal(fs.existsSync(noticesPath(p)), false, 'очередь пуста');
});

test('0.6.0: правка скрипта действия (и соседних файлов) снимает подтверждение', async () => {
  const { actionFiles } = await import('../src/actions.js');
  const bin = tmpDir('mcfly-scripts-'); const script = path.join(bin, 'deploy.sh'); const lib = path.join(bin, 'common.sh');
  fs.writeFileSync(script, 'echo ok\n'); fs.writeFileSync(lib, 'X=1\n'); fs.mkdirSync(path.join(bin, 'state')); fs.writeFileSync(path.join(bin, 'state', 'last'), 'a');
  const c = withActions({ d: { title: 'Выкат', run: `bash ${script} --plan` } }); const { p } = trustedProject(c);
  assert.deepEqual(actionFiles(c, p.projectDir), [lib, script].sort(), 'файлы каталога скрипта, без подкаталога state');
  assert.equal(isTrusted(p, c), true);
  fs.writeFileSync(path.join(bin, 'state', 'last'), 'b'); assert.equal(isTrusted(p, c), true, 'состояние скрипта не влияет');
  fs.writeFileSync(lib, 'X=2\n'); assert.equal(isTrusted(p, c), false, 'правка соседнего файла снимает подтверждение');
  trustActions(p, c); fs.writeFileSync(script, 'echo подмена\n'); assert.equal(isTrusted(p, c), false);
});

test('0.6.2: скрипт по относительному пути внутри проекта тоже входит в подтверждение', async () => {
  const { actionFiles } = await import('../src/actions.js');
  const c = withActions({ d: { title: 'Выкат', run: 'bash scripts/deploy.sh --plan', prepare: 'bash ./scripts/deploy.sh' } });
  const dir = bareProject(); const p = paths(dir);
  fs.mkdirSync(path.join(dir, 'scripts')); fs.writeFileSync(path.join(dir, 'scripts', 'deploy.sh'), 'echo ok\n');
  trustActions(p, c);
  assert.deepEqual(actionFiles(c, dir), [path.join(dir, 'scripts', 'deploy.sh')]);
  fs.writeFileSync(path.join(dir, 'scripts', 'deploy.sh'), 'echo подмена\n');
  assert.equal(isTrusted(p, c), false, 'правка скрипта в репозитории снимает подтверждение');
});

test('0.6.2: «статус» не владельца не запускает offer; неподтверждённые действия не трогают меню', async () => {
  const c = withActions({ deploy, rollback }); const { p } = trustedProject(c);
  let offered = 0; const sent = [];
  const tg = { async sendMessage(chatId, text, opts) { sent.push({ text, opts }); return []; } };
  await sendView(tg, '42', 'status', p, c, { offers: false, offerKeyboard: () => { offered += 1; return []; } });
  assert.equal(offered, 0);
  const { ensureBotMenu } = await import('../src/overview.js');
  const dir = bareProject(); const p2 = paths(dir); const calls = [];
  const tg2 = { async setMyCommands() { calls.push('menu'); }, async sendMessage() { calls.push('msg'); return []; } };
  assert.equal(await ensureBotMenu(p2, { ...c, telegram: { chat_id: '42' } }, tg2), false);
  assert.deepEqual(calls, [], 'пока не подтверждено — ни меню, ни объявления');
});

test('0.7.2: «Можно сделать кнопкой» — подпись по тому, спрашивает ли действие подтверждение', async () => {
  const backup = { title: '📦 Копия данных', run: 'echo ok', confirm: false };
  const c = withActions({ deploy, backup }); const { p } = trustedProject(c);
  const send = async (rows) => { const sent = []; await sendView({ async sendMessage(_, text, opts) { sent.push({ text, opts }); return []; } }, '42', 'status', p, c, { offerKeyboard: () => rows }); return sent.at(-1).text; };
  assert.equal(await send([[{ text: '📦 Копия данных', callback_data: 'ac:backup' }]]), '🛠 <b>Можно сделать кнопкой</b> — запускается сразу, итог придёт сообщением');
  assert.equal(await send([[{ text: '🚀 Выкатить', callback_data: 'ac:deploy' }]]), '🛠 <b>Можно сделать кнопкой</b> — сначала бот покажет, что будет сделано');
  assert.equal(await send([[{ text: '🚀 Выкатить', callback_data: 'ac:deploy' }], [{ text: '📦 Копия данных', callback_data: 'ac:backup' }]]), '🛠 <b>Можно сделать кнопкой</b> — где нужно, бот сначала покажет, что будет сделано');
});
