import { appendText, readText } from './util.js';

export function appendMetric(p, record) { appendText(p.metrics, JSON.stringify(record) + '\n'); }
export function readMetrics(p) {
  return readText(p.metrics, '').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}
// Ходы и субагенты runner пишет в запись прогона сам; такие же события от агентов — неполный повтор, в счёт не идут (0.7.6).
const RUN_OWNED = new Set(['turns', 'subagents']);
/** Событие с ключом и числом: старая ошибка записи «tasks_done 7» без value — ключ и число из ключа. */
export function eventKV(r) {
  const m = /^([a-z_]+)\s+(\d+)$/.exec(String(r.key || '').trim());
  if (m && r.value == null) return [m[1], Number(m[2])];
  return [String(r.key), Number(r.value ?? 1)];
}
export function aggregate(records, { since = null } = {}) {
  const agg = { runs: 0, ok: 0, missed: 0, error: 0, timeout: 0, quota: 0, cost_usd: 0, turns: 0, subagents: 0, events: {} };
  for (const r of records) {
    const at = new Date(r.started_at || r.at || 0);
    if (since && at < since) continue;
    if (r.type === 'run') {
      agg.runs++; agg[r.status] = (agg[r.status] || 0) + 1; agg.cost_usd += Number(r.cost_usd || 0); agg.turns += Number(r.turns || 0);
      agg.subagents += Number(r.subagents?.spawned || 0);
    } else if (r.type === 'event') {
      const [key, value] = eventKV(r);
      if (!RUN_OWNED.has(key) && Number.isFinite(value)) agg.events[key] = (agg.events[key] || 0) + value;
    }
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
export const EVENT_LABELS = { tasks_done: 'задач закрыто', escalations: 'эскалаций', review_rejections: 'возвратов с ревью', changes_proposed: 'изменений предложено', changes_archived: 'изменений завершено', tests_failed: 'падений тестов', ideas_added: 'предложений добавлено' };
export function formatEvents(events) {
  const keys = Object.keys(events);
  return keys.length ? keys.map((k) => `${events[k]} ${EVENT_LABELS[k] || k}`).join(', ') : 'нет событий';
}
