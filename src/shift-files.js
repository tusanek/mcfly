import fs from 'node:fs';
import path from 'node:path';
import { readText, writeText, pad2, fmtLocal } from './util.js';
import { branchProgress, teamWorktrees, shiftBranches, branchSha } from './git.js';
import { listChanges, priorityOf } from './approvals.js';

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
    .sort((a, b) => (a.at !== b.at ? (a.at < b.at ? -1 : 1) : a.kind !== b.kind ? (a.kind === 'day' ? -1 : 1) : a.n - b.n)) // одна минута: день раньше ночи
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
  // Заголовок раздела — ровно как в формате: «## Порядок на ночь» лид и сводка не узнают, значит и проверка его не принимает.
  const has = (h) => lines.some((l) => l === h || (h.endsWith(':') && l.startsWith(h)));
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

/** Авто-передача по фактам: одобренные изменения с прогрессом по веткам, грязные worktree команды, несданная дневная работа. */
export function renderAutoHandoff(p, kind, now, { runs = [] } = {}) {
  const approved = listChanges(p.openspecChanges).filter((c) => c.mcfly.approval === 'approved' && c.tasksOpen + c.tasksDone > 0)
    .sort((a, b) => priorityOf(a) - priorityOf(b));
  const team = teamWorktrees(p.projectDir);
  const shifts = shiftBranches(p.projectDir);
  const L = [`# Смена: ${kind === 'day' ? 'день → ночь' : 'ночь → день'}, ${fmtLocal(now)} (источник: авто)`];
  if (kind === 'night' && runs.length) L.push(`Прогоны: ${runs.map((id) => `runs/${id}`).join(', ')}`);
  L.push('## Изменения');
  const active = approved.filter((c) => { const b = branchProgress(p.projectDir, c.name); return (b ? b.open : c.tasksOpen) > 0; });
  for (const c of active) {
    const b = branchProgress(p.projectDir, c.name);
    const x = b || { done: c.tasksDone, open: c.tasksOpen };
    const sha = b ? branchSha(p.projectDir, `change/${c.name}`) : null;
    L.push(`### ${c.name} — ${b ? `ветка change/${c.name} @ ${sha}` : 'ветки нет'}, задач ${x.done}/${x.done + x.open}`);
    const dirty = team.filter((w) => w.branch === `change/${c.name}` && w.dirty > 0);
    L.push(`- Где остановились: ${dirty.length ? `незакоммиченное в ${dirty.map((w) => `${w.path} (${w.dirty})`).join(', ')}` : 'по tasks.md ветки — первая задача без [x]'}`);
    for (const s of shifts.filter((s) => s.change === c.name && (s.ahead > 0 || s.dirty > 0))) {
      L.push(`- Не трогать: ${s.branch} — не сдано днём (коммитов ${s.ahead}${s.dirty ? `, незакоммиченных файлов ${s.dirty}` : ''}), не повторять эту работу`);
    }
  }
  if (!active.length) L.push('- одобренных изменений с открытыми задачами нет');
  L.push(kind === 'day' ? '## Порядок' : '## Предложение на день');
  L.push(...(active.length ? active.map((c, i) => `${i + 1}. ${c.name}`) : ['- нет']));
  const rest = shifts.filter((s) => !active.some((c) => c.name === s.change) && (s.ahead > 0 || s.dirty > 0));
  L.push('## Нужны решения человека', active.length ? '- нет' : '- одобрить следующее изменение', '## Заметки', '- передача собрана автоматически: смену не сдавали');
  for (const s of rest) L.push(`- Не трогать: ${s.branch} — не сдано днём (коммитов ${s.ahead}${s.dirty ? `, незакоммиченных файлов ${s.dirty}` : ''}), изменение вне работы ночи`);
  return L.join('\n') + '\n';
}
