import path from 'node:path';
import { readText, pad2, truncate, fmtDuration, fmtShort } from './util.js';
import { readMetrics, aggregate } from './metrics.js';
import { loadQuestions, openQuestions } from './questions.js';
import { listChanges, pendingApprovals, approvedWithWork, archivedSince, proposalSamples } from './approvals.js';
import { loadIdeas } from './ideas.js';
import { expectedSlots, slotKey } from './window.js';
import { loadState, saveState } from './state.js';
import { createTelegram } from './telegram.js';
import { enqueueNotice } from './notices.js';
import { parseGoals } from './overview.js';
import { escHtml, inline, htmlToPlain, splitHtml, changeTitle, progressWords, STATUS_COUNT_RU } from './summary.js';
import { sendSummaryVideo } from './video.js';

// 0.13.0: недельная сводка — раз в неделю (schedule.weekly_day, schedule.weekly_at), итог за семь дней: что завершено, что в работе,
// продвижение по целям, прогоны и их исход, что ждёт владельца, расход лимита подписки. При video.enabled — ещё и роликом.

const WEEK_MS = 7 * 24 * 3600_000;
const SHOW_CLOSED = 10; // завершённых изменений поимённо — последние; остальные числом
const dm = (d) => `${pad2(d.getDate())}.${pad2(d.getMonth() + 1)}`;
const pct = (x) => Math.round(Number(x) * 100);

/**
 * Данные недельной сводки и её текст (html). since — начало периода, по умолчанию неделя назад.
 * closed — названия завершённых изменений; goals — { done, total, delta, milestone } или null (delta — прирост с прошлой недельной
 * сводки, null — сравнить не с чем); runs — { total, stats: { статус: сколько }, workMs }; waiting — { questions, pending, proposed };
 * usage — { now, at, peak, quotaStops } или null; demos — образцы «как это выглядит» завершённых изменений (для ролика).
 */
export function weeklyData(p, cfg, { now = new Date(), since = new Date(now.getTime() - WEEK_MS) } = {}) {
  const records = readMetrics(p);
  const runs = records.filter((r) => r.type === 'run' && new Date(r.started_at) > since && new Date(r.started_at) <= now);
  const covered = new Set(runs.filter((r) => r.slot).map((r) => slotKey(new Date(r.started_at), r.slot)));
  // Пропуски считаем с первой записи проекта: до неё mcfly здесь ещё не работал, и слоты тех дней — не пропущенные
  const first = records.map((r) => new Date(r.started_at || r.at || NaN)).find((d) => !Number.isNaN(d.getTime()));
  const missed = !first ? 0 : expectedSlots(first > since ? first : since, now, cfg.schedule.slots).filter((e) => !covered.has(e.key)).length;
  const stats = {};
  for (const st of runs.map((r) => r.status)) stats[st] = (stats[st] || 0) + 1;
  if (missed) stats.missed = (stats.missed || 0) + missed;
  const total = Object.values(stats).reduce((n, c) => n + c, 0);
  const workMs = runs.reduce((n, r) => n + Number(r.duration_ms || 0), 0);

  const archived = archivedSince(p.openspecChanges, since);
  const closed = archived.map((c) => changeTitle(p, c));
  const tasksDone = aggregate(records, { since }).events.tasks_done || 0;
  const changes = listChanges(p.openspecChanges);
  const work = approvedWithWork(changes, now).map((c) => ({ title: changeTitle(p, c), progress: progressWords(p.projectDir, c) }));

  const g = parseGoals(readText(path.join(p.root, 'goals.md'), ''));
  const prev = loadState(p).weekly_goals_done;
  const goalsDone = g ? g.items.filter((x) => x.done).length : 0;
  const goals = g?.items.length ? { done: goalsDone, total: g.items.length, delta: Number.isInteger(prev) ? goalsDone - prev : null, milestone: g.milestone.join(' ') } : null;

  const questions = openQuestions(loadQuestions(p)).map((q) => ({ id: String(q.id), text: String(q.text || '') }));
  const pending = pendingApprovals(changes).length;
  const proposed = cfg.ideas?.enabled ? loadIdeas(p).ideas.filter((x) => x.status === 'proposed').length : 0;

  const measured = records.filter((r) => r.type === 'run' && r.usage && r.usage.seven_day != null);
  const last = measured.at(-1);
  const week = measured.filter((r) => new Date(r.started_at) > since).map((r) => Number(r.usage.seven_day));
  const usage = last ? { now: Number(last.usage.seven_day), at: new Date(last.ended_at || last.started_at), peak: week.length ? Math.max(...week) : null, quotaStops: stats.quota || 0 } : null;

  const demos = archived.flatMap((c) => proposalSamples(c).filter((x) => x.text || x.buttons.length).map((x) => ({ change: changeTitle(p, c), ...x })));

  const L = [`📅 <b>${escHtml(cfg.project)}</b> · итоги недели ${dm(since)}–${dm(now)}`, ''];
  L.push(`<b>🏁 Завершено за неделю${closed.length ? ` (${closed.length})` : ''}</b>`);
  L.push(...(closed.length ? closed.slice(-SHOW_CLOSED).map((t) => `• ${escHtml(t)}`) : ['Завершённых изменений нет']));
  if (closed.length > SHOW_CLOSED) L.push(`…и ещё ${closed.length - SHOW_CLOSED} — раньше на неделе`);
  if (tasksDone) L.push(`Закрыто задач: ${tasksDone}`);
  if (work.length) L.push('', '<b>🔧 В работе</b>', ...work.map((w) => `• ${escHtml(w.title)} — ${escHtml(w.progress)}`));
  if (goals) {
    const delta = goals.delta > 0 ? ` (+${goals.delta} за неделю)` : goals.delta === 0 ? ' (за неделю без изменений)' : '';
    L.push('', '<b>🎯 Цели</b>', `Сделано ${goals.done} из ${goals.total}${delta}`);
    if (goals.milestone) L.push(`Ближайшая веха: ${inline(truncate(goals.milestone, 200))}`);
  }
  L.push('', '<b>🌙 Прогоны</b>');
  if (!total) L.push('Прогонов не было');
  else {
    const parts = Object.keys(STATUS_COUNT_RU).filter((s) => stats[s]).sort((a, b) => stats[b] - stats[a]).map((s) => `${STATUS_COUNT_RU[s]} ${stats[s]}`);
    L.push(`Всего ${total}: ${parts.join(', ')}`);
    if (workMs >= 60_000) L.push(`Команда работала ${fmtDuration(workMs)}`);
  }
  L.push('', '<b>🙋 Ждёт вас</b>');
  const wait = [...questions.map((q) => `• Вопрос <b>${escHtml(q.id)}</b>: ${escHtml(truncate(q.text, 200))}`),
    pending ? `• Планов на одобрении: ${pending}` : '', proposed ? `• Предложений без решения: ${proposed}` : ''].filter(Boolean);
  L.push(...(wait.length ? wait : ['Ничего: открытых вопросов и планов на одобрении нет']));
  L.push('', '<b>⚡ Лимит подписки</b>');
  if (!usage) L.push('Данных о лимите нет');
  else {
    L.push(`Недельный лимит занят на ${pct(usage.now)} % <i>(замер ${fmtShort(usage.at)})</i>${usage.peak != null && usage.peak > usage.now ? `, за неделю доходил до ${pct(usage.peak)} %` : ''}`);
    if (usage.quotaStops) L.push(`Прогонов, остановленных из-за лимита: ${usage.quotaStops}`);
  }
  return { html: L.join('\n'), since, now, closed, tasksDone, work, goals, runs: { total, stats, workMs }, waiting: { questions, pending, proposed }, usage, demos };
}

