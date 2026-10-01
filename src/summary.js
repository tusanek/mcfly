import path from 'node:path';
import { readText, fmtShort, fmtDuration, truncate, pad2 } from './util.js';
import { readMetrics, aggregate, formatEvents, runStats } from './metrics.js';
import { loadQuestions, openQuestions } from './questions.js';
import { listChanges, pendingApprovals, approvedWithWork, proposalExcerpt, approvalDeadline, isAutoApprovable } from './approvals.js';
import { expectedSlots, slotKey } from './window.js';
import { loadState, saveState } from './state.js';
import { createTelegram } from './telegram.js';
import { branchProgress } from './git.js';
import { autoDefault } from './config.js';

export const STATUS_RU = { ok: 'ок', missed: 'пропущен', error: 'ошибка', timeout: 'остановлен по времени', quota: 'остановлен: лимит квоты', network: 'не выполнен: нет доступа к API (VPN?)', locked: 'не запущен (шёл другой прогон)' };

const STATUS_COUNT_RU = { ok: 'ок', quota: 'квота', network: 'нет сети', timeout: 'по времени', error: 'ошибок', missed: 'пропущено', locked: 'занято' };
/** «прогонов 3 (квота 2, ок 1)» — частые статусы первыми. */
function runsByStatus(agg) {
  const parts = Object.keys(STATUS_COUNT_RU).filter((s) => agg[s]).sort((a, b) => agg[b] - agg[a]).map((s) => `${STATUS_COUNT_RU[s]} ${agg[s]}`);
  return `прогонов ${agg.runs}${parts.length ? ` (${parts.join(', ')})` : ''}`;
}

const RUN_ICON = { ok: '✅', quota: '⏸', timeout: '⏱', network: '❌', error: '❌', missed: '💤', locked: '🔒' };
const LIMIT = 3900; // сообщение Telegram — до 4096 символов; HTML сводки укладываем в одно сообщение с запасом
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
/** Пункты «от человека»: раздел «Нужно от человека», у старых отчётов — строки «От вас: …». */
function humanItems(sec) {
  const items = sec['Нужно от человека'] || Object.values(sec).flat().filter((l) => /^от вас(?=[\s:—-])/i.test(l)).map((l) => l.replace(/^от вас\s*[:—-]?\s*/i, ''));
  return items.filter((l) => l && !/^(нет|ничего)\.?$/i.test(l));
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
    .map((r) => ({ r, sec: reportSections(readText(path.join(p.runs, r.id || '', 'summary.md'), '')) })).filter((x) => x.sec);

  // 1. Что нужно от человека — первым и с номерами.
  const need = [];
  for (const q of questions) {
    need.push(autoDefault(cfg, q.category)
      ? `Вопрос <b>${escHtml(q.id)}</b>: ${escHtml(q.text)} — по умолчанию «${escHtml(q.default || '—')}», срок ${fmtShort(new Date(q.deadline_at))}`
      : `Вопрос <b>${escHtml(q.id)}</b>: ${escHtml(q.text)} — без ответа по умолчанию, команда ждёт вас`);
  }
  for (const c of pend) {
    need.push(`Одобрить <b>${escHtml(c.name)}</b>: ${escHtml(proposalExcerpt(c, 200))}${isAutoApprovable(c, cfg) ? ` (авто-одобрение ${fmtShort(approvalDeadline(c, cfg))})` : ''}`);
  }
  for (const { sec } of reports) for (const item of humanItems(sec)) need.push(inline(item));
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

  // 4. Подробности свёрнуты: отчёты команды и метрики.
  const total = aggregate(records);
  const metrics = `<blockquote expandable>📊 За период: ${escHtml(formatEvents(period.events))}; ${escHtml(runsByStatus(period))}, ~$${period.cost_usd}\nВсего: ${escHtml(formatEvents(total.events))}; ${escHtml(runsByStatus(total))}, ~$${total.cost_usd}</blockquote>`;
  const head = L.join('\n');
  const budget = Math.max(0, LIMIT - head.length - metrics.length - 60 * (reports.length + 1));
  const blocks = reports.map(({ r, sec }) => {
    const body = [];
    const doneLines = sec['Сделано'] || Object.values(sec).flat();
    if (doneLines.length) body.push('Сделано:', ...doneLines.map((l) => `• ${inline(l)}`));
    const wip = (sec['В работе'] || []).filter((l) => !/^(нет|одобренных изменений с открытыми задачами нет)\.?$/i.test(l));
    if (wip.length) body.push('В работе:', ...wip.map((l) => `• ${inline(l)}`));
    const start = new Date(r.started_at);
    return `<blockquote expandable><b>Отчёт ${escHtml(r.slot || hhmm(start))}</b>\n${fit(body, Math.floor(budget / Math.max(1, reports.length))).join('\n')}</blockquote>`;
  });
  return [head, ...(blocks.length ? ['', ...blocks] : []), '', metrics].join('\n');
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
  await tg.sendMessage(cfg.telegram.chat_id, html, { html: true, keyboard: summaryKeyboard(p, cfg) });
  state.last_summary_at = now.toISOString(); saveState(p, state);
  log(`Сводка отправлена (${html.length} символов).`);
  return { sent: true, text: html };
}
