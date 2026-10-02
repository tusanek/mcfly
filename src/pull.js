import { createTelegram, extractMessages } from './telegram.js';
import { applyMessages } from './answers.js';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { loadState, saveState } from './state.js';
import { currentRun } from './runner.js';
import { MCFLY_ROOT } from './prompt.js';
import { ensureDir, readJson, pad2 } from './util.js';

/** Дневной прогон отдельным процессом: опрос ответов не ждёт его конца. */
export function spawnDayRun(projectDir) {
  spawn(process.execPath, [path.join(MCFLY_ROOT, 'bin', 'mcfly'), 'run', '--mode', 'day', '--project', projectDir], { cwd: projectDir, detached: true, stdio: 'ignore', env: process.env }).unref();
}

const realSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Блокировка опроса Telegram (mcfly/logs/.pull.lock — logs/ в .gitignore любого проекта mcfly, агенты не закоммитят её через git add -A).
 * Держится на getUpdates → применение → сохранение offset: два чтения одного offset дали бы двойное применение.
 * Берут её задание answers (цикл) и прогон в начале. Брошенная: процесса нет или ей больше PULL_LOCK_STALE_MS
 * (держатель за это время давно бы её снял — опрос длится секунды; pid после перезагрузки мог достаться другому).
 */
export const PULL_LOCK_STALE_MS = 10 * 60_000;
export const pullLockPath = (p) => path.join(p.logs, '.pull.lock');
function pullLockStale(lock) {
  if (!lock?.pid || Date.now() - new Date(lock.at || 0).getTime() > PULL_LOCK_STALE_MS) return true;
  try { process.kill(lock.pid, 0); return false; } catch (e) { return e.code !== 'EPERM'; }
}
/** Токен блокировки или null, если её держит другой (в том числе другой вызов в этом же процессе). */
export function acquirePullLock(p) {
  const file = pullLockPath(p); ensureDir(p.logs);
  const token = crypto.randomUUID();
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = fs.openSync(file, 'wx');
      try { fs.writeSync(fd, JSON.stringify({ pid: process.pid, at: new Date().toISOString(), token })); } finally { fs.closeSync(fd); }
      return token;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      const raw = (() => { try { return fs.readFileSync(file, 'utf8'); } catch { return null; } })();
      if (raw === null) continue; // сняли между open и read — пробуем снова
      let lock = null; try { lock = JSON.parse(raw); } catch {}
      // пустой файл — держатель только что создал его и ещё пишет; брошенным считаем по возрасту файла
      if (!lock) { try { if (Date.now() - fs.statSync(file).mtimeMs < 5_000) return null; } catch { continue; } }
      else if (!pullLockStale(lock)) return null;
      // брошена: снимаем, только если это всё ещё она (иначе снесли бы свежую чужую)
      try { if (fs.readFileSync(file, 'utf8') === raw) fs.unlinkSync(file); } catch {}
    }
  }
  return null;
}
export function ownsPullLock(p, token) { return !!token && readJson(pullLockPath(p), null)?.token === token; }
export function releasePullLock(p, token) { if (ownsPullLock(p, token)) { try { fs.unlinkSync(pullLockPath(p)); } catch {} } }

/** Сетевая ошибка одной строкой, без стека: «fetch failed (ECONNRESET)». */
export function errorLine(e) {
  const code = e?.cause?.code || e?.cause?.name || '';
  return `${String(e?.message || e).split('\n')[0]}${code && !String(e?.message).includes(code) ? ` (${code})` : ''}`.slice(0, 300);
}

/**
 * Один опрос Telegram: getUpdates → применение → offset под блокировкой опроса, потом ответы на кнопки и подтверждения.
 * timeoutSec — длинный опрос (сервер держит запрос, пока не придёт сообщение); lockWaitMs — сколько ждать чужую блокировку.
 * session — общее для итераций одного задания (не стартовать второй прогон, пока первый поднимается).
 * Возвращает { applied, messages } и busy: true (блокировка занята) или disabled: true (Telegram не настроен).
 */
