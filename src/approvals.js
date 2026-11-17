import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import crypto from 'node:crypto';
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
/** Изменения, ушедшие в архив после момента since (по времени папки): их образцы показывает ролик-сводка (0.12.0). */
export function archivedSince(changesDir, since) {
  const dir = path.join(changesDir, 'archive');
  if (!exists(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory() && !d.name.startsWith('.'))
    .map((d) => ({ d, at: fs.statSync(path.join(dir, d.name)).mtime })).filter((x) => !since || x.at > since).sort((a, b) => a.at - b.at)
    .map((x) => readChange(path.join(dir, x.d.name)));
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
export function requestApproval(change, { category = 'spec', priority, now = new Date(), idea, ideas = [] } = {}) {
  return writeMeta(change, { ...change.mcfly, approval: 'pending', category, ...(priority != null ? { priority: Number(priority) } : {}), ...(idea ? { idea } : {}), ...(ideas.length > 1 ? { ideas } : {}), requested_at: now.toISOString(), decided_at: '', by: '', note: '' });
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
/** Наименьший приоритет среди изменений в очереди (ждут одобрения или одобрены), кроме except; null — очередь пуста. */
function topPriority(changes, except = null) {
  const queue = changes.filter((c) => c.name !== except?.name && ['pending', 'approved'].includes(c.mcfly.approval));
  return queue.length ? Math.min(...queue.map(priorityOf)) : null;
}
/** Приоритет «раньше всех в очереди» (0.16.0): на единицу меньше наименьшего; очередь пуста — null (приоритет не нужен). */
export function firstPriority(changes, except = null) { const top = topPriority(changes, except); return top == null ? null : top - 1; }
/**
 * «⬆ Вперёд» (0.16.0): изменение, которое ждёт одобрения или одобрено, становится первым в очереди — решение владельца.
 * Возвращает { change, error }; уже первое — без изменений.
 */
export function moveFirst(changes, name) {
  const c = changes.find((x) => x.name === name);
  if (!c) return { change: null, error: 'такого изменения нет' };
  if (!['pending', 'approved'].includes(c.mcfly.approval)) return { change: c, error: 'поднять можно изменение, которое ждёт одобрения или одобрено' };
  const top = topPriority(changes, c);
  if (top == null || priorityOf(c) < top) return { change: c, error: null };
  writeMeta(c, { ...c.mcfly, priority: top - 1 });
  return { change: c, error: null };
}
const SAMPLES_HEAD = /^##\s+Как это будет выглядеть\s*$/im;
/**
 * Быстрый путь (0.16.0): почему план по взятым пунктам НЕ одобряется сразу; пустая строка — одобряется.
 * Условия проверяет код, а не команда: все пункты — размера из ideas.fast_sizes; категория с ответом по умолчанию (не prod);
 * в proposal есть раздел «Как это будет выглядеть» без образцов («Снаружи ничего не меняется»); задач не больше
 * limits.max_tasks_per_change; план не возвращали на одобрение (mcfly.held).
 */
export function fastTrackBlock(change, ideaItems, cfg, category = change.mcfly.category || 'spec') {
  const sizes = cfg.ideas?.fast_sizes || [];
  if (!sizes.length) return 'быстрый путь выключен (ideas.fast_sizes)';
  if (!ideaItems.length) return 'план не по взятому пункту';
  const big = ideaItems.find((x) => !sizes.includes(x.size));
  if (big) return `пункт ${big.id} размера ${big.size} — такие владелец одобряет сам`;
  if (!autoDefault(cfg, category)) return `категория ${category} — только решение владельца`;
  if (change.mcfly.held) return 'план уже возвращали на одобрение';
  if (!SAMPLES_HEAD.test(change.proposal || '')) return 'в плане нет раздела «Как это будет выглядеть»';
  if (proposalSamples(change).length) return 'изменение меняет то, что человек видит или нажимает';
  const tasks = change.tasksDone + change.tasksOpen;
  if (!tasks) return 'в плане нет задач';
  if (tasks > cfg.limits.max_tasks_per_change) return `задач ${tasks} — больше limits.max_tasks_per_change`;
  return '';
}
/**
 * Отпечаток плана (0.16.1): proposal.md и список задач без отметок «сделано». Быстрое одобрение относится к этому тексту:
 * изменился — одобрение больше не действует (иначе после «Одобрено сразу» в план можно было бы дописать что угодно).
 */
export function planHash(change) {
  const tasks = readText(path.join(change.dir, 'tasks.md'), '').replace(/^(\s*[-*+] )\[[ xX]\]/gm, '$1[ ]');
  return crypto.createHash('sha256').update(`${readText(path.join(change.dir, 'proposal.md'), '')}\n---\n${tasks}`).digest('hex').slice(0, 32);
}
/** Одобрить быстрым путём: решение кода по признакам плана; отпечаток плана сохраняется в метаданных. */
export function approveFast(change, note = '', now = new Date()) {
  return writeMeta(change, { ...change.mcfly, approval: 'approved', decided_at: now.toISOString(), by: 'fast', note, fast_hash: planHash(change) });
}
/** План быстро одобренного изменения тот же, что был при одобрении (нет отпечатка — не тот же). */
export const fastPlanIntact = (change) => Boolean(change.mcfly.fast_hash) && change.mcfly.fast_hash === planHash(change);
/**
 * Перепроверка быстрых одобрений (0.16.1): если proposal.md или список задач изменились после одобрения, изменение
 * возвращается на одобрение владельца. Вызывается в начале и в конце прогона. Возвращает возвращённые изменения.
 */
export function recheckFast(changes, now = new Date()) {
  const held = [];
  for (const c of changes) {
    if (!isFastApproved(c) || fastPlanIntact(c)) continue;
    holdApproval(c, 'план изменился после быстрого одобрения', now); held.push(c);
  }
  return held;
}
/** Одобрено быстрым путём (by: fast) — без второго нажатия владельца. */
export const isFastApproved = (change) => change.mcfly.approval === 'approved' && change.mcfly.by === 'fast';
/**
 * Вернуть быстро одобренный план на одобрение владельца (0.16.0, `mcfly approval hold`): страховка — можно и команде
 * в прогоне, потому что только ужесточает. Повторно быстрым путём такой план не одобрится (mcfly.held).
 */
export function holdApproval(change, note = '', now = new Date()) {
  return writeMeta(change, { ...change.mcfly, approval: 'pending', held: true, requested_at: now.toISOString(), decided_at: '', by: '', note });
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

const BUTTON_ROW = /^\s*(\[[^\[\]\n]+\]\s*)+$/;
/**
 * Образцы из раздела «## Как это будет выглядеть» proposal (0.10.0): [{ title, text, buttons }] — подзаголовок «### …» и блок
 * в тройных обратных кавычках; строки вида «[Готово] [Отложить]» внутри блока — ряды кнопок. Раздела или блоков нет — пустой список
 * («Снаружи ничего не меняется» — не образец). Подзаголовок без блока — образец из одного заголовка: на экране ничего не появляется.
 */
export function proposalSamples(change) {
  const out = []; let on = false; let fence = false; let title = ''; let cur = null;
  for (const line of String(change.proposal || '').split('\n')) {
    if (!fence && /^##\s/.test(line)) { on = /^##\s+Как это будет выглядеть\s*$/i.test(line.trim()); continue; }
    if (!on) continue;
    if (/^\s*```/.test(line)) {
      fence = !fence;
      if (fence) cur = { title, lines: [] }; else { out.push(cur); cur = null; title = ''; }
      continue;
    }
    if (fence) { cur.lines.push(line); continue; }
    const h = /^###\s+(.+?)\s*$/.exec(line);
    // 0.11.0: подзаголовок без блока — случай, когда пользователь ничего не видит («Пишет кто-то другой — бот молчит»)
    if (h) { if (title) out.push({ title, lines: [] }); title = h[1]; }
  }
  if (title) out.push({ title, lines: [] });
  return out.map((x) => ({
    title: x.title,
    text: x.lines.filter((l) => !BUTTON_ROW.test(l)).join('\n').trim(),
    buttons: x.lines.filter((l) => BUTTON_ROW.test(l)).map((l) => [...l.matchAll(/\[([^\[\]\n]+)\]/g)].map((m) => m[1].trim())),
  })).filter((x) => x.text || x.buttons.length || x.title);
}
