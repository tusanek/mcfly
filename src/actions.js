import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { ensureDir, readJson, writeJson, fmtDuration, truncate, pad2, runId } from './util.js';
import { appendMetric } from './metrics.js';
import { enqueueNotice } from './notices.js';
import { currentRun } from './runner.js';
import { ensureVpn } from './vpn.js';
import { MCFLY_ROOT } from './prompt.js';
import { ACTION_ID_RE, getAction, listActions } from './action-config.js';

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

// ---------- одноразовые коды подтверждения ----------
const statePath = (p) => path.join(p.logs, 'actions-state.json');
function loadCodes(p) { return readJson(statePath(p), {})?.codes || {}; }
function saveCodes(p, codes) {
  ensureDir(p.logs);
  // атомарно: код пишет процесс подготовки, читает задание answers
  const tmp = `${statePath(p)}.${process.pid}.tmp`; writeJson(tmp, { codes }); fs.renameSync(tmp, statePath(p));
}
const fresh = (codes, now) => Object.fromEntries(Object.entries(codes).filter(([, c]) => now - new Date(c.at) < CODE_TTL_MS));

/** Новый код подтверждения действия id (6 знаков hex, живёт CODE_TTL_MS). */
export function issueCode(p, id, now = new Date()) {
  const codes = fresh(loadCodes(p), now);
  const code = crypto.randomBytes(3).toString('hex');
  codes[code] = { id, at: now.toISOString() };
  saveCodes(p, codes);
  return code;
}
/** Забирает код: true, если он выдан для id и не устарел; повторно тот же код не сработает. */
export function takeCode(p, id, code, now = new Date()) {
  const all = loadCodes(p); const codes = fresh(all, now);
  const ok = codes[code]?.id === id;
  if (ok) delete codes[code];
  if (ok || Object.keys(codes).length !== Object.keys(all).length) saveCodes(p, codes);
  return ok;
}

// ---------- блокировка: одно действие за раз ----------
export const actionLockPath = (p) => path.join(p.logs, '.action.lock');
function alive(pid) { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } }
/** Идущее действие { id, title, since, pid } или null (брошенная блокировка — процесса нет — не считается). */
export function currentAction(p) {
  const lock = readJson(actionLockPath(p), null);
  if (!lock?.pid || !alive(lock.pid)) return null;
  return { ...lock, since: new Date(lock.since) };
}
export function acquireActionLock(p, a, now = new Date()) {
  ensureDir(p.logs);
  const file = actionLockPath(p);
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = fs.openSync(file, 'wx');
      try { fs.writeSync(fd, JSON.stringify({ pid: process.pid, id: a.id, title: a.title, since: now.toISOString() })); } finally { fs.closeSync(fd); }
      return true;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      if (currentAction(p)) return false;
      try { fs.unlinkSync(file); } catch {}
    }
  }
  return false;
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
  L.push('', '<i>Каждое действие с подтверждением: сначала бот покажет, что будет сделано.</i>');
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
export function spawnAction(projectDir, kind, id) {
  spawn(process.execPath, [path.join(MCFLY_ROOT, 'bin', 'mcfly'), 'action', kind, id, '--project', projectDir], { cwd: projectDir, detached: true, stdio: 'ignore', env: process.env }).unref();
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
  catch { enqueueNotice(p, { text: msg.text, keyboard: msg.keyboard }, now); }
}

