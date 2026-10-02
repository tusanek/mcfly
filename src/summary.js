import path from 'node:path';
import { readText, fmtShort, fmtDuration, truncate, pad2 } from './util.js';
import { readMetrics, aggregate, formatEvents, runStats } from './metrics.js';
import { loadQuestions, openQuestions } from './questions.js';
import { listChanges, pendingApprovals, approvedWithWork, proposalExcerpt, approvalDeadline, isAutoApprovable } from './approvals.js';
import { expectedSlots, slotKey } from './window.js';
import { loadState, saveState } from './state.js';
import { createTelegram, chunk } from './telegram.js';
import { branchProgress } from './git.js';
import { autoDefault } from './config.js';
import { latestShift } from './shift-files.js';

export const STATUS_RU = { ok: 'ок', missed: 'пропущен', error: 'ошибка', timeout: 'остановлен по времени', quota: 'остановлен: лимит квоты', network: 'не выполнен: нет доступа к API (VPN?)', locked: 'не запущен (шёл другой прогон)' };

const STATUS_COUNT_RU = { ok: 'ок', quota: 'квота', network: 'нет сети', timeout: 'по времени', error: 'ошибок', missed: 'пропущено', locked: 'занято' };
/** «прогонов 3 (квота 2, ок 1)» — частые статусы первыми. */
function runsByStatus(agg) {
  const parts = Object.keys(STATUS_COUNT_RU).filter((s) => agg[s]).sort((a, b) => agg[b] - agg[a]).map((s) => `${STATUS_COUNT_RU[s]} ${agg[s]}`);
  return `прогонов ${agg.runs}${parts.length ? ` (${parts.join(', ')})` : ''}`;
}

