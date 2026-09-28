import { localDateKey } from './util.js';

export function parseSlot(slot) {
  const m = /^(\d{2}):(\d{2})$/.exec(String(slot));
  if (!m) throw new Error(`Неверный слот: ${slot}`);
  return Number(m[1]) * 60 + Number(m[2]);
}
export function minutesOfDay(d) { return d.getHours() * 60 + d.getMinutes(); }
export function slotKey(date, slot) { return `${localDateKey(date)}-${slot}`; }

/** Слот, в окне [slot, slot+tolerance] которого находится now, иначе null. */
export function matchSlot(now, slots, toleranceMinutes) {
  const nowMin = minutesOfDay(now);
  let best = null;
  for (const slot of slots) {
    const diff = (nowMin - parseSlot(slot) + 1440) % 1440;
    if (diff <= toleranceMinutes && (best === null || diff < best.diff)) best = { slot, diff };
  }
  return best ? best.slot : null;
}

/** Ожидаемые запуски между since (искл.) и until (вкл.). */
export function expectedSlots(since, until, slots) {
  const out = [];
  const day = new Date(since.getFullYear(), since.getMonth(), since.getDate());
  for (let d = new Date(day); d <= until; d.setDate(d.getDate() + 1)) {
    for (const slot of slots) {
      const min = parseSlot(slot);
      const at = new Date(d.getFullYear(), d.getMonth(), d.getDate(), Math.floor(min / 60), min % 60);
      if (at > since && at <= until) out.push({ slot, at, key: slotKey(at, slot) });
    }
  }
  return out.sort((a, b) => a.at - b.at);
}
