import { createTelegram, extractMessages } from './telegram.js';
import { applyMessages } from './answers.js';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { loadState, saveState } from './state.js';
import { currentRun } from './runner.js';
import { MCFLY_ROOT } from './prompt.js';
import { pad2 } from './util.js';

/** Дневной прогон отдельным процессом: опрос ответов не ждёт его конца. */
export function spawnDayRun(projectDir) {
  spawn(process.execPath, [path.join(MCFLY_ROOT, 'bin', 'mcfly'), 'run', '--mode', 'day', '--project', projectDir], { cwd: projectDir, detached: true, stdio: 'ignore', env: process.env }).unref();
}

export async function pullAnswers({ projectDir, cfg, p, log = console.log, telegram = null, now = new Date(), startRun = spawnDayRun }) {
  const token = process.env[cfg.telegram.token_env];
  if (!token || !cfg.telegram.chat_id) { log('Telegram не настроен (нет токена или chat_id), опрос пропущен.'); return { applied: 0, messages: [] }; }
  const tg = telegram || createTelegram({ token });
  const state = loadState(p);
  const updates = await tg.getUpdates(state.telegram_offset || 0);
  const { messages, nextOffset } = extractMessages(updates, cfg.telegram.chat_id);
  // «запусти» из Telegram: дневной прогон, если сейчас ничего не идёт (run.telegram_start: false — только запись, как раньше).
  let startedNow = false;
  const onRun = cfg.run.telegram_start === false ? null : () => {
    const cur = currentRun(p);
    if (cur) return `⏳ Идёт прогон ${cur.id || ''} с ${pad2(cur.since.getHours())}:${pad2(cur.since.getMinutes())} — итог придёт сообщением`;
    if (startedNow) return '⏳ Дневной прогон уже запускается';
    startedNow = true; startRun(projectDir);
    return '▶️ Запускаю дневной прогон — итог придёт сообщением';
  };
  const acks = applyMessages(p, messages, { now, onRun });
  if (nextOffset) { state.telegram_offset = nextOffset; saveState(p, state); }
  // Нажатие кнопки ждёт ответа, иначе Telegram крутит на ней индикатор; устаревшее нажатие API отклоняет — не страшно.
  for (const m of messages.filter((x) => x.callbackId)) { try { await tg.answerCallbackQuery(m.callbackId, 'Принято'); } catch {} }
  if (acks.length) await tg.sendMessage(cfg.telegram.chat_id, acks.join('\n'));
  log(`Telegram: сообщений ${messages.length}, применено ${acks.length}.`);
  return { applied: acks.length, messages };
}
