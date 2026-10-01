export function chunk(text, max = 4000) {
  const out = []; let rest = text;
  while (rest.length > max) {
    let cut = rest.lastIndexOf('\n', max);
    if (cut < max * 0.5) cut = max;
    out.push(rest.slice(0, cut)); rest = rest.slice(cut).replace(/^\n/, '');
  }
  if (rest) out.push(rest);
  return out;
}
export function createTelegram({ token, fetchImpl = globalThis.fetch }) {
  if (!token) throw new Error('Нет токена Telegram: задайте переменную окружения из telegram.token_env в mcfly/.env');
  const base = `https://api.telegram.org/bot${token}`;
  async function call(method, body) {
    const res = await fetchImpl(`${base}/${method}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const data = await res.json();
    if (!data.ok) throw new Error(`Telegram ${method}: ${data.description || res.status}`);
    return data.result;
  }
  return {
    /** html — разметка Telegram HTML (сводка укладывается в одно сообщение); keyboard — кнопки под последним куском. */
    async sendMessage(chatId, text, { html = false, keyboard = null } = {}) {
      const results = [];
      const parts = html ? [text] : chunk(text);
      for (const [i, part] of parts.entries()) {
        const body = { chat_id: chatId, text: part, disable_web_page_preview: true };
        if (html) body.parse_mode = 'HTML';
        if (keyboard?.length && i === parts.length - 1) body.reply_markup = { inline_keyboard: keyboard };
        results.push(await call('sendMessage', body));
      }
      return results;
    },
    getUpdates(offset = 0, timeoutSec = 0) { return call('getUpdates', { offset, timeout: timeoutSec, allowed_updates: ['message', 'callback_query'] }); },
    answerCallbackQuery(id, text = '') { return call('answerCallbackQuery', { callback_query_id: id, text }); },
  };
}
/** Кнопка сводки → команда, как если бы человек написал её текстом: ap:имя, rj:имя, qd:Qn. */
export function callbackText(data) {
  const m = /^(ap|rj|qd):(.+)$/.exec(String(data || ''));
  if (!m) return null;
  if (m[1] === 'ap') return `approve ${m[2]}`;
  if (m[1] === 'rj') return `reject ${m[2]} отклонено кнопкой в Telegram`;
  return `${m[2]}: по умолчанию`;
}
/** Текстовые сообщения и нажатия кнопок из нужного чата (chatId=null — из любого) и следующий offset. */
export function extractMessages(updates, chatId) {
  const messages = []; let nextOffset = null;
  for (const u of updates) {
    nextOffset = u.update_id + 1;
    const cq = u.callback_query;
    if (cq) {
      const text = callbackText(cq.data);
      if (!text || !cq.message || (chatId && String(cq.message.chat?.id) !== String(chatId))) continue;
      messages.push({ id: cq.message.message_id, chatId: cq.message.chat.id, text, date: new Date(cq.message.date * 1000), from: cq.from?.username || cq.from?.first_name || '', callbackId: cq.id });
      continue;
    }
    const m = u.message;
    if (!m || !m.text) continue;
    if (chatId && String(m.chat?.id) !== String(chatId)) continue;
    messages.push({ id: m.message_id, chatId: m.chat.id, text: m.text, date: new Date(m.date * 1000), from: m.from?.username || m.from?.first_name || '' });
  }
  return { messages, nextOffset };
}
