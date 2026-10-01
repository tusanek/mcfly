import fs from 'node:fs';
import path from 'node:path';
import { readText, writeText, pad2 } from './util.js';

const NAME = /^(\d{8}-\d{4})-(day|night)(?:-(\d+))?\.md$/;
export const REQUIRED = ['# Смена:', '## Изменения', ['## Порядок', '## Предложение на день'], '## Нужны решения человека', '## Заметки'];

export function shiftFileName(kind, now) {
  return `${now.getFullYear()}${pad2(now.getMonth() + 1)}${pad2(now.getDate())}-${pad2(now.getHours())}${pad2(now.getMinutes())}-${kind}.md`;
}
/** Файлы смен по возрастанию времени (суффикс -2, -3 — позже основного). */
export function listShifts(p) {
  let files = [];
  try { files = fs.readdirSync(p.shifts); } catch { return []; }
  return files.map((file) => ({ file, m: NAME.exec(file) })).filter((x) => x.m)
    .map(({ file, m }) => ({ file, path: path.join(p.shifts, file), kind: m[2], at: m[1], n: Number(m[3] || 1) }))
    .sort((a, b) => (a.at === b.at ? a.n - b.n : a.at < b.at ? -1 : 1))
    .map(({ n, ...s }) => s);
}
export function latestShift(p, kind) { return listShifts(p).filter((s) => s.kind === kind).at(-1) || null; }
/** Действующая дневная передача: последняя дневная, если она позже последней ночной. */
export function activeDayHandoff(p) {
  const all = listShifts(p);
  const last = all.at(-1);
  if (!last || last.kind !== 'day') return null;
  return { file: last.file, path: last.path, text: readText(last.path, '') };
}
export function validateHandoff(text) {
  const lines = String(text || '').split('\n').map((l) => l.trim());
  const has = (h) => lines.some((l) => l === h || l.startsWith(`${h} `) || (h.endsWith(':') && l.startsWith(h)));
  return REQUIRED.filter((h) => (Array.isArray(h) ? !h.some(has) : !has(h))).map((h) => (Array.isArray(h) ? h.join(' или ') : h));
}
/** Имена изменений: заголовки «### <имя> — …» и строки «1. <имя>» в разделе порядка. */
export function mentionedChanges(text) {
  const names = []; let inOrder = false;
  for (const line of String(text || '').split('\n')) {
    const h3 = /^###\s+([\w.-]+)\s+—/.exec(line);
    if (h3) names.push(h3[1]);
    if (/^##\s/.test(line)) inOrder = /^##\s+(Порядок|Предложение на день)\s*$/.test(line);
    const item = inOrder && /^\s*\d+\.\s+([\w.-]+)/.exec(line);
    if (item) names.push(item[1]);
  }
  return [...new Set(names)];
}
/** Пишет файл смены, не перезаписывая: занято — суффикс -2, -3. */
export function writeShift(p, kind, text, now) {
  const base = shiftFileName(kind, now).replace(/\.md$/, '');
  for (let n = 1; ; n++) {
    const file = path.join(p.shifts, `${base}${n > 1 ? `-${n}` : ''}.md`);
    if (!fs.existsSync(file)) { writeText(file, text); return file; }
  }
}
