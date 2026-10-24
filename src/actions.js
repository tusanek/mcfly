import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { ensureDir, readJson, writeJson, fmtDuration, truncate, pad2, runId } from './util.js';
import { appendMetric } from './metrics.js';
import { enqueueNotice } from './notices.js';
import { currentRun } from './runner.js';
import { ensureVpn } from './vpn.js';
import { MCFLY_ROOT } from './prompt.js';
import { getAction, listActions, hasActions } from './action-config.js';

export { ACTION_ID_RE, ACTION_DEFAULTS, actionErrors, getAction, listActions, hasActions, parseActionText } from './action-config.js';

/**
 * Действия владельца из Telegram (0.6.0): выкат, откат, eval и другое, что раньше владелец запускал скриптом в терминале.
 * Список — раздел actions в mcfly/config.yaml: его правит только владелец, поэтому команда не может подсунуть кнопке свою команду.
 * Нажатие → «что будет сделано» (и вывод prepare) → «✅ Да, выполнить» с одноразовым кодом → отдельный процесс → итог в чат.
 */
export const CODE_TTL_MS = 30 * 60_000;
export const PREPARE_TIMEOUT_MS = 5 * 60_000;
export const OFFER_TIMEOUT_MS = 10_000;
const KILL_GRACE_MS = 10_000;
const TAIL_LINES = 20;
const RESULT_MAX = 3500;
const KEEP_LINES = 400;

// ---------- доверие: раздел actions подтверждён владельцем ----------
/**
 * config.yaml лежит в репозитории, и агент по ошибке может его поправить (offer выполняется при «где мы» без подтверждения).
 * Поэтому действия работают, только если сумма раздела actions совпадает с подтверждённой владельцем командой
 * mcfly action trust (только в терминале). Файл подтверждений — вне проекта. Защита от ошибки агента, не от злого умысла.
 */
export const trustFile = () => process.env.MCFLY_TRUST_FILE || path.join(os.homedir(), '.config', 'mcfly', 'trusted-actions.json');
const canonical = (v) => (Array.isArray(v) ? v.map(canonical) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canonical(v[k])])) : v);
/**
 * Файлы, от которых зависят команды: пути в run/prepare/offer (~/… или /…) и все файлы в их каталогах (без подкаталогов —
 * там обычно состояние скриптов). Правка скрипта, как и правка команды, снимает подтверждение.
 */