const RUN_ICON = { ok: '✅', quota: '⏸', timeout: '⏱', network: '❌', error: '❌', missed: '💤', locked: '🔒' };
const LIMIT = 3900; // сообщение Telegram — до 4096 символов; HTML сводки укладываем в одно сообщение с запасом
const TG_MAX = 4000; // предел куска при отправке: длина HTML не меньше текста, который считает Telegram
const MIN_BLOCK = 200; // меньше — блок «Отчёт» бесполезен, лучше не показывать
const EXCERPT = 160; // выдержка proposal в пункте одобрения
export const escHtml = (t) => String(t ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
/** Текст для консоли: без тегов и HTML-сущностей. */
export const htmlToPlain = (html) => String(html).replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
const hhmm = (d) => `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
/** `код` из markdown отчёта — моноширинным, остальное экранировано. */
const inline = (t) => escHtml(t).replace(/`([^`]+)`/g, '<code>$1</code>');

function runLine(r) {
  const start = new Date(r.started_at);
  const when = r.slot || (r.mode === 'day' ? `${hhmm(start)} (днём)` : hhmm(start));
  let detail;
  if (r.status === 'ok') detail = [r.duration_ms ? fmtDuration(r.duration_ms) : '', r.cost_usd != null ? `~$${Number(r.cost_usd).toFixed(2)}` : ''].filter(Boolean).join(' · ') || 'ок';
  else if (r.status === 'error') detail = `ошибка: ${truncate(String(r.note || r.error || '').split('; ')[0], 120)}`;
  else detail = { quota: 'остановлен: лимит квоты', timeout: 'остановлен по времени', network: 'нет доступа к API (VPN?)', locked: 'не запущен: шёл другой прогон', missed: 'пропущен: Mac спал или был выключен' }[r.status] || r.status;
  const tries = r.attempts > 1 ? ` · попыток ${r.attempts}` : '';
  return `${RUN_ICON[r.status] || '•'} ${escHtml(when)} — ${escHtml(detail)}${tries}`;
}

/** Разделы markdown-отчёта: { 'Сделано': [строки], … }; авто-сводки runner'а — null. */
function reportSections(text) {
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
const isNone = (l) => !l || /^(нет|ничего)\.?$/i.test(l);
/** Пункты «от человека»: раздел «Нужно от человека», у старых отчётов — строки «От вас: …». */
function humanItems(sec) {
  const items = sec['Нужно от человека'] || Object.values(sec).flat().filter((l) => /^от вас(?=[\s:—-])/i.test(l)).map((l) => l.replace(/^от вас\s*[:—-]?\s*/i, ''));
  return items.filter((l) => !isNone(l));
}
/** Пункт для сравнения: регистр, «ё», `код`, <code>, пунктуация и пробелы не важны. */
const normItem = (t) => String(t).toLowerCase().replace(/ё/g, 'е').replace(/<\/?code>|`/g, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
/** Повтор — совпадение после нормализации или вхождение по словам (от 20 символов); остаётся более полный пункт на месте первого. */
function dedupe(items) {
  const out = [];
  for (const item of items) {
    const n = normItem(item); if (!n) continue;
    const i = out.findIndex((o) => { const [a, b] = [normItem(o), n].sort((x, y) => x.length - y.length); return a === b || (a.length >= 20 && ` ${b} `.includes(` ${a} `)); });
    if (i < 0) out.push(item); else if (n.length > normItem(out[i]).length) out[i] = item;
  }
  return out;
}
const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/**
 * «Одобрить X» лишний: X уже в списке одобрений сверху или решён. Пункт без имён открытых изменений («одобрения трёх изменений»)
 * тоже лишний — ждущие одобрения стоят сверху, а когда их нет, строка «Следующий прогон» сама подсказывает одобрить изменение.
 */
function approvalCovered(item, changes) {
  if (!/^\s*одобр/i.test(item)) return false;
  return changes.filter((c) => new RegExp(`(^|[^\\w-])${escRe(c.name)}($|[^\\w-])`).test(item)).every((c) => c.mcfly.approval);
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
/** Строки в пределах бюджета символов; не влезло — «…». */
function fit(lines, budget) {
  const out = []; let used = 0;
  for (const l of lines) { if (used + l.length + 1 > budget) { out.push('…'); break; } out.push(l); used += l.length + 1; }
  return out;
}

export function composeSummary(p, cfg, { now = new Date(), since = null } = {}) {
  const records = readMetrics(p);
  const runs = records.filter((r) => r.type === 'run' && (!since || new Date(r.started_at) > since));
  const changes = listChanges(p.openspecChanges);
  const questions = openQuestions(loadQuestions(p));
  const pend = pendingApprovals(changes);
  const work = approvedWithWork(changes);
  const progress = (c) => { const b = branchProgress(p.projectDir, c.name); const x = b || { done: c.tasksDone, open: c.tasksOpen }; return `${x.done}/${x.done + x.open}`; };
  const reports = runs.filter((r) => !['missed', 'locked'].includes(r.status))
    .map((r) => ({ r, sec: reportSections(readText(path.join(p.runs, r.id || '', 'summary.md'), '')) })).filter((x) => x.sec)
    .sort((a, b) => new Date(a.r.started_at) - new Date(b.r.started_at));
  const night = latestShift(p, 'night'); const day = latestShift(p, 'day');
  const nightNew = night && (!since || shiftTime(night) > since) ? night : null;

  // 1. Что нужно от человека — первым и с номерами.
  const need = [];
  for (const q of questions) {
    need.push(autoDefault(cfg, q.category)
      ? `Вопрос <b>${escHtml(q.id)}</b>: ${escHtml(q.text)} — по умолчанию «${escHtml(q.default || '—')}», срок ${fmtShort(new Date(q.deadline_at))}`
      : `Вопрос <b>${escHtml(q.id)}</b>: ${escHtml(q.text)} — без ответа по умолчанию, команда ждёт вас`);
  }
  for (const c of pend) {
    need.push(`Одобрить <b>${escHtml(c.name)}</b>: ${inline(proposalExcerpt(c, EXCERPT))}${isAutoApprovable(c, cfg) ? ` (авто-одобрение ${fmtShort(approvalDeadline(c, cfg))})` : ''}`);
  }
  // Пункты от человека — только из самого свежего отчёта с этим разделом (старые повторяются и устаревают) и из ночной передачи.
  const latest = [...reports].reverse().find(({ sec }) => sec['Нужно от человека'] || humanItems(sec).length);
  const fromShift = nightNew ? shiftSection(nightNew.path, 'Нужны решения человека', 20).map((l) => l.replace(/^([-*]|\d+\.)\s+/, '')).filter((l) => !isNone(l)) : [];
  const items = [...(latest ? humanItems(latest.sec) : []), ...fromShift].filter((x) => !approvalCovered(x, changes));
  for (const item of dedupe(items)) need.push(inline(item));
  const L = [`☀️ <b>${escHtml(cfg.project)}</b> · ${pad2(now.getDate())}.${pad2(now.getMonth() + 1)}`, ''];
  if (need.length) {
    L.push(`<b>🙋 Нужно от вас (${need.length})</b>`, ...need.map((x, i) => `${i + 1}. ${x}`));
    if (questions.length || pend.length) L.push('<i>Кнопки — под сообщением; свой ответ: «Q1: текст»</i>');
  } else L.push('<b>🙋 От вас ничего не нужно</b>');

  // 2. Прогоны — строка со значком; пропущенные слоты по расписанию.
  L.push('', '<b>🌙 Прогоны</b>');
  const covered = new Set(runs.filter((r) => r.slot).map((r) => slotKey(new Date(r.started_at), r.slot)));
  const expected = since ? expectedSlots(since, now, cfg.schedule.slots).filter((e) => !covered.has(e.key)) : [];
  const lines = [...runs.map((r) => ({ at: new Date(r.started_at), line: runLine(r) })), ...expected.map((e) => ({ at: e.at || now, line: runLine({ status: 'missed', slot: e.slot, started_at: (e.at || now).toISOString() }) }))]
    .sort((a, b) => a.at - b.at).map((x) => x.line);
  L.push(...(lines.length ? lines : ['прогонов не было']));

  // 3. Изменения и следующий прогон.
  L.push('', '<b>📦 Изменения</b>');
  const period = aggregate(records, { since });
  const ch = [...work.map((c) => `🔧 ${escHtml(c.name)} — ${progress(c)}`), ...pend.map((c) => `⏳ ${escHtml(c.name)} — ждёт одобрения`)];
  const done = [period.events.changes_archived ? `изменений ${period.events.changes_archived}` : '', period.events.tasks_done ? `задач ${period.events.tasks_done}` : ''].filter(Boolean);
  if (done.length) ch.push(`🏁 За период завершено: ${done.join(', ')}`);
  L.push(...(ch.length ? ch : ['Открытых изменений нет']));
  const next = work.length ? `команда продолжит ${work.map((c) => `${escHtml(c.name)} (${progress(c)})`).join(', ')}`
    : pend.length ? `работы нет — одобрите ${pend.map((c) => escHtml(c.name)).join(', ')}`
    : 'работы нет — одобрите изменение или напишите команде заметку';
  L.push('', `<b>🗓 Следующий прогон:</b> ${next}`);
  if (nightNew) {
    const lines = shiftSection(nightNew.path, 'Предложение на день');
    if (lines.length) L.push('', '<b>🌅 Предложение на день</b>', ...lines.map(inline));
  }
  if (day && (!since || shiftTime(day) > since) && /\(источник: авто\)/.test(readText(day.path, '').split('\n')[0])) L.push('⚠️ смену не сдали — ночь шла по авто-передаче');

  // 4. Подробности свёрнуты: отчёты команды и метрики.
  const total = aggregate(records);
  const metrics = `<blockquote expandable>📊 За период: ${escHtml(formatEvents(period.events))}; ${escHtml(runsByStatus(period))}, ~$${period.cost_usd}\nВсего: ${escHtml(formatEvents(total.events))}; ${escHtml(runsByStatus(total))}, ~$${total.cost_usd}</blockquote>`;
  const head = L.join('\n');
  // Блоки «Отчёт» делят остаток лимита поровну. Если на блок меньше MIN_BLOCK или в какой-то блок не влез ни один пункт,
  // старые отчёты не показываются (остаётся строка «Ещё отчётов»): лучше два полезных блока, чем шесть «…».
  const avail = LIMIT - head.length - metrics.length;
  const perBlock = (k) => Math.floor((avail - 60 * (k + 1)) / Math.max(1, k));
  const reportBody = ({ sec }) => {
    const body = [];
    const doneLines = sec['Сделано'] || Object.values(sec).flat();
    if (doneLines.length) body.push('Сделано:', ...doneLines.map((l) => `• ${inline(l)}`));
    const wip = (sec['В работе'] || []).filter((l) => !/^(нет|одобренных изменений с открытыми задачами нет)\.?$/i.test(l));
    if (wip.length) body.push('В работе:', ...wip.map((l) => `• ${inline(l)}`));
    return body;
  };
  const withBody = reports.filter((x) => reportBody(x).length);
  let blocks = [];
  for (let k = withBody.length; k > 0; k--) {
    if (perBlock(k) < MIN_BLOCK) continue;
    const fitted = withBody.slice(-k).map((x) => ({ r: x.r, lines: fit(reportBody(x), perBlock(k)) }));
    if (!fitted.every(({ lines }) => lines.some((l) => l.startsWith('• ')))) continue;
    blocks = fitted.map(({ r, lines }) => `<blockquote expandable><b>Отчёт ${escHtml(r.slot || hhmm(new Date(r.started_at)))}</b>\n${lines.join('\n')}</blockquote>`);
    break;
  }
  const assemble = () => {
    const hidden = withBody.length - blocks.length;
    const tail = [...blocks, ...(hidden ? [`<i>Ещё отчётов: ${hidden} — mcfly/runs</i>`] : [])];
    return [head, ...(tail.length ? ['', ...tail] : []), '', metrics].join('\n');
  };
  let html = assemble();
  while (html.length > LIMIT && blocks.length) { blocks.shift(); html = assemble(); }
  return html;
}

/** Кнопки под сводкой: ответ по умолчанию на вопрос и одобрение/отклонение изменения. */
export function summaryKeyboard(p, cfg) {
  const fitsData = (d) => Buffer.byteLength(d) <= 64; // предел callback_data в Telegram
  const rows = [];
  for (const q of openQuestions(loadQuestions(p))) {
    if (autoDefault(cfg, q.category) && q.default && fitsData(`qd:${q.id}`)) rows.push([{ text: `✅ ${q.id}: по умолчанию`, callback_data: `qd:${q.id}` }]);
  }
  for (const c of pendingApprovals(listChanges(p.openspecChanges))) {
    if (fitsData(`ap:${c.name}`)) rows.push([{ text: `✅ Одобрить ${c.name}`, callback_data: `ap:${c.name}` }, { text: '❌ Отклонить', callback_data: `rj:${c.name}` }]);
  }
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
    try { await tg.sendMessage(cfg.telegram.chat_id, alarm); } catch (e2) { log(`Тревога тоже не отправлена: ${e2?.message || e2}`); }
    throw e;
  }
  state.last_summary_at = now.toISOString(); saveState(p, state);
  log(`Сводка отправлена (${html.length} символов${parts.length > 1 ? `, сообщений ${parts.length}` : ''}).`);
  return { sent: true, text: html };
}
