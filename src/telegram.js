import fs from 'node:fs';
import path from 'node:path';
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
/**
 * timeoutMs — сколько ждать ответа сверх длинного опроса: getUpdates с timeout N с ждёт N с + timeoutMs, остальные запросы — timeoutMs.
 * Без него зависшее соединение держало бы опрос до таймаута undici (5 минут).
 */
export function createTelegram({ token, fetchImpl = globalThis.fetch, timeoutMs = 15_000 }) {
  if (!token) throw new Error('Нет токена Telegram: задайте переменную окружения из telegram.token_env в mcfly/.env');
  const base = `https://api.telegram.org/bot${token}`;
  async function call(method, body) {
    const ms = (method === 'getUpdates' ? (body.timeout || 0) * 1000 : 0) + timeoutMs;
    let res;
    try {
      res = await fetchImpl(`${base}/${method}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(ms) });
    } catch (e) {
      if (e?.name === 'TimeoutError' || e?.name === 'AbortError') throw new Error(`Telegram ${method}: нет ответа за ${Math.round(ms / 1000)} с`);
      throw e;
    }
    let data;
    // 502/504 от прокси приходят HTML-страницей: вместо «Unexpected token <» — код HTTP
    try { data = await res.json(); } catch { throw new Error(`Telegram ${method}: HTTP ${res.status}${res.statusText ? ' ' + res.statusText : ''}`); }
    if (!data?.ok) throw new Error(`Telegram ${method}: ${data?.description || res.status}`);
    return data.result;
  }
  return {
    /**
     * html — разметка Telegram HTML (длинный HTML режет вызывающий, см. splitHtml); keyboard — кнопки под последним куском этого вызова;
     * replyKeyboard — постоянная клавиатура внизу чата (ряды кнопок-текстов), если кнопок под сообщением нет.
     */
    async sendMessage(chatId, text, { html = false, keyboard = null, replyKeyboard = null } = {}) {
      const results = [];
      const parts = html ? [text] : chunk(text);
      for (const [i, part] of parts.entries()) {
        const body = { chat_id: chatId, text: part, disable_web_page_preview: true };
        if (html) body.parse_mode = 'HTML';
        if (keyboard?.length && i === parts.length - 1) body.reply_markup = { inline_keyboard: keyboard };
        else if (replyKeyboard?.length && i === parts.length - 1) body.reply_markup = { keyboard: replyKeyboard, resize_keyboard: true, is_persistent: true };
        results.push(await call('sendMessage', body));
      }
      return results;
    },
    /**
     * Видео файлом с диска (0.12.0): подпись, ответ на сообщение replyTo. Бот принимает до 50 МБ; на загрузку — отдельный, длинный срок.
     */
    async sendVideo(chatId, file, { caption = '', replyTo = null, duration = 0, width = 0, height = 0, uploadTimeoutMs = 180_000 } = {}) {
      const size = fs.statSync(file).size;
      if (size > 50 * 1024 * 1024) throw new Error(`Telegram sendVideo: файл ${Math.round(size / 1024 / 1024)} МБ, бот принимает до 50 МБ`);
      const form = new FormData();
      form.set('chat_id', String(chatId)); form.set('supports_streaming', 'true');
      if (caption) form.set('caption', caption);
      if (replyTo) form.set('reply_parameters', JSON.stringify({ message_id: replyTo, allow_sending_without_reply: true }));
      for (const [k, v] of Object.entries({ duration, width, height })) if (v) form.set(k, String(v));
      form.set('video', new Blob([fs.readFileSync(file)], { type: 'video/mp4' }), path.basename(file));
      let res;
      try { res = await fetchImpl(`${base}/sendVideo`, { method: 'POST', body: form, signal: AbortSignal.timeout(uploadTimeoutMs) }); } catch (e) {
        if (e?.name === 'TimeoutError' || e?.name === 'AbortError') throw new Error(`Telegram sendVideo: нет ответа за ${Math.round(uploadTimeoutMs / 1000)} с`);
        throw e;
      }
      let data;
      try { data = await res.json(); } catch { throw new Error(`Telegram sendVideo: HTTP ${res.status}`); }
      if (!data?.ok) throw new Error(`Telegram sendVideo: ${data?.description || res.status}`);
      return data.result;
    },
    /**
     * Картинки образцов (0.19.0): несколько — альбомом (sendMediaGroup, до 10), одна — sendPhoto. Подпись — у первой.
     */
    async sendPhotos(chatId, files, { caption = '', uploadTimeoutMs = 60_000 } = {}) {
      const list = files.slice(0, 10); const method = list.length > 1 ? 'sendMediaGroup' : 'sendPhoto';
      const form = new FormData(); form.set('chat_id', String(chatId));
      const blob = (f) => new Blob([fs.readFileSync(f)], { type: /\.png$/i.test(f) ? 'image/png' : 'image/jpeg' });
      if (method === 'sendPhoto') { form.set('photo', blob(list[0]), path.basename(list[0])); if (caption) form.set('caption', caption); }
      else {
        form.set('media', JSON.stringify(list.map((_, i) => ({ type: 'photo', media: `attach://p${i}`, ...(i === 0 && caption ? { caption } : {}) }))));
        list.forEach((f, i) => form.set(`p${i}`, blob(f), path.basename(f)));
      }
      let res;
      try { res = await fetchImpl(`${base}/${method}`, { method: 'POST', body: form, signal: AbortSignal.timeout(uploadTimeoutMs) }); } catch (e) {
        if (e?.name === 'TimeoutError' || e?.name === 'AbortError') throw new Error(`Telegram ${method}: нет ответа за ${Math.round(uploadTimeoutMs / 1000)} с`);
        throw e;
      }
      let data;
      try { data = await res.json(); } catch { throw new Error(`Telegram ${method}: HTTP ${res.status}`); }
      if (!data?.ok) throw new Error(`Telegram ${method}: ${data?.description || res.status}`);
      return data.result;
    },
    /**
     * Виджет — страница HTML прямо в сообщении (Bot API 10.4, 0.14.0). Пределы размера проверяет сервер; сейчас виджеты принимает
     * только личный чат с ботом. Подпись обязательна по смыслу: её показывают список чатов, уведомления и приложения без виджетов.
     */
    sendWidget(chatId, html, { caption = '', replyTo = null } = {}) {
      const body = { chat_id: chatId, html };
      if (caption) body.caption = caption;
      if (replyTo) body.reply_parameters = { message_id: replyTo, allow_sending_without_reply: true };
      return call('sendWidget', body);
    },
    /** Расширенное сообщение (Bot API 10.1, 0.14.0): заголовки, списки, сворачиваемые блоки; html — в разметке Rich HTML. */
    sendRichMessage(chatId, html, { replyTo = null } = {}) {
      const body = { chat_id: chatId, rich_message: { html } };
      if (replyTo) body.reply_parameters = { message_id: replyTo, allow_sending_without_reply: true };
      return call('sendRichMessage', body);
    },
    getUpdates(offset = 0, timeoutSec = 0) { return call('getUpdates', { offset, timeout: timeoutSec, allowed_updates: ['message', 'callback_query'] }); },
    answerCallbackQuery(id, text = '') { return call('answerCallbackQuery', { callback_query_id: id, text }); },
    /** Меню команд «/» в чате с ботом: [{ command, description }]. */
    setMyCommands(commands) { return call('setMyCommands', { commands }); },
  };
}
/**
 * Кнопка → команда, как если бы человек написал её текстом: ap:имя, rj:имя, qd:Qn, rn:day («запусти»);
 * действия (0.6.0): ac:id («действие id»), ax:id:код («действие id да код»), an:id («действие id отмена»);
 * предложения (0.7.0): ib:Iн («берём Iн»), ix:Iн («не сейчас Iн»), il:N («предложения N»);
 * напоминания (0.8.0): rs:Rн («отложить Rн» — «⏰ Через час»), rx:Rн («отменить Rн»);
 * находки для mcfly (0.11.0): fb:Fн или fb:все («передать Fн»), fx:Fн («не надо Fн»), fl:1 («находки»);
 * очередь (0.16.0): up:Iн или up:имя («вперёд …» — «⬆ Вперёд»), qu:1 («очередь»), rn:N («запусти N» — сколько изменений взять);
 * без одобрения (0.17.0): cl:имя или cl:Iн («закрыть …» — «🗑 Закрыть без работы»), rv:имя («вернуть …» — «↩ Вернуть»);
 * образцы (0.10.0): sh:имя («образец имя» — «👀 Как будет выглядеть»), sm:… — ненастоящая кнопка под образцом, ничего не делает.
 */