export function actionFiles(cfg) {
  const dirs = new Set(); const files = new Set();
  for (const a of Object.values(cfg.actions || {})) {
    for (const cmd of [a?.run, a?.prepare, a?.offer]) {
      for (const tok of String(cmd || '').match(/(?:~\/|\/)[^\s"';|&<>()]+/g) || []) {
        const f = tok.startsWith('~/') ? path.join(os.homedir(), tok.slice(2)) : tok;
        try { if (fs.statSync(f).isFile()) { files.add(f); dirs.add(path.dirname(f)); } } catch {}
      }
    }
  }
  for (const d of dirs) {
    try { for (const e of fs.readdirSync(d, { withFileTypes: true })) if (e.isFile()) files.add(path.join(d, e.name)); } catch {}
  }
  return [...files].sort();
}
export function actionsDigest(cfg) {
  const h = crypto.createHash('sha256').update(JSON.stringify(canonical(cfg.actions || {})));
  for (const f of actionFiles(cfg)) { h.update(`\0${f}\0`); try { h.update(fs.readFileSync(f)); } catch { h.update('нет файла'); } }
  return h.digest('hex');
}
export function isTrusted(p, cfg) { return readJson(trustFile(), {})?.[p.projectDir]?.digest === actionsDigest(cfg); }
export function trustActions(p, cfg, now = new Date()) {
  const file = trustFile(); ensureDir(path.dirname(file));
  const all = readJson(file, {}) || {};
  all[p.projectDir] = { digest: actionsDigest(cfg), at: now.toISOString(), actions: Object.keys(cfg.actions || {}) };
  writeJson(file, all);
}
export const UNTRUSTED_TEXT = '⚠️ Раздел actions в mcfly/config.yaml изменён и не подтверждён владельцем — кнопки выключены. Проверьте команды и подтвердите в терминале: mcfly action trust';

// ---------- одноразовые коды подтверждения и пропуски на запуск ----------
/** Пропуск: бот выдаёт его после «Да» (или нажатия действия без подтверждения) и передаёт процессу; exec/prepare без него не работают. */
export const TICKET_TTL_MS = 2 * 60_000;
const statePath = (p) => path.join(p.logs, 'actions-state.json');
/**
 * Чтение-изменение-запись файла кодов под короткой блокировкой: код пишет процесс подготовки, забирает задание answers —
 * без неё использованный код мог «воскреснуть» (подготовка записала бы прочитанную до этого копию).
 */
function withStateLock(p, fn) {
  ensureDir(p.logs);
  const lock = `${statePath(p)}.lock`;
  for (let i = 0; ; i++) {
    try { fs.closeSync(fs.openSync(lock, 'wx')); break; } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      try { if (Date.now() - fs.statSync(lock).mtimeMs > 5_000) { fs.unlinkSync(lock); continue; } } catch { continue; }
      if (i > 400) throw new Error('файл кодов действий занят');
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
    }
  }
  try { return fn(); } finally { try { fs.unlinkSync(lock); } catch {} }
}
function loadState(p) { const s = readJson(statePath(p), {}) || {}; return { codes: s.codes || {}, tickets: s.tickets || {} }; }
function saveState(p, st) {
  ensureDir(p.logs);
  // атомарно: код пишет процесс подготовки, читает задание answers
  const tmp = `${statePath(p)}.${process.pid}.tmp`; writeJson(tmp, st); fs.renameSync(tmp, statePath(p));
}
const fresh = (items, now, ttl) => Object.fromEntries(Object.entries(items).filter(([, c]) => now - new Date(c.at) < ttl));
function issue(p, kind, id, digest, now, bytes) { return withStateLock(p, () => issueLocked(p, kind, id, digest, now, bytes)); }
function issueLocked(p, kind, id, digest, now, bytes) {
  const st = loadState(p); st.codes = fresh(st.codes, now, CODE_TTL_MS); st.tickets = fresh(st.tickets, now, TICKET_TTL_MS);
  const key = crypto.randomBytes(bytes).toString('hex');
  st[kind][key] = { id, digest, at: now.toISOString() };
  saveState(p, st);
  return key;
}
function take(p, kind, id, key, digest, now) { return withStateLock(p, () => takeLocked(p, kind, id, key, digest, now)); }
function takeLocked(p, kind, id, key, digest, now) {
  const st = loadState(p); const all = st[kind];
  st.codes = fresh(st.codes, now, CODE_TTL_MS); st.tickets = fresh(st.tickets, now, TICKET_TTL_MS);
  const item = st[kind][key];
  // код выдан под этот текст раздела actions: команду поправили после показа «что будет сделано» — код не годится
  const ok = !!item && item.id === id && item.digest === digest;
  if (ok) delete st[kind][key];
  if (ok || Object.keys(st[kind]).length !== Object.keys(all).length) saveState(p, st);
  return ok;
}
/** Новый код подтверждения действия id (6 знаков hex, живёт CODE_TTL_MS, привязан к тексту раздела actions). */
export function issueCode(p, id, now = new Date(), digest = '') { return issue(p, 'codes', id, digest, now, 3); }
/** Забирает код: true, если он выдан для id под тот же текст actions и не устарел; повторно не сработает. */
export function takeCode(p, id, code, now = new Date(), digest = '') { return take(p, 'codes', id, code, digest, now); }
export function issueTicket(p, id, now = new Date(), digest = '') { return issue(p, 'tickets', id, digest, now, 16); }
export function takeTicket(p, id, ticket, now = new Date(), digest = '') { return !!ticket && take(p, 'tickets', id, ticket, digest, now); }

// ---------- блокировка: одно действие за раз ----------
export const actionLockPath = (p) => path.join(p.logs, '.action.lock');
const LOCK_GRACE_MS = 10 * 60_000;
function alive(pid) { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } }
/** Брошена: процесса нет или она старше предела действия + 10 минут (pid после перезагрузки мог достаться другому). */
function lockStale(lock, now = Date.now()) {
  if (!lock?.pid || !alive(lock.pid)) return true;
  return now - new Date(lock.since).getTime() > (lock.max_ms || 60 * 60_000) + LOCK_GRACE_MS;
}
/** Идущее действие { id, title, since, pid } или null (брошенная блокировка не считается). */
export function currentAction(p) {
  const lock = readJson(actionLockPath(p), null);
  if (!lock || lockStale(lock)) return null;
  return { ...lock, since: new Date(lock.since) };
}
/**
 * Блокировка «одно действие за раз»: содержимое пишется во временный файл и ставится link() — файл блокировки
 * никогда не бывает пустым. Брошенную снимаем, только если это всё ещё она (иначе снесли бы свежую чужую).
 */