export async function pullAnswers({ projectDir, cfg, p, log = console.log, telegram = null, now = new Date(), startRun = spawnDayRun,
  timeoutSec = 0, lockWaitMs = 0, sleep = realSleep, quietEmpty = false, session = {} }) {
  const token = process.env[cfg.telegram.token_env];
  if (!token || !cfg.telegram.chat_id) { log('Telegram не настроен (нет токена или chat_id), опрос пропущен.'); return { applied: 0, messages: [], disabled: true }; }
  const tg = telegram || createTelegram({ token });
  let lock = acquirePullLock(p);
  for (let waited = 0; !lock && waited < lockWaitMs; waited += 250) { await sleep(250); lock = acquirePullLock(p); }
  if (!lock) { if (!quietEmpty) log('Ответы из Telegram сейчас забирает другой процесс (mcfly/logs/.pull.lock).'); return { applied: 0, messages: [], busy: true }; }
  let messages, acks;
  try {
    const state = loadState(p);
    const updates = await tg.getUpdates(state.telegram_offset || 0, timeoutSec);
    // Блокировку сочли брошенной и забрали (Mac спал посреди запроса) — эти обновления применит новый держатель.
    if (!ownsPullLock(p, lock)) { log('Блокировка опроса перехвачена — обновления применит другой процесс.'); return { applied: 0, messages: [], busy: true }; }
    const extracted = extractMessages(updates, cfg.telegram.chat_id);
    messages = extracted.messages;
    const { nextOffset } = extracted;
    // «запусти» из Telegram: дневной прогон, если сейчас ничего не идёт (run.telegram_start: false — только запись, как раньше).
    const onRun = cfg.run.telegram_start === false ? null : () => {
      const cur = currentRun(p);
      if (cur) return `⏳ Идёт прогон ${cur.id || ''} с ${pad2(cur.since.getHours())}:${pad2(cur.since.getMinutes())} — итог придёт сообщением`;
      // прогон стартовал в этом задании меньше минуты назад и ещё не взял лок
      if (session.runStartedAt && Date.now() - session.runStartedAt < 60_000) return '⏳ Дневной прогон уже запускается';
      session.runStartedAt = Date.now(); startRun(projectDir);
      return '▶️ Запускаю дневной прогон — итог придёт сообщением';
    };
    acks = applyMessages(p, messages, { now, onRun });
    if (nextOffset) { state.telegram_offset = nextOffset; saveState(p, state); }
  } finally { releasePullLock(p, lock); }
  // Нажатие кнопки ждёт ответа, иначе Telegram крутит на ней индикатор; устаревшее нажатие API отклоняет — не страшно.
  for (const m of messages.filter((x) => x.callbackId)) { try { await tg.answerCallbackQuery(m.callbackId, 'Принято'); } catch {} }
  if (acks.length) await tg.sendMessage(cfg.telegram.chat_id, acks.join('\n'));
  if (messages.length || !quietEmpty) log(`Telegram: сообщений ${messages.length}, применено ${acks.length}.`);
  return { applied: acks.length, messages };
}

/**
 * Задание answers: длинный опрос Telegram в течение durationMs (answers_every_minutes; задание launchd постоянное — после выхода сразу новый цикл),
 * чтобы «запусти» и кнопки получали ответ за секунды, а не к следующему запуску.
 * - каждое сообщение применяется сразу (pullAnswers под блокировкой опроса);
 * - сетевая ошибка — строка в журнал, пауза errorPauseMs и следующая попытка;
 * - прогон нового кода (лок с pull_lock) берёт ту же блокировку — читаем и во время него: «запусти» сразу получит «⏳ Идёт прогон»;
 * - прогон старого кода (лок без pull_lock) читает обновления без блокировки — не читаем, пока он идёт.
 * clock и sleep подставляются в тестах.
 */
export async function pollAnswers({ projectDir, cfg, p, log = console.log, telegram = null, durationMs, pollTimeoutSec = 25,
  errorPauseMs = 12_000, idleMs = 1_000, busyPauseMs = 2_000, oldRunPauseMs = 30_000, clock = Date.now, sleep = realSleep, startRun = spawnDayRun }) {
  const deadline = clock() + durationMs;
  const left = () => deadline - clock();
  const pause = (ms) => sleep(Math.max(0, Math.min(ms, left())));
  const session = {}; const stats = { polls: 0, messages: 0, errors: 0 };
  let oldRunNoted = false;
  while (left() >= 1_000) {
    const cur = currentRun(p);
    if (cur && !cur.pullLock) {
      if (!oldRunNoted) { log(`Идёт прогон ${cur.id || ''} старой версии mcfly — ответы из Telegram заберу после него.`); oldRunNoted = true; }
      await pause(oldRunPauseMs); continue;
    }
    let r;
    try {
      stats.polls += 1;
      r = await pullAnswers({ projectDir, cfg, p, log, telegram, now: new Date(clock()), startRun, session, quietEmpty: true,
        timeoutSec: Math.max(1, Math.min(pollTimeoutSec, Math.floor(left() / 1000))) });
    } catch (e) {
      stats.errors += 1;
      log(`Telegram недоступен: ${errorLine(e)}; повтор через ${Math.round(errorPauseMs / 1000)} с.`);
      await pause(errorPauseMs); continue;
    }
    if (r.disabled) return stats;
    stats.messages += r.messages.length;
    // Пауза между опросами — окно, в котором прогон в начале успевает взять блокировку; сообщения за это время не теряются.
    await pause(r.busy ? busyPauseMs : idleMs);
  }
  log(`Опрос Telegram завершён: запросов ${stats.polls}, сообщений ${stats.messages}, ошибок ${stats.errors}.`);
  return stats;
}
