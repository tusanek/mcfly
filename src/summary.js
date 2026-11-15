import path from 'node:path';
import fs from 'node:fs';
import { readText, fmtShort, fmtDay, fmtDuration, truncate, pad2 } from './util.js';
import { readMetrics, aggregate, formatEvents, runStats } from './metrics.js';
import { loadQuestions, openQuestions } from './questions.js';
import { listChanges, pendingApprovals, approvedWithWork, pausedChanges, pausedUntil, proposalExcerpt, approvalDeadline, isAutoApprovable } from './approvals.js';
import { loadIdeas, ideasBrief } from './ideas.js';
import { expectedSlots, slotKey } from './window.js';
import { loadState, saveState } from './state.js';
import { createTelegram, chunk } from './telegram.js';
import { branchProgress, branchTasks } from './git.js';
import { autoDefault } from './config.js';
import { latestShift } from './shift-files.js';
import { enqueueNotice } from './notices.js';
import { listActions } from './action-config.js';
import { currentRun } from './runner.js';

// 0.9.0: статусы для владельца — словами, без жаргона («квота», «API»)
export const STATUS_RU = { ok: 'прошёл успешно', missed: 'пропущен: Mac спал или был выключен', error: 'сорвался из-за сбоя', timeout: 'остановлен: не уложился в отведённое время', quota: 'остановлен: кончился лимит подписки', network: 'не состоялся: не было связи с Claude (проверьте VPN и интернет)', locked: 'не запускался: шёл другой прогон' };
/** Доля лимита подписки, с которой бот предупреждает владельца (до неё о лимите молчит). */
export const QUOTA_WARN = 0.8;

const STATUS_COUNT_RU = { ok: 'успешных', quota: 'остановлено по лимиту подписки', network: 'без связи', timeout: 'не уложилось во время', error: 'сорвалось', missed: 'пропущено', locked: 'не запускалось' };
/** «прогонов 3 (остановлено по лимиту подписки 2, успешных 1)» — частые статусы первыми. */
export function runsByStatus(agg) {
  const parts = Object.keys(STATUS_COUNT_RU).filter((s) => agg[s]).sort((a, b) => agg[b] - agg[a]).map((s) => `${STATUS_COUNT_RU[s]} ${agg[s]}`);
  return `прогонов ${agg.runs}${parts.length ? ` (${parts.join(', ')})` : ''}`;
}