export function acquireActionLock(p, a, now = new Date()) {
  ensureDir(p.logs);
  const file = actionLockPath(p);
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}`;
  fs.writeFileSync(tmp, JSON.stringify({ pid: process.pid, id: a.id, title: a.title, since: now.toISOString(), max_ms: a.timeout_minutes * 60_000 }));
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      try { fs.linkSync(tmp, file); return true; } catch (e) {
        if (e.code !== 'EEXIST') throw e;
        let raw = null; try { raw = fs.readFileSync(file, 'utf8'); } catch { continue; }
        let lock = null; try { lock = JSON.parse(raw); } catch {}
        if (lock && !lockStale(lock)) return false;
        try { if (fs.readFileSync(file, 'utf8') === raw) fs.unlinkSync(file); } catch {}
      }
    }
    return false;
  } finally { try { fs.unlinkSync(tmp); } catch {} }
}
export function releaseActionLock(p) {
  if (readJson(actionLockPath(p), null)?.pid === process.pid) { try { fs.unlinkSync(actionLockPath(p)); } catch {} }
}

const hm = (d) => `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
/** Почему действие сейчас нельзя начать, или null. */
export function blockReason(p, a) {
  const cur = currentAction(p);
  if (cur) return `⏳ Идёт действие «${cur.title || cur.id}» с ${hm(cur.since)} — итог придёт сообщением, потом повторите`;
  const run = a.during_run ? null : currentRun(p);
  return run ? runBusyText(run, a) : null;
}
const runBusyText = (run, a) => `⏳ Идёт прогон команды ${run.id || ''} с ${hm(run.since)} — «${a.title}» во время прогона не запускаю, повторите после него`;

// ---------- сообщения ----------
export const escHtml = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const pre = (s) => `<pre>${escHtml(s)}</pre>`;

/** «🛠 Действия»: список с кнопками ac:<id>. */
export function actionsMessage(p, cfg) {
  const list = listActions(cfg);
  if (!list.length) return { text: '🛠 Действий нет: их задаёт владелец в разделе actions файла mcfly/config.yaml.', keyboard: [] };
  const cur = currentAction(p);
  const L = [`🛠 <b>Действия · ${escHtml(cfg.project)}</b>`, ''];
  if (cur) L.push(`⏳ Сейчас идёт «${escHtml(cur.title || cur.id)}» с ${hm(cur.since)}`, '');
  for (const a of list) L.push(`<b>${escHtml(a.title)}</b>${a.describe ? ` — ${escHtml(a.describe)}` : ''}${a.confirm ? '' : ' <i>(без подтверждения)</i>'}`);
  L.push('', '<i>Действия с подтверждением: сначала бот покажет, что будет сделано, и спросит «Да».</i>');
  return { text: L.join('\n'), keyboard: list.map((a) => [{ text: a.title, callback_data: `ac:${a.id}` }]) };
}

/** Запрос подтверждения: что будет сделано, вывод prepare, кнопки «Да» с кодом и «Отмена». */
export function confirmMessage(a, code, prepared = '') {
  const L = [`<b>${escHtml(a.title)}</b>`];
  if (a.describe) L.push(`Что будет сделано: ${escHtml(a.describe)}`);
  if (prepared.trim()) L.push('', pre(truncate(prepared.trim(), RESULT_MAX)));
  L.push('', `<i>Подтверждение действует 30 минут. Предел времени — ${a.timeout_minutes} мин.</i>`);
  return { text: L.join('\n'), keyboard: [[{ text: '✅ Да, выполнить', callback_data: `ax:${a.id}:${code}` }, { text: '✖️ Отмена', callback_data: `an:${a.id}` }]] };
}

