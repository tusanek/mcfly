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
    async sendMessage(chatId, text) {
      const results = [];
      for (const part of chunk(text)) results.push(await call('sendMessage', { chat_id: chatId, text: part, disable_web_page_preview: true }));
      return results;
    },
    getUpdates(offset = 0, timeoutSec = 0) { return call('getUpdates', { offset, timeout: timeoutSec, allowed_updates: ['message'] }); },
  };
}
/** Текстовые сообщения из нужного чата (chatId=null — из любого) и следующий offset. */
export function extractMessages(updates, chatId) {
  const messages = []; let nextOffset = null;
  for (const u of updates) {
    nextOffset = u.update_id + 1;
    const m = u.message;
    if (!m || !m.text) continue;
    if (chatId && String(m.chat?.id) !== String(chatId)) continue;
    messages.push({ id: m.message_id, chatId: m.chat.id, text: m.text, date: new Date(m.date * 1000), from: m.from?.username || m.from?.first_name || '' });
  }
  return { messages, nextOffset };
}