/** mcfly action prepare <id>: вывод prepare и запрос подтверждения с новым кодом. */
export async function prepareAction({ p, cfg, id, send, now = () => new Date(), timeoutMs = PREPARE_TIMEOUT_MS }) {
  const a = getAction(cfg, id);
  if (!a) return { status: 'unknown' };
  const vpn = await vpnFailure(cfg, a);
  if (vpn) { await deliver(p, send, { text: `❌ <b>${escHtml(a.title)}</b>: ${escHtml(vpn)} — без VPN сервер недоступен`, keyboard: [] }, now()); return { status: 'vpn' }; }
  const r = await runCommand(a.prepare, { cwd: p.projectDir, timeoutMs });
  if (r.code !== 0 || r.timedOut) {
    const why = r.timedOut ? `дольше ${Math.round(timeoutMs / 60000)} мин` : `код ${r.code}`;
    await deliver(p, send, { text: `❌ Подготовка «${escHtml(a.title)}» не удалась (${why}) — действие не запускаю.\n${pre(truncate(r.lines.filter((l) => l.trim()).slice(-TAIL_LINES).join('\n'), RESULT_MAX))}`, keyboard: [] }, now());
    return { status: 'error' };
  }
  await deliver(p, send, confirmMessage(a, issueCode(p, a.id, now()), resultLines(r.lines).join('\n')), now());
  return { status: 'ok' };
}

/** mcfly action exec <id>: блокировка, VPN, команда с пределом времени, журнал, итог в чат, запись в metrics.jsonl. */
export async function execAction({ p, cfg, id, send, now = () => new Date(), echo = null }) {
  const a = getAction(cfg, id);
  if (!a) return { status: 'unknown' };
  const started = now();
  if (!acquireActionLock(p, a, started)) {
    await deliver(p, send, { text: blockReason(p, a) || `⏳ «${escHtml(a.title)}» не запущено: идёт другое действие`, keyboard: [] }, started);
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

/** Кнопки «Можно сделать» для «где мы»: действия, у которых offer вернул 0. Таймаут и ошибка — без кнопки. */
export function offerKeyboard(p, cfg, { timeoutMs = OFFER_TIMEOUT_MS } = {}) {
  const rows = [];
  for (const a of listActions(cfg)) {
    if (!a.offer) continue;
    const r = spawnSync('bash', ['-c', a.offer], { cwd: p.projectDir, timeout: timeoutMs, stdio: 'ignore' });
    if (r.status === 0) rows.push([{ text: a.title, callback_data: `ac:${a.id}` }]);
  }
  return rows;
}

// ---------- сообщения из Telegram ----------
export const ACTION_TYPES = new Set(['actions', 'action', 'actionYes', 'actionNo']);

/**
 * Ответ на сообщение о действии. send(text, keyboard) — HTML в чат проекта. spawn(kind, id) — фоновый процесс.
 * Ничего не пишет в answers.md: решение владельца видно в журнале действия и metrics.jsonl.
 */
export async function handleActionMessage({ parsed, p, cfg, send, spawn: spawnKind, now = new Date() }) {
  if (parsed.type === 'actions') { const m = actionsMessage(p, cfg); return send(m.text, m.keyboard); }
  const a = getAction(cfg, parsed.id);
  if (!a) return send(`⚠️ Действие «${escHtml(parsed.id)}» не настроено (раздел actions в mcfly/config.yaml)`, []);
  if (parsed.type === 'actionNo') return send(`✖️ Отменено: ${escHtml(a.title)}`, []);
  const blocked = blockReason(p, a);
  if (blocked) return send(escHtml(blocked), []);
  if (parsed.type === 'actionYes') {
    if (!takeCode(p, a.id, parsed.code, now)) return send(`⌛ Подтверждение «${escHtml(a.title)}» устарело или уже использовано — нажмите «🛠 Действия» и начните снова`, []);
    spawnKind('exec', a.id);
    return send(`▶️ Начинаю: <b>${escHtml(a.title)}</b> (предел ${a.timeout_minutes} мин) — итог придёт сообщением`, []);
  }
  if (!a.confirm) { spawnKind('exec', a.id); return send(`▶️ ${escHtml(a.title)} — итог придёт сообщением`, []); }
  if (a.prepare) { spawnKind('prepare', a.id); return send(`🔎 Готовлю «${escHtml(a.title)}» — что будет сделано, пришлю с кнопкой подтверждения`, []); }
  const m = confirmMessage(a, issueCode(p, a.id, now));
  return send(m.text, m.keyboard);
}