/** Строки итога: с префиксом «@@ » (без него), иначе последние TAIL_LINES строк вывода. */
export function resultLines(lines) {
  const marked = lines.filter((l) => l.startsWith('@@ ')).map((l) => l.slice(3));
  return marked.length ? marked : lines.filter((l) => l.trim()).slice(-TAIL_LINES);
}
const followupKeyboard = (cfg, a) => a.followups.map((f) => getAction(cfg, f)).filter(Boolean).map((f) => [{ text: f.title, callback_data: `ac:${f.id}` }]);

export function resultMessage(cfg, a, { status, code, durationMs, lines, logRel }) {
  const head = status === 'ok' ? `✅ <b>${escHtml(a.title)}</b> — готово за ${fmtDuration(durationMs)}`
    : status === 'timeout' ? `⏱ <b>${escHtml(a.title)}</b> — прервано: дольше ${a.timeout_minutes} мин`
      : `❌ <b>${escHtml(a.title)}</b> — ошибка${code != null ? ` (код ${code})` : ''} за ${fmtDuration(durationMs)}`;
  const body = resultLines(lines).join('\n');
  const L = [head];
  if (body.trim()) L.push('', pre(truncate(body, RESULT_MAX)));
  if (logRel) L.push(`<i>Журнал: ${escHtml(logRel)}</i>`);
  return { text: L.join('\n'), keyboard: followupKeyboard(cfg, a) };
}

// ---------- запуск команд ----------
/** Отдельный процесс mcfly action <kind> <id>: опрос Telegram не ждёт выката. */
export function spawnAction(projectDir, kind, id, ticket) {
  spawn(process.execPath, [path.join(MCFLY_ROOT, 'bin', 'mcfly'), 'action', kind, id, '--ticket', ticket, '--project', projectDir], { cwd: projectDir, detached: true, stdio: 'ignore', env: process.env }).unref();
}

/**
 * bash -c command в каталоге проекта с пределом времени: группа процессов получает SIGTERM, через 10 с — SIGKILL.
 * Вывод (stdout и stderr) — построчно в onLine и в файл logFile. Возвращает { code, timedOut, lines } (последние KEEP_LINES и все «@@ »).
 */
