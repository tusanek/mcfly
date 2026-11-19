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
/** Категория эскалации изменения — для плана, одобряемого без запроса (доделка, 0.17.0). */
export function writeCategory(change, category) { return writeMeta(change, { ...change.mcfly, category }); }
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
// 0.17.0: план, который команда вернула владельцу (mcfly.held), молчанием тоже не одобряется
export function isAutoApprovable(change, cfg) { return !change.mcfly.idea && !change.mcfly.held && autoDefault(cfg, change.mcfly.category || 'spec'); }
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
/** Текст раздела «Как это будет выглядеть» плана (до следующего заголовка второго уровня); раздела нет — пустая строка. */
function samplesSection(change) {
  const out = []; let on = false;
  for (const line of String(change.proposal || '').split('\n')) {
    if (/^##\s/.test(line)) { if (on) break; on = SAMPLES_HEAD.test(line); continue; }
    if (on) out.push(line);
  }
  return out.join('\n');
}
/** Пометка планировщика «Правка существующего: <что и где>» в разделе образцов (0.17.0). */
const EDIT_MARK = /^\s*Правка существующего\s*[:：]\s*\S/im;
/**
 * Что в плане с видимым (0.17.0): '' — годится для одобрения без владельца, иначе причина отказа. Годится, если в разделе
 * «Как это будет выглядеть» нет образцов («Снаружи ничего не меняется») либо, при ideas.fast_edits, это правка существующего:
 * строка «Правка существующего: …», а задач не больше escalation.small_change_max_tasks.
 */
function visibleBlock(change, cfg) {
  if (!SAMPLES_HEAD.test(change.proposal || '')) return 'в плане нет раздела «Как это будет выглядеть»';
  if (!proposalSamples(change).length) return '';
  if (!cfg.ideas?.fast_edits || !EDIT_MARK.test(samplesSection(change))) return 'изменение меняет то, что человек видит или нажимает';
  const tasks = change.tasksDone + change.tasksOpen; const max = Number(cfg.escalation.small_change_max_tasks || 0);
  if (tasks > max) return `правка видимого на ${tasks} задач — больше escalation.small_change_max_tasks`;
  return '';
}
/** Вид плана, одобренного без владельца: edit — правка существующего видимого, quiet — снаружи ничего не меняется. */
export const fastKind = (change) => (proposalSamples(change).length ? 'edit' : 'quiet');
/**
 * Быстрый путь (0.16.0): почему план по взятым пунктам НЕ одобряется сразу; пустая строка — одобряется.
 * Условия проверяет код, а не команда: все пункты — размера из ideas.fast_sizes; категория с ответом по умолчанию (не prod);
 * план не возвращали на одобрение (mcfly.held); задач не больше limits.max_tasks_per_change; с видимым — см. visibleBlock
 * (правка существующего — только для пунктов S). Пункт «вернуть изменение» (revert_of, 0.17.0) проверку видимого не проходит:
 * владелец уже решил.
 */
export function fastTrackBlock(change, ideaItems, cfg, category = change.mcfly.category || 'spec') {
  const sizes = cfg.ideas?.fast_sizes || [];
  if (!sizes.length) return 'быстрый путь выключен (ideas.fast_sizes)';
  if (!ideaItems.length) return 'план не по взятому пункту';
  const big = ideaItems.find((x) => !sizes.includes(x.size));
  if (big) return `пункт ${big.id} размера ${big.size} — такие владелец одобряет сам`;
  if (!autoDefault(cfg, category)) return `категория ${category} — только решение владельца`;
  if (change.mcfly.held) return 'план уже возвращали на одобрение';
  const tasks = change.tasksDone + change.tasksOpen;
  if (!tasks) return 'в плане нет задач';
  if (tasks > cfg.limits.max_tasks_per_change) return `задач ${tasks} — больше limits.max_tasks_per_change`;
  if (ideaItems.every((x) => x.revert_of)) return '';
  const visible = visibleBlock(change, cfg);
  if (visible) return visible;
  const notSmall = fastKind(change) === 'edit' && ideaItems.find((x) => x.size !== 'S');
  if (notSmall) return `правка видимого без одобрения — только для небольших пунктов, а ${notSmall.id} размера ${notSmall.size}`;
  return '';
}
/**
 * Доделка без одобрения (0.17.0, `approval request --followup <родитель>`): почему НЕ одобряется; пустая строка — одобряется.
 * Доделка — небольшая работа к уже завершённому изменению: родитель в архиве, задач не больше
 * escalation.small_change_max_tasks, категория с ответом по умолчанию, за прогон — не больше limits.followups_per_run
 * (used — сколько уже одобрено в этом прогоне), с видимым — см. visibleBlock.
 */
export function followupBlock(change, cfg, { parentArchived, used = 0, category = change.mcfly.category || 'spec' }) {
  const max = Number(cfg.limits.followups_per_run || 0);
  if (!max) return 'доделки без одобрения выключены (limits.followups_per_run)';
  if (!parentArchived) return 'родительского изменения нет в архиве — доделка возможна только к завершённой работе';
  if (used >= max) return `за этот прогон уже ${used} доделок — предел limits.followups_per_run`;
  if (!autoDefault(cfg, category)) return `категория ${category} — только решение владельца`;
  if (change.mcfly.held) return 'план уже возвращали на одобрение';
  const tasks = change.tasksDone + change.tasksOpen; const small = Number(cfg.escalation.small_change_max_tasks || 0);
  if (!tasks) return 'в плане нет задач';
  if (tasks > small) return `задач ${tasks} — для доделки много (escalation.small_change_max_tasks)`;
  return visibleBlock(change, cfg);
}
/**
 * Отпечаток плана (0.16.1): proposal.md и список задач без отметок «сделано». Быстрое одобрение относится к этому тексту:
 * изменился — одобрение больше не действует (иначе после «Одобрено сразу» в план можно было бы дописать что угодно).
 */
export function planHash(change) {
  const tasks = readText(path.join(change.dir, 'tasks.md'), '').replace(/^(\s*[-*+] )\[[ xX]\]/gm, '$1[ ]');
  // 0.19.0: строки «Картинка:» в отпечаток не входят — картинки к образцам можно дорисовать после одобрения
  const proposal = readText(path.join(change.dir, 'proposal.md'), '').split('\n').filter((l) => !PICTURE.test(l)).join('\n');
  return crypto.createHash('sha256').update(`${proposal}\n---\n${tasks}`).digest('hex').slice(0, 32);
}
/** Одобрить быстрым путём: решение кода по признакам плана; отпечаток плана сохраняется в метаданных. */
export function approveFast(change, note = '', now = new Date(), { by = 'fast', followupOf = '' } = {}) {
  return writeMeta(change, { ...change.mcfly, approval: 'approved', decided_at: now.toISOString(), by, note, fast_hash: planHash(change), fast_kind: fastKind(change), ...(followupOf ? { followup_of: followupOf } : {}) });
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
/** Есть ли в изменении дельты спецификаций (specs/<область>/spec.md). */
export function hasDeltas(change) {
  const dir = path.join(change.dir, 'specs'); if (!fs.existsSync(dir)) return false;
  return fs.readdirSync(dir, { withFileTypes: true }).some((d) => d.isDirectory() && fs.existsSync(path.join(dir, d.name, 'spec.md')));
}
/**
 * Доделка-уборка без дельт (0.18.5): openspec validate --strict требует дельту или skip_specs: true, а роли пропускать дельты
 * без одобрения запрещено. Ставит mcfly, а не роль, и только доделке «снаружи ничего не меняется» без дельт: это решение кода
 * по признакам плана, как и само одобрение доделки. true — пометка поставлена.
 */
export function markNoSpecs(change) {
  if (change.mcfly.by !== 'followup' || fastKind(change) !== 'quiet' || hasDeltas(change)) return false;
  const meta = { ...change.meta, skip_specs: true };
  writeText(path.join(change.dir, '.openspec.yaml'), YAML.stringify(meta)); change.meta = meta;
  return true;
}
/** Кем одобрено без владельца: fast — быстрый путь после «Берём», followup — доделка без «Берём» (0.17.0). */
export const FAST_BY = ['fast', 'followup'];
export const isFastApproved = (change) => change.mcfly.approval === 'approved' && FAST_BY.includes(change.mcfly.by);
/**
 * «Закрыть без работы» (0.17.0): владелец закрывает изменение, которое не нужно делать. Пометка closed — команда в начале
 * прогона убирает папку такого изменения.
 */
export function closeChange(change, by, note = '', now = new Date()) {
  return writeMeta(change, { ...change.mcfly, approval: 'rejected', closed: true, decided_at: now.toISOString(), by, note: note || 'закрыто владельцем без работы' });
}
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
/** Строка картинки образца (0.19.0): «Картинка: <путь от корня проекта>». */
const PICTURE = /^\s*Картинка\s*[:：]\s*(\S.*?)\s*$/;
/** Файл картинки образца (0.19.0): абсолютный путь, если это PNG/JPG внутри проекта и он есть, иначе null. */
export function sampleImage(projectDir, rel) {
  const root = path.resolve(projectDir); const file = path.resolve(root, String(rel || ''));
  if (!file.startsWith(root + path.sep) || !/\.(png|jpe?g)$/i.test(file)) return null;
  try { return fs.statSync(file).isFile() ? file : null; } catch { return null; }
}
export function proposalSamples(change) {
  const out = []; let on = false; let fence = false; let title = ''; let cur = null; const pics = {};
  for (const line of String(change.proposal || '').split('\n')) {
    if (!fence && /^##\s/.test(line)) { on = /^##\s+Как это будет выглядеть\s*$/i.test(line.trim()); continue; }
    if (!on) continue;
    if (/^\s*```/.test(line)) {
      fence = !fence;
      if (fence) cur = { title, lines: [], images: pics[title] || [] }; else { out.push(cur); cur = null; title = ''; }
      continue;
    }
    if (fence) { cur.lines.push(line); continue; }
    // 0.19.0: «Картинка: <путь>» под подзаголовком — картинка образца (вне блока); относится к последнему образцу этого подзаголовка
    const pic = PICTURE.exec(line);
    if (pic) { const last = out.at(-1); if (title) (pics[title] ||= []).push(pic[1].trim()); else if (last) (last.images ||= []).push(pic[1].trim()); continue; }
    const h = /^###\s+(.+?)\s*$/.exec(line);
    // 0.11.0: подзаголовок без блока — случай, когда пользователь ничего не видит («Пишет кто-то другой — бот молчит»)
    if (h) { if (title) out.push({ title, lines: [], images: pics[title] || [] }); title = h[1]; }
  }
  if (title) out.push({ title, lines: [], images: pics[title] || [] });
  return out.map((x) => ({
    title: x.title,
    text: x.lines.filter((l) => !BUTTON_ROW.test(l)).join('\n').trim(),
    buttons: x.lines.filter((l) => BUTTON_ROW.test(l)).map((l) => [...l.matchAll(/\[([^\[\]\n]+)\]/g)].map((m) => m[1].trim())),
    images: x.images || [],
  })).filter((x) => x.text || x.buttons.length || x.title || x.images.length);
}
