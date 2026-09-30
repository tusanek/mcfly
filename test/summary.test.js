import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs'; import path from 'node:path';
import { composeSummary, sendSummary } from '../src/summary.js';
import { paths, loadState } from '../src/state.js';
import { appendMetric } from '../src/metrics.js';
import { loadQuestions, addQuestion, saveQuestions } from '../src/questions.js';
import { listChanges, requestApproval, setApproval } from '../src/approvals.js';
import { cfg, bareProject, addChange, git, gitRepo, changeBranch } from './helpers.js';

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
  assert.match(text, /Метрики за период: 2 задач закрыто; прогонов 1 \(ок 1\), ~\$2\.5/);
});
test('composeSummary: статистика субагентов в строке прогона', () => {
  const p = paths(bareProject());
  appendMetric(p, { type: 'run', id: '20260930-0000', slot: '00:00', mode: 'night', started_at: new Date(2026, 8, 30, 0, 0).toISOString(), status: 'quota', duration_ms: 1_800_000, cost_usd: 9.9, turns: 58, subagents: { spawned: 16, background: 0, failed: 4, killed: 0 } });
  const text = composeSummary(p, cfg, { now: new Date(2026, 8, 30, 8, 0), since: new Date(2026, 8, 29, 8, 0) });
  assert.match(text, /00:00 — остановлен: лимит квоты, 58 ходов, ~\$9\.90, субагентов 16 \(упало 4\), 30 мин/);
});
test('composeSummary: отчёт каждого прогона под подписью, без отчёта — «(отчёта нет)», пропущенные без отчёта', () => {
  const p = paths(bareProject());
  const night = (id, h, status) => appendMetric(p, { type: 'run', id, slot: `0${h}:00`, mode: 'night', started_at: new Date(2026, 8, 30, h, 0).toISOString(), status });
  night('20260930-0000', 0, 'ok'); night('20260930-0400', 4, 'ok');
  appendMetric(p, { type: 'run', id: '20260929-2300', slot: null, mode: 'night', started_at: new Date(2026, 8, 29, 23, 0).toISOString(), status: 'missed' });
  fs.mkdirSync(path.join(p.runs, '20260930-0400'), { recursive: true });
  fs.writeFileSync(path.join(p.runs, '20260930-0400', 'summary.md'), '# Прогон 20260930-0400\n- сделано 3.2');
  const text = composeSummary(p, cfg, { now: new Date(2026, 8, 30, 8, 0), since: new Date(2026, 8, 29, 8, 0) });
  assert.match(text, /Отчёты команды:\n— 00:00 · 20260930-0000 —\n\(отчёта нет\)\n\n— 04:00 · 20260930-0400 —\n# Прогон 20260930-0400\n- сделано 3\.2\n/);
  assert.doesNotMatch(text, /· 20260929-2300 —/);
});
test('composeSummary: «В работе» считает задачи по ветке change/<имя>, если она есть', () => {
  const dir = bareProject(); const p = paths(dir);
  addChange(dir, 'ddm', { tasks: '- [ ] a\n- [ ] b\n- [ ] c\n' });
  const [c] = listChanges(p.openspecChanges); requestApproval(c); setApproval(c, 'approved', 'human');
  gitRepo(dir); git(dir, 'add', '.'); git(dir, 'commit', '-q', '-m', 'проект');
  changeBranch(dir, 'ddm', '- [x] a\n- [x] b\n- [ ] c\n');
  const text = composeSummary(p, cfg, { now: new Date(2026, 8, 30, 8, 0), since: new Date(2026, 8, 29, 8, 0) });
  assert.match(text, /В работе:\n• ddm: 2\/3 задач \(ветка change\/ddm\)/);
});
test('composeSummary: у prod-вопроса нет «по умолчанию» и срока — решение за человеком', () => {
  const p = paths(bareProject());
  const data = loadQuestions(p); addQuestion(data, { category: 'prod', text: 'Ставить на сервер?', now: new Date(2026, 8, 29, 1, 0) }, cfg); saveQuestions(p, data);
  const text = composeSummary(p, cfg, { now: new Date(2026, 8, 29, 8, 0), since: new Date(2026, 8, 28, 8, 0) });
  assert.match(text, /• Q1 \[prod\] Ставить на сервер\?\n {2}без ответа по умолчанию: команда ждёт вашего решения\n/);
});
test('composeSummary: метрики за период с числом прогонов по статусам', () => {
  const p = paths(bareProject());
  for (const [h, status] of [[0, 'quota'], [4, 'quota'], [12, 'ok']]) appendMetric(p, { type: 'run', id: `r${h}`, mode: 'night', started_at: new Date(2026, 8, 30, h, 0).toISOString(), status });
  const text = composeSummary(p, cfg, { now: new Date(2026, 8, 30, 13, 0), since: new Date(2026, 8, 29, 13, 0) });
  assert.match(text, /Метрики за период: нет событий; прогонов 3 \(квота 2, ок 1\), ~\$0\./);
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
