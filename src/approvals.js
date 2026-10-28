import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { readText, writeText, exists, truncate } from './util.js';
import { autoDefault } from './config.js';

export const priorityOf = (change) => Number(change.mcfly?.priority ?? 100);
/** Число отмеченных и открытых задач в тексте tasks.md. */
export function countTasks(text) {
  return { done: (text.match(/^\s*- \[x\]/gim) || []).length, open: (text.match(/^\s*- \[ \]/gim) || []).length };
}
export function readChange(dir) {
  const meta = YAML.parse(readText(path.join(dir, '.openspec.yaml'), '')) || {};
  const { done: tasksDone, open: tasksOpen } = countTasks(readText(path.join(dir, 'tasks.md'), ''));
  return { name: path.basename(dir), dir, meta, mcfly: meta.mcfly || {}, tasksDone, tasksOpen, proposal: readText(path.join(dir, 'proposal.md'), '') };
}
export function listChanges(changesDir) {
  if (!exists(changesDir)) return [];
  return fs.readdirSync(changesDir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && d.name !== 'archive' && !d.name.startsWith('.'))
    .map((d) => readChange(path.join(changesDir, d.name)))
    .sort((a, b) => (priorityOf(a) - priorityOf(b)) || a.name.localeCompare(b.name));
}
function writeMeta(change, mcfly) {
  const meta = { ...change.meta, mcfly };
  writeText(path.join(change.dir, '.openspec.yaml'), YAML.stringify(meta));
  change.meta = meta; change.mcfly = mcfly;
  return change;
}
export function requestApproval(change, { category = 'spec', priority, now = new Date(), idea } = {}) {
  return writeMeta(change, { ...change.mcfly, approval: 'pending', category, ...(priority != null ? { priority: Number(priority) } : {}), ...(idea ? { idea } : {}), requested_at: now.toISOString(), decided_at: '', by: '', note: '' });
}
export function setApproval(change, status, by, note = '', now = new Date(), { priority } = {}) {
  return writeMeta(change, { ...change.mcfly, approval: status, ...(priority != null ? { priority: Number(priority) } : {}), decided_at: now.toISOString(), by, note });
}
/** Мелкое изменение: задач не больше escalation.small_change_max_tasks (0 — мелких нет). */
export function isSmallChange(change, cfg) {
  const max = Number(cfg.escalation.small_change_max_tasks || 0);
  return max > 0 && change.tasksDone + change.tasksOpen <= max;
}
/** Срок авто-одобрения: у мелких изменений — escalation.small_approval_deadline_hours, у остальных — approval_deadline_hours. */
export function approvalDeadline(change, cfg) {
  const hours = isSmallChange(change, cfg) ? cfg.escalation.small_approval_deadline_hours : cfg.escalation.approval_deadline_hours;
  return new Date(new Date(change.mcfly.requested_at || 0).getTime() + hours * 3600_000);
}
/** План по пункту списка предложений (mcfly.idea, 0.7.0) молчанием не одобряется — только кнопкой владельца. */
export function isAutoApprovable(change, cfg) { return !change.mcfly.idea && autoDefault(cfg, change.mcfly.category || 'spec'); }
/** Авто-одобряет просроченные pending-изменения (кроме категорий без auto_default). */
export function expireApprovals(changes, cfg, now = new Date()) {
  const auto = [];
  for (const c of changes) {
    if (c.mcfly.approval !== 'pending' || !isAutoApprovable(c, cfg)) continue;
    if (approvalDeadline(c, cfg) <= now) { setApproval(c, 'approved', 'default', 'авто-одобрение по истечении срока', now); auto.push(c); }
  }
  return auto;
}
export const pendingApprovals = (changes) => changes.filter((c) => c.mcfly.approval === 'pending');
/** Дата ГГГГ-ММ-ДД, с которой отложенное изменение снова в работе (0.7.6); null — не отложено или дата кривая. */
export function pausedUntil(change) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(change.mcfly?.paused_until || ''));
  return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : null;
}
export const isPaused = (change, now = new Date()) => { const d = pausedUntil(change); return Boolean(d) && now < d; };
const hasWork = (c) => c.mcfly.approval === 'approved' && c.tasksOpen > 0;
/** Одобренные с открытыми задачами — работа команды; отложенные владельцем до даты (mcfly.paused_until) в неё не входят. */
export const approvedWithWork = (changes, now = new Date()) => changes.filter((c) => hasWork(c) && !isPaused(c, now));
export const pausedChanges = (changes, now = new Date()) => changes.filter((c) => hasWork(c) && isPaused(c, now));
/** Отложить изменение до даты (решение человека): команда его не берёт, сводка показывает «отложено до». */
export function setPause(change, until, note = '', now = new Date()) {
  return writeMeta(change, { ...change.mcfly, paused_until: until, pause_note: note, paused_at: now.toISOString() });
}
export function clearPause(change) {
  const { paused_until: _u, pause_note: _n, paused_at: _a, ...rest } = change.mcfly;
  return writeMeta(change, rest);
}
/** Первый абзац текста proposal: заголовки markdown («# …», «## Why») и пустые строки пропускаются. */
export function proposalExcerpt(change, n = 600) {
  const para = [];
  for (const line of String(change.proposal || '').split('\n')) {
    if (/^\s*#/.test(line) || !line.trim()) { if (para.length) break; continue; }
    para.push(line.trim());
  }
  return truncate(para.join(' '), n);
}
