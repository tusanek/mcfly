import fs from 'node:fs';
import path from 'node:path';
import { ensureDir, writeJson, pad2, fmtShort, fmtDuration, truncate, withFileLock } from './util.js';
import { listActions } from './action-config.js';

/**
 * Напоминания владельцу (0.8.0): «напомни 19:00 нажать 🧪 Eval промптов» в чате бота → сообщение в этот же чат в срок.
 * Хранятся в mcfly/logs/reminders.json (вне git, переживает перезапуск); срок проверяет задание answers на каждом
 * круге опроса — отдельного демона нет. Отправленным напоминание считается только после того, как Telegram принял
 * сообщение: повтора нет, а при обрыве связи оно уйдёт на следующем круге. Просроченное (Mac спал) — с пометкой.
 */
export const remindersPath = (p) => path.join(p.logs, 'reminders.json');
/** Опоздание больше этого — пометка «🕓 Опоздало на …» (круг опроса длится до ~25 с, это не опоздание). */
export const LATE_MS = 5 * 60_000;
export const SNOOZE_MS = 60 * 60_000;
/** Отправленные, отменённые и отклонённые Telegram хранятся неделю, потом удаляются из файла. */
export const KEEP_DONE_MS = 7 * 24 * 3600_000;
const TEXT_MAX = 1000;
const LIST_MAX = 20;
export const REMIND_EXAMPLES = '«напомни 19:00 нажать 🧪 Eval промптов», «напомни завтра 10:00 …», «напомни 08.11 10:00 …», «напомни через 2 ч …»';