export function callbackText(data) {
  const m = /^(ap|rj|qd|rn|ac|ax|an|ib|ix|il|rs|rx|sh|sm|fb|fx|fl|up|qu|cl|rv):(.+)$/.exec(String(data || ''));
  if (!m) return null;
  if (m[1] === 'fb') return `передать ${m[2]}`;
  if (m[1] === 'fx') return `не надо ${m[2]}`;
  if (m[1] === 'fl') return 'находки';
  if (m[1] === 'sh') return `образец ${m[2]}`;
  if (m[1] === 'sm') return 'образец кнопка';
  if (m[1] === 'ib') return `берём ${m[2]}`;
  if (m[1] === 'ix') return `не сейчас ${m[2]}`;
  if (m[1] === 'il') return `предложения ${m[2]}`;
  if (m[1] === 'rs') return `отложить ${m[2]}`;
  if (m[1] === 'rx') return `отменить ${m[2]}`;
  // 0.16.0: rn:3 — «запусти 3» (сколько изменений взять), rn:3! — «запусти всё равно 3»; rn:day — как раньше
  if (m[1] === 'rn') { const n = /^(\d{1,2})(!?)$/.exec(m[2]); return n ? `запусти ${n[2] ? 'всё равно ' : ''}${n[1]}` : 'запусти'; }
  if (m[1] === 'up') return `вперёд ${m[2]}`;
  if (m[1] === 'qu') return 'очередь';
  if (m[1] === 'cl') return `закрыть ${m[2]}`;
  if (m[1] === 'rv') return `вернуть ${m[2]}`;
  if (m[1] === 'ac') return `действие ${m[2]}`;
  if (m[1] === 'an') return `действие ${m[2]} отмена`;
  if (m[1] === 'ax') { const [id, code] = m[2].split(':'); return code ? `действие ${id} да ${code}` : null; }
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
      messages.push({ id: cq.message.message_id, chatId: cq.message.chat.id, text, date: new Date(cq.message.date * 1000), from: cq.from?.username || cq.from?.first_name || '', fromId: cq.from?.id ?? null, callbackId: cq.id });
      continue;
    }
    const m = u.message;
    if (!m || !m.text) continue;
    if (chatId && String(m.chat?.id) !== String(chatId)) continue;
    // replyTo — текст сообщения, на которое человек ответил свайпом: по нему ответ относится к вопросу (answers.js).
    messages.push({ id: m.message_id, chatId: m.chat.id, text: m.text, date: new Date(m.date * 1000), from: m.from?.username || m.from?.first_name || '', fromId: m.from?.id ?? null, ...(m.reply_to_message?.text ? { replyTo: m.reply_to_message.text } : {}) });
  }
  return { messages, nextOffset };
}