export function runCommand(command, { cwd, timeoutMs, logFile = null, env = process.env, onLine = () => {} }) {
  return new Promise((resolve) => {
    const out = logFile ? fs.createWriteStream(logFile, { flags: 'a' }) : null;
    const child = spawn('bash', ['-c', command], { cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const lines = []; let marked = 0; let timedOut = false; let buf = { out: '', err: '' };
    const push = (line) => {
      onLine(line);
      if (line.startsWith('@@ ')) marked += 1;
      lines.push(line);
      // держим хвост и все строки итога
      if (lines.length > KEEP_LINES + marked) { const i = lines.findIndex((l) => !l.startsWith('@@ ')); if (i >= 0) lines.splice(i, 1); }
    };
    const feed = (key) => (chunk) => {
      const s = chunk.toString('utf8'); out?.write(s);
      const parts = (buf[key] + s).split('\n'); buf[key] = parts.pop();
      for (const l of parts) push(l.replace(/\r$/, ''));
    };
    child.stdout.on('data', feed('out')); child.stderr.on('data', feed('err'));
    const kill = (sig) => { try { process.kill(-child.pid, sig); } catch {} };
    const timer = setTimeout(() => { timedOut = true; kill('SIGTERM'); setTimeout(() => kill('SIGKILL'), KILL_GRACE_MS).unref(); }, timeoutMs);
    child.on('error', (e) => push(`не запустилось: ${e.message}`));
    child.on('close', (code) => {
      clearTimeout(timer);
      // bash умер от SIGTERM, а потомок мог его проигнорировать: добиваем всю группу сразу, не дожидаясь таймера
      if (timedOut) kill('SIGKILL');
      for (const k of ['out', 'err']) if (buf[k]) push(buf[k]);
      out?.end();
      resolve({ code, timedOut, lines });
    });
  });
}

async function vpnFailure(cfg, a) {
  if (!a.vpn) return null;
  const v = await ensureVpn(cfg.run.vpn_service, { scutil: cfg.run.scutil_bin });
  return v.action === 'failed' ? v.message : null;
}

/** Отправка в Telegram; не дошло — в очередь, задание answers дошлёт. */
async function deliver(p, send, msg, now) {
  try { await send(msg.text, msg.keyboard); }
  catch { enqueueNotice(p, { text: msg.text, keyboard: msg.keyboard, html: true }, now); }
}

/** Пропуск или доверие не прошли: в чат — чтобы владелец увидел попытку запуска в обход кнопки. */
async function refused(p, cfg, a, ticket, interactive, send, now) {
  const digest = actionsDigest(cfg);
  if (!isTrusted(p, cfg)) { await deliver(p, send, { text: escHtml(UNTRUSTED_TEXT), keyboard: [] }, now); return { status: 'untrusted' }; }
  if (!interactive && !takeTicket(p, a.id, ticket, now, digest)) {
    await deliver(p, send, { text: `⛔ Запуск «${escHtml(a.title)}» без подтверждения кнопкой отклонён`, keyboard: [] }, now);
    return { status: 'refused' };
  }
  return null;
}

/** mcfly action prepare <id> --ticket: вывод prepare и запрос подтверждения с новым кодом. */
export async function prepareAction({ p, cfg, id, send, ticket = null, now = () => new Date(), timeoutMs = PREPARE_TIMEOUT_MS }) {
  const a = getAction(cfg, id);
  if (!a) return { status: 'unknown' };
  const no = await refused(p, cfg, a, ticket, false, send, now());
  if (no) return no;
  const vpn = await vpnFailure(cfg, a);
  if (vpn) { await deliver(p, send, { text: `❌ <b>${escHtml(a.title)}</b>: ${escHtml(vpn)} — без VPN сервер недоступен`, keyboard: [] }, now()); return { status: 'vpn' }; }
  const r = await runCommand(a.prepare, { cwd: p.projectDir, timeoutMs });
  if (r.code !== 0 || r.timedOut) {
    const why = r.timedOut ? `дольше ${Math.round(timeoutMs / 60000)} мин` : `код ${r.code}`;
    await deliver(p, send, { text: `❌ Подготовка «${escHtml(a.title)}» не удалась (${why}) — действие не запускаю.\n${pre(truncate(r.lines.filter((l) => l.trim()).slice(-TAIL_LINES).join('\n'), RESULT_MAX))}`, keyboard: [] }, now());
    return { status: 'error' };
  }
  await deliver(p, send, confirmMessage(a, issueCode(p, a.id, now(), actionsDigest(cfg)), resultLines(r.lines).join('\n')), now());
  return { status: 'ok' };
}

/**
 * mcfly action exec <id> --ticket: блокировка, VPN, команда с пределом времени, журнал, итог в чат, запись в metrics.jsonl.
 * interactive — mcfly action run из терминала владельца (TTY и --yes проверяет cli.js): без пропуска.
 */
export async function execAction({ p, cfg, id, send, ticket = null, interactive = false, now = () => new Date(), echo = null }) {
  const a = getAction(cfg, id);
  if (!a) return { status: 'unknown' };
  const started = now();
  const no = await refused(p, cfg, a, ticket, interactive, send, started);
  if (no) return no;
  if (!acquireActionLock(p, a, started)) {
    await deliver(p, send, { text: blockReason(p, a) ? escHtml(blockReason(p, a)) : `⏳ «${escHtml(a.title)}» не запущено: идёт другое действие`, keyboard: [] }, started);
    return { status: 'busy' };
  }
  try {
    const run = a.during_run ? null : currentRun(p);
    if (run) { await deliver(p, send, { text: escHtml(runBusyText(run, a)), keyboard: [] }, started); return { status: 'busy' }; }
    const vpn = await vpnFailure(cfg, a);
    let r; let logRel = '';
    if (vpn) r = { code: null, timedOut: false, lines: [`@@ ${vpn} — без VPN сервер недоступен`] };
    else {
      const dir = path.join(p.logs, 'actions'); ensureDir(dir);
      const logFile = path.join(dir, `${runId(started)}-${a.id}.log`);
      logRel = path.relative(p.projectDir, logFile);
      r = await runCommand(a.run, { cwd: p.projectDir, timeoutMs: a.timeout_minutes * 60_000, logFile, env: { ...process.env, MCFLY_ACTION: a.id }, onLine: echo || (() => {}) });
    }
    const ended = now();
    const status = r.timedOut ? 'timeout' : r.code === 0 ? 'ok' : 'error';
    appendMetric(p, { type: 'action', id: a.id, status, exit_code: r.code, started_at: started.toISOString(), ended_at: ended.toISOString(), duration_ms: ended - started });
    await deliver(p, send, resultMessage(cfg, a, { status, code: r.code, durationMs: ended - started, lines: r.lines, logRel }), ended);
    return { status, code: r.code, lines: r.lines };
  } finally { releaseActionLock(p); }
}

/**
 * Кнопки «Можно сделать» для «где мы»: действия, у которых offer вернул 0. Все offer — параллельно, каждый не дольше
 * timeoutMs (по таймауту гибнет вся группа процессов): опрос Telegram ждёт не больше одного предела.
 */
export async function offerKeyboard(p, cfg, { timeoutMs = OFFER_TIMEOUT_MS } = {}) {
  if (!isTrusted(p, cfg)) return []; // неподтверждённый раздел — никаких команд, даже offer
  const list = listActions(cfg).filter((a) => a.offer);
  const results = await Promise.all(list.map((a) => runCommand(a.offer, { cwd: p.projectDir, timeoutMs })));
  return list.filter((a, i) => results[i].code === 0 && !results[i].timedOut).map((a) => [{ text: a.title, callback_data: `ac:${a.id}` }]);
}

// ---------- сообщения из Telegram ----------
export const ACTION_TYPES = new Set(['actions', 'action', 'actionYes', 'actionNo']);

/**
 * Ответ на сообщение о действии. send(text, keyboard) — HTML в чат проекта. spawn(kind, id, ticket) — фоновый процесс.
 * Отправителя (только владелец) проверяет pull.js.
 * Ничего не пишет в answers.md: решение владельца видно в журнале действия и metrics.jsonl.
 */
export async function handleActionMessage({ parsed, p, cfg, send, spawn: spawnRaw, now = new Date() }) {
  if (hasActions(cfg) && !isTrusted(p, cfg)) return send(escHtml(UNTRUSTED_TEXT), []);
  if (parsed.type === 'actions') { const m = actionsMessage(p, cfg); return send(m.text, m.keyboard); }
  const digest = actionsDigest(cfg);
  // процесс получает одноразовый пропуск: без него exec/prepare не работают (вызов mcfly action exec в обход кнопки)
  const spawnKind = (kind, id) => spawnRaw(kind, id, issueTicket(p, id, now, digest));
  const a = getAction(cfg, parsed.id);
  if (!a) return send(`⚠️ Действие «${escHtml(parsed.id)}» не настроено (раздел actions в mcfly/config.yaml)`, []);
  if (parsed.type === 'actionNo') return send(`✖️ Отменено: ${escHtml(a.title)}`, []);
  const blocked = blockReason(p, a);
  if (blocked) return send(escHtml(blocked), []);
  if (parsed.type === 'actionYes') {
    if (!takeCode(p, a.id, parsed.code, now, digest)) return send(`⌛ Подтверждение «${escHtml(a.title)}» устарело или уже использовано — нажмите «🛠 Действия» и начните снова`, []);
    spawnKind('exec', a.id);
    return send(`▶️ Начинаю: <b>${escHtml(a.title)}</b> (предел ${a.timeout_minutes} мин) — итог придёт сообщением`, []);
  }
  if (!a.confirm) { spawnKind('exec', a.id); return send(`▶️ ${escHtml(a.title)} — итог придёт сообщением`, []); }
  if (a.prepare) { spawnKind('prepare', a.id); return send(`🔎 Готовлю «${escHtml(a.title)}» — что будет сделано, пришлю с кнопкой подтверждения`, []); }
  const m = confirmMessage(a, issueCode(p, a.id, now, digest));
  return send(m.text, m.keyboard);
}