// ---------- файл ----------
function load(p) {
  let raw = '';
  try { raw = fs.readFileSync(remindersPath(p), 'utf8'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  if (!raw.trim()) return { next: 1, items: [] };
  let d;
  // повреждённый файл не затираем пустым списком: напоминания владельца пропали бы молча
  try { d = JSON.parse(raw); } catch { throw new Error('mcfly/logs/reminders.json повреждён — исправьте или удалите его'); }
  return { next: Number(d?.next) || 1, items: Array.isArray(d?.items) ? d.items : [] };
}
function save(p, d, now) {
  d.items = d.items.filter((r) => r.status === 'pending' || now - new Date(r.done_at || r.at) < KEEP_DONE_MS);
  ensureDir(p.logs);
  // атомарно: файл читают задание answers и mcfly remind
  const tmp = `${remindersPath(p)}.${process.pid}.tmp`; writeJson(tmp, d); fs.renameSync(tmp, remindersPath(p));
}
/** Чтение-изменение-запись под короткой блокировкой: ставит напоминание и прогон, и задание answers, и mcfly remind rm. */
function update(p, fn, now) { return withFileLock(`${remindersPath(p)}.lock`, () => { const d = load(p); const r = fn(d); save(p, d, now); return r; }); }

export function listReminders(p) { return load(p).items; }
/** Ожидающие, по сроку. */
export function pendingReminders(p) { return listReminders(p).filter((r) => r.status === 'pending').sort((a, b) => new Date(a.at) - new Date(b.at)); }

// ---------- время ----------
const timeOf = (d) => `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
const dayStart = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
/** «сегодня в 19:00», «завтра в 09:05», «09.11 в 09:05». */
export function whenText(at, now = new Date()) {
  const days = Math.round((dayStart(at) - dayStart(now)) / 86_400_000);
  if (days === 0) return `сегодня в ${timeOf(at)}`;
  if (days === 1) return `завтра в ${timeOf(at)}`;
  return `${pad2(at.getDate())}.${pad2(at.getMonth() + 1)} в ${timeOf(at)}`;
}
const finish = (at, rest) => {
  const text = truncate(String(rest || '').trim(), TEXT_MAX);
  return text ? { at, text } : { error: `⚠️ О чём напомнить? Напишите текст после времени, например ${REMIND_EXAMPLES.split(', ')[0]}` };
};
/**
 * Текст после «напомни» → { at, text } или { error }. Время — по часам Mac:
 * «[мне] [сегодня|завтра|послезавтра|ДД.ММ[.ГГГГ]] [в] ЧЧ:ММ текст» или «через N мин|ч текст», «через час», «через полчаса».
 * «19:00» без дня, если сегодня уже прошло, — завтра; дата без года, если прошла, — в следующем году.
 */
export function parseReminder(input, now = new Date()) {
  const s = String(input || '').trim().replace(/^мне\s+/i, '');
  let m;
  if ((m = /^через\s+(?:(\d+)\s*(минут[уы]?|мин\.?|м|часа|часов|час|ч\.?)|(час|полчаса))(?=\s|$)\s*([\s\S]*)$/i.exec(s))) {
    const ms = m[3] ? (m[3].toLowerCase() === 'час' ? 3_600_000 : 1_800_000) : Number(m[1]) * (/^м/i.test(m[2]) ? 60_000 : 3_600_000);
    if (!ms) return { error: '⚠️ Через сколько? Например, «напомни через 2 ч …»' };
    return finish(new Date(now.getTime() + ms), m[4]);
  }
  m = /^(?:(сегодня|завтра|послезавтра|(\d{1,2})\.(\d{1,2})(?:\.(\d{4}))?)\s+)?(?:в\s+)?(\d{1,2}):(\d{2})(?=\s|$)\s*([\s\S]*)$/i.exec(s);
  if (!m) return { error: `⚠️ Не понял, когда напомнить. Примеры: ${REMIND_EXAMPLES}` };
  const [, day, dd, mm, yyyy, hh, mi, rest] = m;
  if (Number(hh) > 23 || Number(mi) > 59) return { error: `⚠️ Нет такого времени: ${hh}:${mi}` };
  const make = (y, mo, d) => new Date(y, mo, d, Number(hh), Number(mi));
  let at;
  if (dd) {
    const y = yyyy ? Number(yyyy) : now.getFullYear(); const mo = Number(mm) - 1;
    at = make(y, mo, Number(dd));
    if (at.getMonth() !== mo || at.getDate() !== Number(dd)) return { error: `⚠️ Нет такой даты: ${dd}.${mm}` };
    if (!yyyy && at <= now) at = make(y + 1, mo, Number(dd));
  } else {
    const shift = { завтра: 1, послезавтра: 2 }[String(day || '').toLowerCase()] || 0;
    at = make(now.getFullYear(), now.getMonth(), now.getDate() + shift);
    if (!day && at <= now) at = make(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  }
  if (at <= now) return { error: `⚠️ Это время уже прошло (${fmtShort(at)})` };
  return finish(at, rest);
}

// ---------- изменения ----------
export function addReminder(p, { at, text, now = new Date() }) {
  return update(p, (d) => {
    const r = { id: `R${d.next}`, at: at.toISOString(), text, status: 'pending', created_at: now.toISOString() };
    d.next += 1; d.items.push(r); return r;
  }, now);
}
const missing = (id) => `⚠️ ${id}: такого напоминания нет`;
/** Ответ в чат на «отменить Rн» (кнопка ✖️ в списке). */
export function cancelReminder(p, id, now = new Date()) {
  return update(p, (d) => {
    const r = d.items.find((x) => x.id === id);
    if (!r) return missing(id);
    if (r.status === 'cancelled') return `ℹ️ ${id} уже отменено`;
    if (r.status !== 'pending') return `ℹ️ ${id} уже пришло`;
    r.status = 'cancelled'; r.done_at = now.toISOString();
    return `✖️ ${id} отменено: ${r.text}`;
  }, now);
}
/** Ответ в чат на «отложить Rн» (кнопка «⏰ Через час» под напоминанием): то же напоминание через час. */
export function snoozeReminder(p, id, now = new Date()) {
  return update(p, (d) => {
    const r = d.items.find((x) => x.id === id);
    if (!r) return missing(id);
    if (r.status === 'cancelled') return `ℹ️ ${id} отменено — поставьте новое: «напомни …»`;
    const at = new Date(now.getTime() + SNOOZE_MS);
    r.at = at.toISOString(); r.status = 'pending'; delete r.done_at;
    return `⏰ ${id}: напомню ${whenText(at, now)} — ${r.text}`;
  }, now);
}

// ---------- сообщения ----------
const plainTitle = (s) => String(s || '').replace(/^[^\p{L}\p{N}]+/u, '').trim().toLowerCase().replace(/ё/g, 'е');
/** Действия из раздела actions, названные в тексте (по названию кнопки без эмодзи): их кнопки — под напоминанием. */
export function mentionedActions(cfg, text) {
  const t = String(text || '').toLowerCase().replace(/ё/g, 'е');
  return listActions(cfg).filter((a) => plainTitle(a.title) && t.includes(plainTitle(a.title)));
}
/** Опоздание словами: «40 мин», «2 ч 10 мин». */
const lateText = (ms) => fmtDuration(ms);
/** Текст и кнопки напоминания r в момент now. */
export function reminderMessage(cfg, r, now = new Date()) {
  const at = new Date(r.at); const late = now - at;
  const L = [];
  if (late > LATE_MS) {
    const was = dayStart(at).getTime() === dayStart(now).getTime() ? timeOf(at) : fmtShort(at);
    L.push(`🕓 Опоздало на ${lateText(late)} (срок был ${was}) — Mac спал или не было связи`);
  }
  L.push(`🔔 Напоминание ${r.id}: ${r.text}`);
  // кнопка действия ведёт к обычному «что будет сделано» и «✅ Да» — напоминание само ничего не запускает
  const keyboard = [...mentionedActions(cfg, r.text).map((a) => [{ text: a.title, callback_data: `ac:${a.id}` }]), [{ text: '⏰ Через час', callback_data: `rs:${r.id}` }]];
  return { text: L.join('\n'), keyboard };
}

/**
 * Отправляет наступившие напоминания по порядку. send(text, keyboard) бросает при сбое: напоминание остаётся
 * ожидающим и уйдёт на следующем круге (остальные — тоже, чтобы не обгоняли). Bad Request не пройдёт и потом —
 * такое помечается failed и не держит остальные. Вызывает только задание answers (один отправитель). Возвращает число отправленных.
 */
export async function deliverDueReminders({ p, cfg, now = new Date(), send, log = () => {} }) {
  const due = pendingReminders(p).filter((r) => new Date(r.at) <= now);
  let sent = 0;
  for (const r of due) {
    const m = reminderMessage(cfg, r, now);
    let status = 'sent';
    try { await send(m.text, m.keyboard); sent += 1; } catch (e) {
      const line = String(e?.message || e).split('\n')[0];
      if (!/Bad Request/i.test(line)) { log(`Напоминание ${r.id} не отправлено: ${line}; повторю на следующем круге.`); break; }
      log(`Напоминание ${r.id} отклонено Telegram и пропущено: ${line}`); status = 'failed';
    }
    // пока отправляли, его могли отменить или отложить — тогда не трогаем
    update(p, (d) => {
      const x = d.items.find((i) => i.id === r.id);
      if (x && x.status === 'pending' && x.at === r.at) { x.status = status; x.done_at = now.toISOString(); }
    }, now);
  }
  if (sent) log(`Напоминаний отправлено: ${sent}.`);
  return sent;
}

/** «напоминания» и /reminders: ожидающие по сроку, у каждого кнопка «✖️ Отменить». Простой текст (не HTML). */
export function remindersView(p, now = new Date()) {
  const list = pendingReminders(p);
  if (!list.length) return { text: `🔔 Напоминаний нет. Поставить: ${REMIND_EXAMPLES}`, keyboard: [] };
  const shown = list.slice(0, LIST_MAX);
  const L = ['🔔 Напоминания', '', ...shown.map((r) => `${r.id} — ${whenText(new Date(r.at), now)}: ${truncate(r.text, 200)}`)];
  if (list.length > shown.length) L.push(`…и ещё ${list.length - shown.length} (mcfly remind list)`);
  return { text: L.join('\n'), keyboard: shown.map((r) => [{ text: `✖️ Отменить ${r.id}`, callback_data: `rx:${r.id}` }]) };
}
