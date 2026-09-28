import fs from 'node:fs';
import path from 'node:path';

export function ensureDir(p) { fs.mkdirSync(p, { recursive: true }); return p; }
export function exists(p) { try { fs.accessSync(p); return true; } catch { return false; } }
export function readText(p, fallback = '') { try { return fs.readFileSync(p, 'utf8'); } catch { return fallback; } }
export function writeText(p, s) { ensureDir(path.dirname(p)); fs.writeFileSync(p, s); }
export function appendText(p, s) { ensureDir(path.dirname(p)); fs.appendFileSync(p, s); }
export function readJson(p, fallback = null) {
  const t = readText(p, '');
  if (!t.trim()) return fallback;
  try { return JSON.parse(t); } catch { return fallback; }
}
export function writeJson(p, obj) { writeText(p, JSON.stringify(obj, null, 2) + '\n'); }
export function pad2(n) { return String(n).padStart(2, '0'); }
export function fmtLocal(d) { return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`; }
export function fmtShort(d) { return `${pad2(d.getDate())}.${pad2(d.getMonth() + 1)} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`; }
export function runId(d) { return `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}-${pad2(d.getHours())}${pad2(d.getMinutes())}`; }
export function fmtDuration(ms) { const m = Math.round(ms / 60000); return m < 60 ? `${m} мин` : `${Math.floor(m / 60)} ч ${pad2(m % 60)} мин`; }
export function truncate(s, n) { return s.length <= n ? s : s.slice(0, n - 1) + '…'; }
export function localDateKey(d) { return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`; }