const RUN_ICON = { ok: '✅', quota: '⏸', timeout: '⏱', network: '❌', error: '❌', missed: '💤', locked: '🔒' };
const TG_MAX = 4000; // предел куска при отправке: длина HTML не меньше текста, который считает Telegram
const EXCERPT = 160; // выдержка proposal в пункте одобрения
export const escHtml = (t) => String(t ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
/** Текст для консоли: без тегов и HTML-сущностей. */
export const htmlToPlain = (html) => String(html).replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
export const hhmm = (d) => `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
/** `код` из markdown отчёта — моноширинным, остальное экранировано. */
export const inline = (t) => escHtml(t).replace(/`([^`]+)`/g, '<code>$1</code>');

/** Строка прогона для владельца: «✅ 09:26 — прошёл успешно, 55 мин»; стоимость, попытки и текст ошибки — только в techTail. */
function runLine(r) {
  const when = r.slot || hhmm(new Date(r.started_at));
  const took = r.status === 'ok' && r.duration_ms ? `, ${fmtDuration(r.duration_ms)}` : '';
  return `${RUN_ICON[r.status] || '•'} ${escHtml(when)} — ${escHtml(STATUS_RU[r.status] || r.status)}${took}`;
}

/** Разделы markdown-отчёта: { 'Сделано': [строки], … }; авто-сводки runner'а — null. */
export function reportSections(text) {
  if (!text.trim() || /авто-сводка/.test(text.split('\n')[0])) return null;
  const out = {}; let cur = '';
  for (const line of text.split('\n')) {
    const h = /^##\s+(.+?)\s*$/.exec(line);
    if (h) { cur = h[1]; out[cur] = []; continue; }
    if (/^#\s/.test(line) || !line.trim()) continue;
    (out[cur] ||= []).push(line.replace(/^\s*[-*]\s+/, '').trim());
  }
  return out;
}
/** Строки раздела markdown-файла смены (без пустых), не больше n. */
function shiftSection(file, title, n = 6) {
  const text = readText(file, ''); const out = []; let on = false;
  for (const line of text.split('\n')) {
    if (/^##\s/.test(line)) { on = line.replace(/^##\s+/, '').trim() === title; continue; }
    if (on && line.trim()) out.push(line.trim());
  }
  return out.slice(0, n);
}
const shiftTime = (s) => new Date(Number(s.at.slice(0, 4)), Number(s.at.slice(4, 6)) - 1, Number(s.at.slice(6, 8)), Number(s.at.slice(9, 11)), Number(s.at.slice(11, 13)));
const PLAIN_MAX = 1500; // 0.9.0: пересказ — главное в сообщении, три абзаца
const PLAIN_LEAD = /^(Что сделано|Зачем|Что дальше):/;
/**
 * Раздел «Простыми словами» отчёта (для человека, не читающего код). С 0.9.0 — абзацы «Что сделано: / Зачем: / Что дальше:»,
 * каждый с новой строки; отчёт старого формата — одним абзацем. Нет раздела или «нет» — пустая строка.
 */
export function plainWords(sec, max = PLAIN_MAX) {
  const paras = [];
  for (const l of (sec?.['Простыми словами'] || []).filter((x) => !isNone(x))) {
    const line = l.replace(/`/g, '').replace(/\s+/g, ' ').trim();
    if (!line) continue;
    if (PLAIN_LEAD.test(line) || !paras.length) paras.push(line); else paras[paras.length - 1] += ` ${line}`;
  }
  return paras.length ? truncate(paras.join('\n'), max) : '';
}
/** Пересказ для HTML: экранирован, начала абзацев («Что сделано:») — жирным. */
export const plainHtml = (text) => escHtml(text).split('\n').map((l) => l.replace(PLAIN_LEAD, '<b>$1:</b>')).join('\n');
export const isNone = (l) => !l || /^(нет|ничего)\.?$/i.test(l);
/** Пункты «от человека»: раздел «Нужно от человека», у старых отчётов — строки «От вас: …». */
export function humanItems(sec) {
  const items = sec['Нужно от человека'] || Object.values(sec).flat().filter((l) => /^от вас(?=[\s:—-])/i.test(l)).map((l) => l.replace(/^от вас\s*[:—-]?\s*/i, ''));
  return items.filter((l) => !isNone(l));
}
/** Пункт для сравнения: регистр, «ё», `код`, <code>, пунктуация и пробелы не важны. */
// Точка между цифрами — часть числа («1.2» и «1.2.1» — разные версии), остальная пунктуация не важна.
const normItem = (t) => String(t).toLowerCase().replace(/ё/g, 'е').replace(/<\/?code>|`/g, '').replace(/(\d)\.(?=\d)/g, '$1d').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
/** Основы слов пункта: первые 5 букв, чтобы «предложения» и «предложениям» совпали. */
const stems = (n) => new Set(n.split(' ').filter((w) => w.length >= 4).map((w) => w.slice(0, 5)));
const numbered = (n) => n.split(' ').filter((w) => /\d/.test(w)).sort().join(' ');
/**
 * Пересказ того же пункта (0.7.7): отчёт и передача смены пишут одну просьбу разными словами — общих основ не меньше половины всех
 * и от трёх, а числа и номера (версии, I75, «задача 3») одни и те же. Основы — слова от 4 букв; все основы одного пункта есть
 * в другом (0.7.13: «на сервере» и «на стенде», «локально» — разные просьбы, у каждой своё слово).
 */
function sameAsk(a, b) {
  if (numbered(a) !== numbered(b)) return false;
  const x = stems(a); const y = stems(b); const common = [...x].filter((w) => y.has(w)).length;
  return common >= 3 && common === Math.min(x.size, y.size) && common / (x.size + y.size - common) >= 0.5;
}
/**
 * Повтор — совпадение после нормализации, вхождение по словам (от 20 символов) или пересказ (sameAsk);
 * остаётся более полный пункт на месте первого.
 */
function dedupe(items) {
  const out = [];
  for (const item of items) {
    const n = normItem(item); if (!n) continue;
    const i = out.findIndex((o) => { const [a, b] = [normItem(o), n].sort((x, y) => x.length - y.length); return a === b || (a.length >= 20 && ` ${b} `.includes(` ${a} `)) || sameAsk(a, b); });
    if (i < 0) out.push(item); else if (n.length > normItem(out[i]).length) out[i] = item;
  }
  return out;
}
const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const IDEA_ID = /(?<![\p{L}\p{N}])I\d+(?!\p{N})/gu;
/**
 * «Одобрить X» лишний: X уже в списке одобрений сверху или решён. Пункт без имён открытых изменений («одобрения трёх изменений»)
 * тоже лишний — ждущие одобрения стоят сверху, а когда их нет, строка «Следующий прогон» сама подсказывает одобрить изменение.
 * 0.7.7: пункты списка (I71) в просьбе — по их изменению: сделан, план одобрен или изменение уже в архиве — решён.
 */
export function approvalCovered(item, changes, ideas = []) {
  const lead = /^\s*одобр/i.test(item);
  // 0.7.6: и «Нажать кнопку одобрения X» — просьба об одобрении, если в ней названо изменение («выкатить после одобрения X» — нет);
  // 0.7.7: и «Кнопки одобрения: X, I71» без глагола (так пишет передача смены)
  if (!lead && !/^\s*(наж(ать|мите)\s+)?кнопк[уи]\s+одобрени/i.test(item)) return false;
  const named = changes.filter((c) => new RegExp(`(^|[^\\w-])${escRe(c.name)}($|[^\\w-])`).test(item));
  const ids = [...new Set(item.match(IDEA_ID) || [])];
  // Без имён лишний только пункт про изменения вообще; «одобрить выкат на прод» — настоящая просьба, остаётся.
  if (!named.length && !ids.length) return lead && /изменени/i.test(item);
  // Номер не из списка при названном изменении — его пометка («docs-site-restart (I58)»), решает изменение.
  const ideaSettled = (id) => {
    const x = ideas.find((i) => String(i.id) === id); if (!x) return named.length > 0;
    if (x.status === 'done') return true;
    if (!x.change) return false;
    const c = changes.find((ch) => ch.name === x.change);
    return !c || !!c.mcfly.approval;
  };
  return named.every((c) => c.mcfly.approval) && ids.every(ideaSettled);
}
/**
 * «Решить по I54, I55», «Одобрить или отклонить I53», «Предложения I75, I76» — решение по пунктам списка. С 0.7.8 такой пункт текста
 * не печатается вовсе, если все номера есть в списке: ждущие решения сводка показывает сама строкой «Решить по предложениям» из
 * mcfly/ideas.yaml, решённые не нужны. Номер не из списка — пункт остаётся.
 */
export function ideasCovered(item, ideas) {
  if (!/^\s*(решить|одобрить|отклонить|взять|выбрать|предложени)/i.test(item)) return false;
  const ids = [...new Set(item.match(IDEA_ID) || [])];
  if (!ids.length) return false;
  return ids.every((id) => ideas.some((i) => String(i.id) === id));
}
/** «I75, I76, I77» — не больше max номеров, остальные числом. */
const idList = (ids, max = 8) => (ids.length > max ? `${ids.slice(0, max).join(', ')} и ещё ${ids.length - max}` : ids.join(', '));
/** Название кнопки без значка: «🚀 Выкатить» → «Выкатить». */
const bareTitle = (t) => String(t || '').replace(/^[^\p{L}\p{N}$]+/u, '').trim();
/** «Нажать «🚀 Выкатить»» лишний, когда все названные в пункте кнопки владелец уже нажал после отчёта и они прошли успешно. */
export function actionsCovered(item, acts, records, after) {
  const named = acts.filter((a) => bareTitle(a.title).length >= 4 && item.includes(bareTitle(a.title)));
  return named.length > 0 && named.every((a) => records.some((r) => r.type === 'action' && r.id === a.id && r.status === 'ok' && new Date(r.started_at) > after));
}
/** Конец прогона: ended_at, иначе начало плюс длительность. */
const runEnd = (r) => (r.ended_at ? new Date(r.ended_at) : new Date(new Date(r.started_at).getTime() + Number(r.duration_ms || 0)));
/**
 * Пункты «Нужно от человека» из текста агентов, которые ещё актуальны: без одобрений и решений по списку (их показывает состояние),
 * без кнопок, нажатых после `after`, без повторов. Один отбор для сводки, «Статуса» и «Последнего прогона» (0.7.10: «Статус»
 * просил «🚀 Выкатить» после выката — у него был свой, старый отбор).
 */
export function textNeeds(items, { cfg, records, changes, ideaList, after }) {
  const acts = listActions(cfg);
  return dedupe(items.filter((x) => !isNone(x) && !approvalCovered(x, changes, ideaList) && !ideasCovered(x, ideaList) && !actionsCovered(x, acts, records, after)));
}
/** textNeeds для отчёта rep ({ id, sec, record } из latestReport): кнопки считаются нажатыми, если нажаты после конца его прогона. */
export function reportNeeds(p, cfg, rep) {
  if (!rep) return [];
  const after = rep.record ? runEnd(rep.record) : new Date(fs.statSync(path.join(p.runs, rep.id, 'summary.md')).mtimeMs);
  return textNeeds(humanItems(rep.sec), { cfg, records: readMetrics(p), changes: listChanges(p.openspecChanges), ideaList: loadIdeas(p).ideas, after });
}
/** Разбивает HTML по строкам на куски не длиннее max, не разрывая <blockquote>; кусок длиннее max — простым текстом. */
export function splitHtml(html, max = TG_MAX) {
  const units = []; let cur = []; let depth = 0;
  for (const line of String(html).split('\n')) {
    cur.push(line);
    depth += (line.match(/<blockquote/g) || []).length - (line.match(/<\/blockquote>/g) || []).length;
    if (depth <= 0) { units.push(cur.join('\n')); cur = []; depth = 0; }
  }
  if (cur.length) units.push(cur.join('\n'));
  const parts = []; let part = null;
  for (const unit of units) {
    const pieces = unit.length <= max ? [unit] : chunk(htmlToPlain(unit), Math.floor(max * 0.8)).map(escHtml);
    for (const piece of pieces) {
      if (part !== null && part.length + 1 + piece.length <= max) part += `\n${piece}`;
      else { if (part !== null) parts.push(part); part = piece; }
    }
  }
  if (part !== null) parts.push(part);
  return parts;
}
/** Прогресс изменения «1/2»: по ветке change/<имя>, если она есть, иначе по tasks.md в main. */
export function changeProgress(projectDir, c) {
  const x = branchProgress(projectDir, c.name) || { done: c.tasksDone, open: c.tasksOpen };
  return `${x.done}/${x.done + x.open}`;
}
/** Прогресс словами для владельца (0.9.0): «сделано 1 из 2 шагов». */
export function progressWords(projectDir, c) {
  const [done, total] = changeProgress(projectDir, c).split('/').map(Number);
  const mod10 = total % 10; const mod100 = total % 100;
  return `сделано ${done} из ${total} ${mod10 === 1 && mod100 !== 11 ? 'шага' : 'шагов'}`;
}
/**
 * Название изменения для человека: «I40 «название пункта»», если изменение сделано по пункту списка предложений (0.7.4);
 * short — только номер пункта. Без пункта (0.9.0) — первая фраза его описания (proposal), служебное имя — только если описания нет.
 * esc — экранирование для HTML.
 */
export function changeTitle(p, c, esc = (t) => t, { short = false } = {}) {
  const id = c.mcfly?.idea;
  if (!id) {
    const first = proposalExcerpt(c, 400).split(/(?<=[.!?])\s/)[0].replace(/[.:;]+$/, '').replace(/`/g, '');
    return esc(first ? `«${truncate(first, short ? 50 : 80)}»` : c.name);
  }
  if (short) return esc(id);
  const x = loadIdeas(p).ideas.find((i) => String(i.id) === String(id));
  return x ? `${esc(id)} «${esc(truncate(String(x.title || ''), 80))}»` : esc(id);
}
/**
 * Подписи планов без пункта списка, ждущих одобрения (0.9.0): Map имя → «план» (один) или «план 1», «план 2» (несколько) —
 * одна и та же подпись стоит в тексте и на кнопке, чтобы владелец их сопоставил без служебного имени.
 */
export function planLabels(changes) {
  const plain = pendingApprovals(changes).filter((c) => !c.mcfly.idea);
  return new Map(plain.map((c, i) => [c.name, plain.length > 1 ? `план ${i + 1}` : 'план']));
}
/** Следующая открытая задача изменения (0.7.4): по ветке change/<имя>, иначе по tasks.md в main; null — открытых нет. */
export function nextTask(projectDir, c) {
  const text = branchTasks(projectDir, c.name) ?? readText(path.join(c.dir, 'tasks.md'), '');
  const m = /^\s*[-*+] \[ \]\s*(.+)$/m.exec(text || '');
  if (!m) return null;
  // Только суть задачи: номер как есть, текст — до первой точки с пробелом или открывающей скобки (дальше файлы и ссылки на дизайн)
  const [, num = '', rest] = /^(\d+(?:\.\d+)*\.?\s+)?(.*)$/.exec(m[1].trim());
  return truncate(`${num}${rest.split(/\.\s|\s\(/)[0].replace(/\.$/, '')}`, 90);
}
/** Что будет в следующем прогоне: какие изменения команда продолжит или чего ей не хватает. esc — экранирование имён для HTML; label — подпись изменения. */
export function nextRunText(work, pend, progress, esc = (t) => t, ideas = null, label = (c) => esc(c.name)) {
  // 0.9.0: label даёт название для человека; вызовы передают changeTitle и progressWords
  if (work.length) return `команда продолжит ${work.map((c) => `${label(c)} (${progress(c)})`).join(', ')}`;
  if (ideas?.taken?.length) return `план по ${ideas.taken.map(esc).join(', ')}`;
  if (pend.length) return `работы нет — одобрите ${pend.map((c) => label(c)).join(', ')}`;
  if (ideas?.proposed > 0) return `работы нет — 💡 предложений ${ideas.proposed} (ваших ${ideas.owner}): выберите в «Предложениях»`;
  return 'работы нет — одобрите изменение или напишите команде заметку';
}

export function composeSummary(p, cfg, { now = new Date(), since = null } = {}) {
  const records = readMetrics(p);
  const runs = records.filter((r) => r.type === 'run' && (!since || new Date(r.started_at) > since));
  const changes = listChanges(p.openspecChanges);
  const questions = openQuestions(loadQuestions(p));
  const pend = pendingApprovals(changes);
  const labels = planLabels(changes);
  const numbered = (c) => (!c.mcfly.idea && labels.get(c.name) !== 'план' ? `${labels.get(c.name).replace('план', 'План')}: ` : '');
  const work = approvedWithWork(changes, now);
  const progress = (c) => progressWords(p.projectDir, c);
  const reports = runs.filter((r) => !['missed', 'locked'].includes(r.status))
    .map((r) => ({ r, sec: reportSections(readText(path.join(p.runs, r.id || '', 'summary.md'), '')) })).filter((x) => x.sec)
    .sort((a, b) => new Date(a.r.started_at) - new Date(b.r.started_at));
  const night = latestShift(p, 'night'); const day = latestShift(p, 'day');
  const nightNew = night && (!since || shiftTime(night) > since) ? night : null;
  const cur = currentRun(p);
  // 0.7.6: передача смены устарела, если после её прогонов был отчёт новее — пункты и план дня берём из него.
  // 0.7.8: и после любого прогона, даже без отчёта (остановлен по времени, идёт сейчас): он мог сделать то, что передача предлагает.
  const nightText = nightNew ? readText(nightNew.path, '') : '';
  const laterRuns = [...runs.filter((r) => !['missed', 'locked'].includes(r.status)).map((r) => ({ id: r.id, at: new Date(r.started_at) })), ...(cur?.id ? [{ id: cur.id, at: cur.since }] : [])];
  const nightCurrent = nightNew && !laterRuns.some((r) => r.at > shiftTime(nightNew) && !nightText.includes(String(r.id))) ? nightNew : null;
  const ideaList = loadIdeas(p).ideas;

  // 1. Что нужно от человека — первым и с номерами.
  const need = [];
  for (const q of questions) {
    need.push(autoDefault(cfg, q.category)
      ? `Вопрос <b>${escHtml(q.id)}</b>: ${escHtml(q.text)} — по умолчанию «${escHtml(q.default || '—')}», срок ${fmtShort(new Date(q.deadline_at))}`
      : `Вопрос <b>${escHtml(q.id)}</b>: ${escHtml(q.text)} — без ответа по умолчанию, команда ждёт вас`);
  }
  for (const c of pend) {
    // 0.9.0: без служебного имени; у изменения без пункта списка название и есть начало описания — не повторяем
    need.push(`Одобрить ${c.mcfly.idea ? `<b>${changeTitle(p, c, escHtml)}</b>: ` : `<b>${labels.get(c.name)}</b>: `}${inline(proposalExcerpt(c, EXCERPT))}${isAutoApprovable(c, cfg) ? ` (авто-одобрение ${fmtShort(approvalDeadline(c, cfg))})` : ''}`);
  }
  // 0.7.8: предложения, ждущие решения, — из mcfly/ideas.yaml, а не из текста отчётов (текст устаревает, как только владелец решил)
  const proposedIds = cfg.ideas?.enabled ? ideaList.filter((x) => x.status === 'proposed').map((x) => escHtml(x.id)) : [];
  if (proposedIds.length) need.push(`Решить по предложениям: ${idList(proposedIds)} — кнопка «💡 Предложения»`);
  // Пункты от человека — только из самого свежего отчёта с этим разделом (старые повторяются и устаревают) и из ночной передачи,
  // если прогона новее неё нет. Одобрения и решения по пунктам списка в тексте не печатаются — они выше, из состояния;
  // сделанное после отчёта (кнопка нажата) — тоже. Остальное — снимок на конец прогона, поэтому с подписью источника.
  const latest = [...reports].reverse().find(({ sec }) => sec['Нужно от человека'] || humanItems(sec).length);
  const fromShift = nightCurrent ? shiftSection(nightCurrent.path, 'Нужны решения человека', 20).map((l) => l.replace(/^([-*]|\d+\.)\s+/, '')).filter((l) => !isNone(l)) : [];
  const after = latest ? runEnd(latest.r) : (since || new Date(0));
  const kept = textNeeds([...(latest ? humanItems(latest.sec) : []), ...fromShift], { cfg, records, changes, ideaList, after });
  const fromText = kept.map(inline);
  // Подпись — по тем источникам, чьи пункты остались после отбора и повторов
  const fromReport = latest ? humanItems(latest.sec) : [];
  const srcLatest = kept.some((x) => fromReport.includes(x)) ? `отчёту ${latest.r.slot || hhmm(new Date(latest.r.started_at))}` : '';
  const srcShift = kept.some((x) => fromShift.includes(x)) ? `передаче смены ${hhmm(shiftTime(nightCurrent))}` : '';
  const source = [srcLatest, srcShift].filter(Boolean).join(' и ');
  const L = [`☀️ <b>${escHtml(cfg.project)}</b> · ${pad2(now.getDate())}.${pad2(now.getMonth() + 1)}`, ''];
  const needCount = need.length + fromText.length;
  if (needCount) {
    L.push(`<b>🙋 Нужно от вас (${needCount})</b>`, ...need.map((x, i) => `${i + 1}. ${x}`));
    if (fromText.length) L.push(`<i>По ${escHtml(source)}:</i>`, ...fromText.map((x, i) => `${need.length + i + 1}. ${x}`));
    if (questions.length || pend.length) L.push('<i>Кнопки — под сообщением; свой ответ: «Q1: текст»</i>');
  } else L.push('<b>🙋 От вас ничего не нужно</b>');

  // 1а. Простыми словами — пересказ отчётов для человека, не читающего код: до трёх последних прогонов, целиком (0.9.0).
  const plainRuns = reports.map(({ r, sec }) => ({ r, text: plainWords(sec) })).filter((x) => x.text).slice(-3);
  for (const { r, text } of plainRuns) L.push('', `<b>🗣 Прогон ${escHtml(r.slot || hhmm(new Date(r.started_at)))} простыми словами</b>`, plainHtml(text));

  // 2. Прогоны — строка со значком; пропущенные слоты по расписанию.
  L.push('', '<b>🌙 Прогоны</b>');
  const covered = new Set(runs.filter((r) => r.slot).map((r) => slotKey(new Date(r.started_at), r.slot)));
  const expected = since ? expectedSlots(since, now, cfg.schedule.slots).filter((e) => !covered.has(e.key)) : [];
  // 0.7.7: запись прогона появляется в конце — идущий прогон показываем по mcfly/.lock, иначе сводка во время него о нём молчит
  const live = cur?.id && !runs.some((r) => r.id === cur.id) && (!since || cur.since > since)
    ? [{ at: cur.since, line: `▶️ ${hhmm(cur.since)} — идёт сейчас, ${fmtDuration(Math.max(0, now - cur.since))}` }] : [];
  const lines = [...runs.map((r) => ({ at: new Date(r.started_at), line: runLine(r) })), ...live, ...expected.map((e) => ({ at: e.at || now, line: runLine({ status: 'missed', slot: e.slot, started_at: (e.at || now).toISOString() }) }))]
    .sort((a, b) => a.at - b.at).map((x) => x.line);
  L.push(...(lines.length ? lines : ['прогонов не было']));

  // 3. Изменения и следующий прогон.
  L.push('', '<b>📦 Изменения</b>');
  const period = aggregate(records, { since });
  const ch = [...work.map((c) => `🔧 ${changeTitle(p, c, escHtml)} — ${progress(c)}`), ...pend.map((c) => `⏳ ${numbered(c)}${changeTitle(p, c, escHtml)} — ждёт одобрения`),
    ...pausedChanges(changes, now).map((c) => `⏸ ${changeTitle(p, c, escHtml)} — отложено до ${fmtDay(pausedUntil(c))}`)];
  const done = [period.events.changes_archived ? `изменений ${period.events.changes_archived}` : '', period.events.tasks_done ? `задач ${period.events.tasks_done}` : ''].filter(Boolean);
  if (done.length) ch.push(`🏁 За период завершено: ${done.join(', ')}`);
  L.push(...(ch.length ? ch : ['Открытых изменений нет']));
  if (cfg.ideas?.enabled && since) {
    // 0.7.6: поимённо только то, что ещё ждёт решения или работы; решённое — числом
    const fresh = ideaList.filter((x) => new Date(x.created_at) > since);
    const ids = (st) => fresh.filter((x) => x.status === st).map((x) => escHtml(x.id)).join(', ');
    const parts = [ids('proposed') && `ждут решения: ${ids('proposed')}`, ids('taken') && `взяты, команда спланирует: ${ids('taken')}`].filter(Boolean);
    if (fresh.length) L.push(`💡 Новых предложений: ${fresh.length}${parts.length ? ` — ${parts.join('; ')}` : ''}`);
  }
  L.push('', `<b>🗓 Следующий прогон:</b> ${nextRunText(work, pend, progress, escHtml, ideasBrief(p, cfg), (c) => changeTitle(p, c, escHtml, { short: true }))}`);
  if (nightCurrent) {
    const lines = shiftSection(nightCurrent.path, 'Предложение на день');
    if (lines.length) L.push('', '<b>🌅 Предложение на день</b>', ...lines.map(inline));
  }
  if (day && (!since || shiftTime(day) > since) && /\(источник: авто\)/.test(readText(day.path, '').split('\n')[0])) L.push('⚠️ смену не сдали — ночь шла по авто-передаче');

  // 0.9.0: отчёты «Сделано» и метрики в Telegram не идут — они в techTail (терминал) и в файлах проекта.
  return L.join('\n');
}

/**
 * Технический хвост сводки простым текстом — только для терминала (`mcfly summary` без --send): прогоны со стоимостью, ходами
 * и субагентами, метрики за период и всего, разделы «Сделано» и «В работе» отчётов. В Telegram не отправляется (0.9.0).
 */
export function techTail(p, cfg, { since = null } = {}) {
  const records = readMetrics(p);
  const runs = records.filter((r) => r.type === 'run' && (!since || new Date(r.started_at) > since));
  const L = ['— Технические подробности (только в терминале) —'];
  for (const r of runs) {
    const note = r.status === 'error' ? `: ${truncate(String(r.note || r.error || '').split('; ')[0], 120)}` : '';
    L.push(`${r.id || r.slot || hhmm(new Date(r.started_at))}: ${r.status}${note}${runStats(r)}${r.duration_ms ? `, ${fmtDuration(r.duration_ms)}` : ''}${r.attempts > 1 ? `, попыток ${r.attempts}` : ''}`);
  }
  const ideaList = loadIdeas(p).ideas;
  const period = aggregate(records, { since }); const total = aggregate(records);
  // 0.7.8: число предложений — по списку (mcfly/ideas.yaml), а не по событиям ideas_added, которые агенты записывают сами и забывают
  if (cfg.ideas?.enabled) {
    const added = (from) => ideaList.filter((x) => !from || new Date(x.created_at) > from).length;
    for (const [agg, from] of [[period, since], [total, null]]) { if (added(from)) agg.events.ideas_added = added(from); else delete agg.events.ideas_added; }
  }
  const agents = (a) => (a.subagents ? `, субагентов ${a.subagents}` : '');
  L.push(`За период: ${formatEvents(period.events)}; ${runsByStatus(period)}${agents(period)}, ~$${period.cost_usd}`);
  L.push(`Всего: ${formatEvents(total.events)}; ${runsByStatus(total)}${agents(total)}, ~$${total.cost_usd}`);
  for (const r of runs.filter((x) => !['missed', 'locked'].includes(x.status))) {
    const sec = reportSections(readText(path.join(p.runs, r.id || '', 'summary.md'), '')); if (!sec) continue;
    const wip = (sec['В работе'] || []).filter((l) => !isNone(l));
    const body = [...(sec['Сделано'] || []).map((l) => `  • ${l}`), ...(wip.length ? ['  В работе:', ...wip.map((l) => `  • ${l}`)] : [])];
    if (body.length) L.push(`Отчёт ${r.slot || hhmm(new Date(r.started_at))} (mcfly/runs/${r.id}/summary.md):`, ...body);
  }
  return L.join('\n');
}

/** Кнопки под сводкой и «статусом»: ответ по умолчанию на вопрос и одобрение/отклонение изменения. */
export function summaryKeyboard(p, cfg) {
  const fitsData = (d) => Buffer.byteLength(d) <= 64; // предел callback_data в Telegram
  const rows = [];
  for (const q of openQuestions(loadQuestions(p))) {
    if (autoDefault(cfg, q.category) && q.default && fitsData(`qd:${q.id}`)) rows.push([{ text: `✅ ${q.id}: по умолчанию`, callback_data: `qd:${q.id}` }]);
  }
  const changes = listChanges(p.openspecChanges); const pend = pendingApprovals(changes); const labels = planLabels(changes);
  for (const c of pend) {
    // План по пункту списка (0.7.0): «отклонить» значит «не сейчас» — пункт уходит на обсуждение в сессии
    if (fitsData(`ap:${c.name}`)) rows.push([{ text: `✅ Одобрить ${c.mcfly.idea || labels.get(c.name)}`, callback_data: `ap:${c.name}` }, { text: c.mcfly.idea ? '⏸ Не сейчас' : '❌ Отклонить', callback_data: `rj:${c.name}` }]);
  }
  if (!pend.length && !approvedWithWork(changes).length && ideasBrief(p, cfg)?.proposed > 0) rows.push([{ text: '💡 Предложения', callback_data: 'il:1' }]);
  return rows;
}

export async function sendSummary(p, cfg, { now = new Date(), telegram = null, log = console.log } = {}) {
  const state = loadState(p);
  const since = state.last_summary_at ? new Date(state.last_summary_at) : new Date(now.getTime() - 24 * 3600_000);
  const html = composeSummary(p, cfg, { now, since });
  const token = process.env[cfg.telegram.token_env];
  if (!token || !cfg.telegram.chat_id) { log(htmlToPlain(html)); log('\n(Telegram не настроен: сводка выведена в консоль)'); return { sent: false, text: html }; }
  const tg = telegram || createTelegram({ token });
  // Не влезла в одно сообщение — несколько по границам строк; кнопки под первым.
  const parts = splitHtml(html, TG_MAX); const keyboard = summaryKeyboard(p, cfg);
  try {
    for (const [i, part] of parts.entries()) await tg.sendMessage(cfg.telegram.chat_id, part, { html: true, keyboard: i === 0 ? keyboard : null });
  } catch (e) {
    // Короткая тревога простым текстом; last_summary_at не двигается — следующая сводка охватит и этот период. Ошибка — дальше, launchd увидит код 1.
    const alarm = `⚠️ mcfly ${cfg.project}: сводка не отправлена (${truncate(String(e?.message || e), 300)}), смотрите \`mcfly summary\``;
    try { await tg.sendMessage(cfg.telegram.chat_id, alarm); } catch (e2) { log(`Тревога тоже не отправлена: ${e2?.message || e2}; поставлена в очередь.`); enqueueNotice(p, { text: alarm }, now); }
    throw e;
  }
  state.last_summary_at = now.toISOString(); saveState(p, state);
  log(`Сводка отправлена (${html.length} символов${parts.length > 1 ? `, сообщений ${parts.length}` : ''}).`);
  return { sent: true, text: html };
}
