import { appendText, readText } from './util.js';

export function appendMetric(p, record) { appendText(p.metrics, JSON.stringify(record) + '\n'); }
export function readMetrics(p) {
  return readText(p.metrics, '').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}
export function aggregate(records, { since = null } = {}) {
  const agg = { runs: 0, ok: 0, missed: 0, error: 0, timeout: 0, quota: 0, cost_usd: 0, turns: 0, events: {} };
  for (const r of records) {
    const at = new Date(r.started_at || r.at || 0);
    if (since && at < since) continue;
    if (r.type === 'run') { agg.runs++; agg[r.status] = (agg[r.status] || 0) + 1; agg.cost_usd += Number(r.cost_usd || 0); agg.turns += Number(r.turns || 0); }
    else if (r.type === 'event') agg.events[r.key] = (agg.events[r.key] || 0) + Number(r.value ?? 1);
  }
  agg.cost_usd = Math.round(agg.cost_usd * 100) / 100;
  return agg;
}
/** Хвост строки прогона для журнала и сводки: «, N ходов, ~$X, субагентов M (фоном B, упало F, убито K)» — аномалии только ненулевые. */
export function runStats(r) {
  const parts = [];
  if (r.turns != null) parts.push(`${r.turns} ходов`);
  if (r.cost_usd != null) parts.push(`~$${Number(r.cost_usd).toFixed(2)}`);
  const s = r.subagents;
  if (s?.spawned) {
    const odd = [['фоном', s.background], ['упало', s.failed], ['убито', s.killed]].filter(([, n]) => n > 0).map(([k, n]) => `${k} ${n}`);
    parts.push(`субагентов ${s.spawned}${odd.length ? ` (${odd.join(', ')})` : ''}`);
  }
  if (r.permission_denials > 0) parts.push(`отказов разрешений ${r.permission_denials}`);
  return parts.map((x) => `, ${x}`).join('');
}
export const EVENT_LABELS = { tasks_done: 'задач закрыто', escalations: 'эскалаций', review_rejections: 'возвратов с ревью', changes_proposed: 'изменений предложено', changes_archived: 'изменений завершено', tests_failed: 'падений тестов' };
export function formatEvents(events) {
  const keys = Object.keys(events);
  return keys.length ? keys.map((k) => `${events[k]} ${EVENT_LABELS[k] || k}`).join(', ') : 'нет событий';
}
