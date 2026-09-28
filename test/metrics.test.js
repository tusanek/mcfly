import test from 'node:test';
import assert from 'node:assert/strict';
import { paths } from '../src/state.js';
import { appendMetric, readMetrics, aggregate, formatEvents } from '../src/metrics.js';
import { bareProject } from './helpers.js';

test('append/read/aggregate', () => {
  const p = paths(bareProject());
  appendMetric(p, { type: 'run', started_at: '2026-09-29T00:00:00Z', status: 'ok', cost_usd: 1.25, turns: 10 });
  appendMetric(p, { type: 'run', started_at: '2026-09-29T04:00:00Z', status: 'missed' });
  appendMetric(p, { type: 'event', at: '2026-09-29T01:00:00Z', key: 'tasks_done', value: 3 });
  appendMetric(p, { type: 'event', at: '2026-09-28T01:00:00Z', key: 'tasks_done', value: 1 });
  const all = aggregate(readMetrics(p));
  assert.equal(all.runs, 2); assert.equal(all.ok, 1); assert.equal(all.missed, 1); assert.equal(all.cost_usd, 1.25); assert.equal(all.events.tasks_done, 4);
  const night = aggregate(readMetrics(p), { since: new Date('2026-09-28T20:00:00Z') });
  assert.equal(night.events.tasks_done, 3);
  assert.equal(formatEvents({ tasks_done: 3, x: 1 }), '3 задач закрыто, 1 x');
  assert.equal(formatEvents({}), 'нет событий');
});
