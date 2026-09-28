import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { readText, writeText, exists, truncate } from './util.js';

export const priorityOf = (change) => Number(change.mcfly?.priority ?? 100);
export function readChange(dir) {
  const meta = YAML.parse(readText(path.join(dir, '.openspec.yaml'), '')) || {};
  const tasks = readText(path.join(dir, 'tasks.md'), '');
  const tasksDone = (tasks.match(/^\s*- \[x\]/gim) || []).length;
  const tasksOpen = (tasks.match(/^\s*- \[ \]/gim) || []).length;
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
export function requestApproval(change, { category = 'spec', priority, now = new Date() } = {}) {
  return writeMeta(change, { ...change.mcfly, approval: 'pending', category, ...(priority != null ? { priority: Number(priority) } : {}), requested_at: now.toISOString(), decided_at: '', by: '', note: '' });
}
export function setApproval(change, status, by, note = '', now = new Date(), { priority } = {}) {
  return writeMeta(change, { ...change.mcfly, approval: status, ...(priority != null ? { priority: Number(priority) } : {}), decided_at: now.toISOString(), by, note });
}
export function approvalDeadline(change, cfg) {
  return new Date(new Date(change.mcfly.requested_at || 0).getTime() + cfg.escalation.approval_deadline_hours * 3600_000);
}
export function isAutoApprovable(change, cfg) {
  const cat = cfg.escalation.categories[change.mcfly.category || 'spec'] || {};
  return cat.auto_default !== false;
}
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
export const approvedWithWork = (changes) => changes.filter((c) => c.mcfly.approval === 'approved' && c.tasksOpen > 0);
export function proposalExcerpt(change, n = 600) {
  return truncate(change.proposal.replace(/^#[^\n]*\n?/m, '').trim(), n);
}
