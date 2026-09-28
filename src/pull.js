import { createTelegram, extractMessages } from './telegram.js';
import { applyMessages } from './answers.js';
import { loadState, saveState } from './state.js';

export async function pullAnswers({ projectDir, cfg, p, log = console.log, telegram = null, now = new Date() }) {
  const token = process.env[cfg.telegram.token_env];
  if (!token || !cfg.telegram.chat_id) { log('Telegram не настроен (нет токена или chat_id), опрос пропущен.'); return { applied: 0, messages: [] }; }
  const tg = telegram || createTelegram({ token });
  const state = loadState(p);
  const updates = await tg.getUpdates(state.telegram_offset || 0);
  const { messages, nextOffset } = extractMessages(updates, cfg.telegram.chat_id);
  const acks = applyMessages(p, messages, { now });
  if (nextOffset) { state.telegram_offset = nextOffset; saveState(p, state); }
  if (acks.length) await tg.sendMessage(cfg.telegram.chat_id, acks.join('\n'));
  log(`Telegram: сообщений ${messages.length}, применено ${acks.length}.`);
  return { applied: acks.length, messages };
}
