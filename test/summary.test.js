import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs'; import path from 'node:path';
import { composeSummary, sendSummary } from '../src/summary.js';
import { paths, loadState } from '../src/state.js';
import { appendMetric } from '../src/metrics.js';
import { loadQuestions, addQuestion, saveQuestions } from '../src/questions.js';
import { listChanges, requestApproval } from '../src/approvals.js';
import { cfg, bareProject, addChange } from './helpers.js';

function seed() {
  const dir = bareProject(); const p = paths(dir);
  appendMetric(p, { type: 'run', id: '20260929-0000', slot: '00:00', mode: 'night', started_at: new Date(2026, 8, 29, 0, 1).toISOString(), status: 'ok', duration_ms: 3600000, cost_usd: 2.5, turns: 20 });
  fs.mkdirSync(path.join(p.runs, '20260929-0000'), { recursive: true });
  fs.writeFileSync(path.join(p.runs, '20260929-0000', 'summary.md'), '# Прогон\n## Сделано\n- задача 1');
  appendMetric(p, { type: 'event', at: new Date(2026, 8, 29, 1, 0).toISOString(), key: 'tasks_done', value: 2 });
  const data = loadQuestions(p); addQuestion(data, { category: 'spec', text: 'Формат?', defaultAnswer: 'YAML', now: new Date(2026, 8, 29, 1, 0) }, cfg); saveQuestions(p, data);
  addChange(dir, 'add-x', { proposal: '# add-x\n\nДобавить X, потому что Y.\n' }); requestApproval(listChanges(p.openspecChanges)[0], { now: new Date(2026, 8, 29, 1, 0) });
  return { dir, p };
}
test('composeSummary: прогоны, пропуски, отчёт, вопросы, одобрения, метрики', () => {
  const { p } = seed();
  const text = composeSummary(p, cfg, { now: new Date(2026, 8, 29, 8, 0), since: new Date(2026, 8, 28, 8, 0) });
  assert.match(text, /00:00 — ок, 20 ходов, ~\$2\.50, 1 ч 00 мин/);
  assert.match(text, /04:00 — пропущен/);
  assert.match(text, /задача 1/);
  assert.match(text, /Q1 \[spec\] Формат\?/);
  assert.match(text, /add-x \(авто-одобрение 30\.09 01:00\)\n  Добавить X, потому что Y\./);
  assert.match(text, /Метрики за период: 2 задач закрыто; прогонов 1, ~\$2\.5/);
});
test('sendSummary без Telegram печатает в консоль и не меняет state', async () => {
  const { p } = seed(); const lines = [];
  const r = await sendSummary(p, { ...cfg, telegram: { chat_id: '', token_env: 'NOPE' } }, { log: (s) => lines.push(s) });
  assert.equal(r.sent, false); assert.ok(lines.join('\n').includes('сводка'));
  assert.equal(loadState(p).last_summary_at, undefined);
});
test('sendSummary через Telegram обновляет last_summary_at', async () => {
  const { p } = seed(); const sent = [];
  const tg = { sendMessage: async (_c, t) => { sent.push(t); } };
  process.env.TOK = 'x';
  const r = await sendSummary(p, { ...cfg, telegram: { chat_id: '1', token_env: 'TOK' } }, { telegram: tg, now: new Date(2026, 8, 29, 8, 0), log: () => {} });
  assert.equal(r.sent, true); assert.equal(sent.length, 1); assert.ok(loadState(p).last_summary_at);
});
