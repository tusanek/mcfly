import path from 'node:path';
import { readText, fmtShort, fmtDuration, truncate, pad2 } from './util.js';
import { readMetrics, aggregate, formatEvents } from './metrics.js';
import { loadQuestions, openQuestions } from './questions.js';
import { listChanges, pendingApprovals, approvedWithWork, proposalExcerpt, approvalDeadline, isAutoApprovable } from './approvals.js';
import { expectedSlots, slotKey } from './window.js';
import { loadState, saveState } from './state.js';
import { createTelegram } from './telegram.js';

const STATUS_RU = { ok: 'ок', missed: 'пропущен', error: 'ошибка', timeout: 'остановлен по времени', quota: 'остановлен: лимит квоты', locked: 'не запущен (шёл другой прогон)' };

export function composeSummary(p, cfg, { now = new Date(), since = null } = {}) {
  const records = readMetrics(p);
  const runs = records.filter((r) => r.type === 'run' && (!since || new Date(r.started_at) > since));
  const L = [`☀️ mcfly · ${cfg.project} · сводка ${pad2(now.getDate())}.${pad2(now.getMonth() + 1)}.${now.getFullYear()}`, '', 'Прогоны:'];
  const covered = new Set(runs.filter((r) => r.slot).map((r) => slotKey(new Date(r.started_at), r.slot)));
  const expected = since ? expectedSlots(since, now, cfg.schedule.slots) : [];
  if (!runs.length && !expected.length) L.push('• прогонов не было');
  for (const r of runs) {
    const turns = r.turns != null ? `, ${r.turns} ходов` : '';
    const cost = r.cost_usd != null ? `, ~$${Number(r.cost_usd).toFixed(2)}` : '';
    const dur = r.duration_ms ? `, ${fmtDuration(r.duration_ms)}` : '';
    L.push(`• ${r.slot || fmtShort(new Date(r.started_at))} — ${STATUS_RU[r.status] || r.status}${turns}${cost}${dur}${r.note ? ' — ' + r.note : ''}`);
  }
  for (const e of expected) if (!covered.has(e.key)) L.push(`• ${e.slot} — пропущен (Mac был выключен или спал). Вручную: mcfly run --mode day`);
  const reports = runs.map((r) => readText(path.join(p.runs, r.id || '', 'summary.md'), '').trim()).filter(Boolean);
  L.push('', 'Отчёт команды:', reports.length ? reports.map((s) => truncate(s, 1500)).join('\n\n') : '(отчёта нет)');
  const q = openQuestions(loadQuestions(p));
  L.push('', `Вопросы к вам (${q.length}). Ответ: "Q3: b" или "Q3 свой текст":`);
  for (const x of q) L.push(`• ${x.id} [${x.category}] ${x.text}\n  по умолчанию: ${x.default || '(нет)'} · срок ${fmtShort(new Date(x.deadline_at))}`);
  const changes = listChanges(p.openspecChanges);
  const pend = pendingApprovals(changes);
  L.push('', `Одобрения (${pend.length}). Ответ: "approve имя" или "reject имя причина":`);
  for (const c of pend) L.push(`• ${c.name} (${isAutoApprovable(c, cfg) ? 'авто-одобрение ' + fmtShort(approvalDeadline(c, cfg)) : 'без авто-одобрения'})\n  ${proposalExcerpt(c, 400)}`);
  const work = approvedWithWork(changes);
  if (work.length) { L.push('', 'В работе:'); for (const c of work) L.push(`• ${c.name}: ${c.tasksDone}/${c.tasksDone + c.tasksOpen} задач`); }
  const period = aggregate(records, { since }); const total = aggregate(records);
  L.push('', `Метрики за период: ${formatEvents(period.events)}; прогонов ${period.runs}, ~$${period.cost_usd}.`, `Всего: ${formatEvents(total.events)}; прогонов ${total.runs}, ~$${total.cost_usd}.`);
  return L.join('\n');
}

export async function sendSummary(p, cfg, { now = new Date(), telegram = null, log = console.log } = {}) {
  const state = loadState(p);
  const since = state.last_summary_at ? new Date(state.last_summary_at) : new Date(now.getTime() - 24 * 3600_000);
  const text = composeSummary(p, cfg, { now, since });
  const token = process.env[cfg.telegram.token_env];
  if (!token || !cfg.telegram.chat_id) { log(text); log('\n(Telegram не настроен: сводка выведена в консоль)'); return { sent: false, text }; }
  const tg = telegram || createTelegram({ token });
  await tg.sendMessage(cfg.telegram.chat_id, text);
  state.last_summary_at = now.toISOString(); saveState(p, state);
  log(`Сводка отправлена (${text.length} символов).`);
  return { sent: true, text };
}