export function composeWeekly(p, cfg, opts = {}) { return weeklyData(p, cfg, opts).html; }

/**
 * Отправить недельную сводку в Telegram; без токена или chat_id — в консоль. Запоминает, сколько пунктов целей сделано, —
 * следующая недельная сводка покажет прирост. При video.enabled следом уходит ролик; его сбой сводку не срывает.
 */
export async function sendWeekly(p, cfg, { now = new Date(), telegram = null, log = console.log, video = sendSummaryVideo } = {}) {
  const data = weeklyData(p, cfg, { now }); const html = data.html;
  const token = process.env[cfg.telegram.token_env];
  if (!token || !cfg.telegram.chat_id) { log(htmlToPlain(html)); log('\n(Telegram не настроен: недельная сводка выведена в консоль)'); return { sent: false, text: html }; }
  const tg = telegram || createTelegram({ token });
  let firstId = null;
  try {
    for (const [i, part] of splitHtml(html).entries()) { const sent = await tg.sendMessage(cfg.telegram.chat_id, part, { html: true }); if (i === 0) firstId = sent?.[0]?.message_id ?? null; }
  } catch (e) {
    const alarm = `⚠️ mcfly ${cfg.project}: недельная сводка не отправлена (${truncate(String(e?.message || e), 300)}), смотрите \`mcfly summary --weekly\``;
    try { await tg.sendMessage(cfg.telegram.chat_id, alarm); } catch (e2) { log(`Тревога тоже не отправлена: ${e2?.message || e2}; поставлена в очередь.`); enqueueNotice(p, { text: alarm }, now); }
    throw e;
  }
  const state = loadState(p);
  state.last_weekly_at = now.toISOString();
  if (data.goals) state.weekly_goals_done = data.goals.done;
  saveState(p, state);
  log(`Недельная сводка отправлена (${html.length} символов).`);
  const clip = cfg.video?.enabled ? await video(p, cfg, { data, tg, now, replyTo: firstId, log, weekly: true }) : null;
  return { sent: true, text: html, video: clip };
}
