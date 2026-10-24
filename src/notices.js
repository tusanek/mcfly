import fs from 'node:fs';
import path from 'node:path';
import { ensureDir, fmtShort } from './util.js';

/**
 * Сообщения, которые не ушли в Telegram из-за связи: итог прогона, тревога, подтверждение одобрения.
 * Очередь — mcfly/logs/pending-notices.jsonl (logs/ вне git). Отправляет её задание answers после первого удачного опроса.
 */
export const noticesPath = (p) => path.join(p.logs, 'pending-notices.jsonl');
export const NOTICE_MAX_AGE_HOURS = 48;

export function enqueueNotice(p, { text, keyboard = null, html = false }, now = new Date()) {
  ensureDir(p.logs);
  fs.appendFileSync(noticesPath(p), `${JSON.stringify({ at: now.toISOString(), text, ...(keyboard?.length ? { keyboard } : {}), ...(html ? { html: true } : {}) })}\n`);
}

function readQueue(file) {
  const out = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try { const n = JSON.parse(line); if (n?.text) out.push(n); } catch {}
  }
  return out;
}

/**
 * Отправляет очередь по порядку. send(text, keyboard, { html }) бросает при сбое — неотправленные остаются в очереди до следующего раза.
 * Очередь забирается переименованием: новые записи, пришедшие во время отправки, попадают в новый файл и не теряются.
 * Вызывает только задание answers (один процесс), поэтому две отправки одной очереди не пересекаются.
 * Возвращает число отправленных.
 */
export async function flushNotices(p, send, { now = new Date(), log = () => {}, maxAgeHours = NOTICE_MAX_AGE_HOURS } = {}) {
  const file = noticesPath(p); const taking = `${file}.sending`;
  if (!fs.existsSync(taking)) { // .sending уже есть — прошлую отправку прервали, дошлём её
    try { fs.renameSync(file, taking); } catch (e) { if (e.code === 'ENOENT') return 0; throw e; }
  }
  const items = readQueue(taking);
  let sent = 0; let rest = [];
  for (const [i, n] of items.entries()) {
    const at = new Date(n.at);
    if (now - at > maxAgeHours * 3600_000) { log(`Устаревшее сообщение для Telegram (${fmtShort(at)}) не отправлено: старше ${maxAgeHours} ч.`); continue; }
    try { await send(`🕓 Не дошло вовремя (${fmtShort(at)}):\n${n.text}`, n.keyboard || null, { html: !!n.html }); sent += 1; }
    catch (e) {
      // Bad Request (разметка, длина) не пройдёт и потом: не держим им очередь 48 часов, остальные сообщения идут дальше
      if (/Bad Request/i.test(String(e?.message || e))) { log(`Сообщение из очереди отклонено Telegram и пропущено: ${String(e?.message || e).split('\n')[0]}`); continue; }
      rest = items.slice(i); log(`Очередь сообщений Telegram: отправлено ${sent}, осталось ${rest.length} (${String(e?.message || e).split('\n')[0]}).`); break;
    }
  }
  // Неотправленные — в начало очереди, перед пришедшими за время отправки. Всё ушло — файл очереди не трогаем.
  if (rest.length) {
    const fresh = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
    fs.writeFileSync(file, rest.map((n) => `${JSON.stringify(n)}\n`).join('') + fresh);
  }
  fs.unlinkSync(taking);
  if (sent) log(`Очередь сообщений Telegram: отправлено ${sent}.`);
  return sent;
}
