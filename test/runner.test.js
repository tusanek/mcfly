import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs'; import path from 'node:path';
import { run, acquireLock, releaseLock, commitRunState, recordRun, writeFallbackSummary } from '../src/runner.js';
import { spawnSync } from 'node:child_process';
import { paths } from '../src/state.js';
import { readMetrics } from '../src/metrics.js';
import { bareProject, fakeClaude } from './helpers.js';

const resultEvent = (over = {}) => ({ type: 'result', subtype: 'success', is_error: false, num_turns: 1, total_cost_usd: 0.1, session_id: 's', result: 'готово', ...over });
const readRecord = (p, id) => JSON.parse(fs.readFileSync(path.join(p.runs, id, 'result.json'), 'utf8'));

test('ночной прогон вне окна записывается как пропущенный', async () => {
  const dir = bareProject(); const p = paths(dir);
  const r = await run({ projectDir: dir, mode: 'night', now: new Date(2026, 8, 29, 6, 0), log: () => {} });
  assert.equal(r.status, 'missed');
  const rec = readMetrics(p)[0];
  assert.equal(rec.status, 'missed'); assert.match(rec.note, /вне окна/);
  assert.match(fs.readFileSync(p.progress, 'utf8'), /missed/);
});
test('dry-run внутри окна сохраняет промпт и не запускает claude', async () => {
  const dir = bareProject(); const p = paths(dir);
  const r = await run({ projectDir: dir, mode: 'night', dryRun: true, now: new Date(2026, 8, 29, 0, 5), log: () => {} });
  assert.equal(r.status, 'dry-run');
  assert.ok(fs.existsSync(path.join(p.logs, `dry-run-${r.id}.prompt.md`)));
  assert.equal(fs.existsSync(path.join(p.runs, r.id)), false, 'сухой прогон не создаёт каталог в runs');
  assert.equal(fs.existsSync(p.lock), false);
});
test('прогон запускает claude без фоновых задач и без потолка ожидания фона', async () => {
  const dir = bareProject();
  fakeClaude(dir, { lines: [resultEvent()] });
  await run({ projectDir: dir, mode: 'day', log: () => {} });
  const env = fs.readFileSync(path.join(dir, 'claude-env.txt'), 'utf8');
  assert.match(env, /^CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1$/m);
  assert.match(env, /^CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS=0$/m);
});
test('result.json: ходы по всем событиям result и статистика субагентов', async () => {
  const dir = bareProject(); const p = paths(dir);
  const stats = { spawned: 8, requested: { background: 0, foreground: 0, unset: 8 }, started_in_background: 8, completed: 7, failed: 0, killed: { parent: 0, user: 0, system: 1 } };
  fakeClaude(dir, { lines: [resultEvent({ num_turns: 12, result: 'Жду devops.' }), resultEvent({ num_turns: 3, result: 'Жду разработчика 3.2.', subagent_stats: stats })] });
  const r = await run({ projectDir: dir, mode: 'day', log: () => {} });
  const rec = readRecord(p, r.id);
  assert.equal(rec.turns, 15);
  assert.deepEqual(rec.subagents, { spawned: 8, background: 8, failed: 0, killed: 1 });
});
test('stderr claude попадает в events.log', async () => {
  const dir = bareProject(); const p = paths(dir);
  fakeClaude(dir, { lines: [resultEvent()], stderr: 'Background tasks still running after 600s; terminating.' });
  const r = await run({ projectDir: dir, mode: 'day', log: () => {} });
  assert.match(fs.readFileSync(path.join(p.runs, r.id, 'events.log'), 'utf8'), /⚠ Background tasks still running after 600s; terminating\./);
});
test('recordRun: строка журнала со статистикой субагентов, аномалии только ненулевые', () => {
  const p = paths(bareProject());
  recordRun(p, { id: 'r1', mode: 'night', slot: '04:00', started_at: new Date(2026, 8, 29, 4, 0).toISOString(), status: 'ok', turns: 30, cost_usd: 4.1, subagents: { spawned: 8, background: 8, failed: 0, killed: 1 } });
  recordRun(p, { id: 'r2', mode: 'night', slot: '00:00', started_at: new Date(2026, 8, 30, 0, 0).toISOString(), status: 'ok', turns: 5, cost_usd: 1, subagents: { spawned: 3, background: 0, failed: 0, killed: 0 } });
  const text = fs.readFileSync(p.progress, 'utf8');
  assert.match(text, /прогон r1 \(night, слот 04:00\): ok, 30 ходов, ~\$4\.10, субагентов 8 \(фоном 8, убито 1\)\n/);
  assert.match(text, /прогон r2 \(night, слот 00:00\): ok, 5 ходов, ~\$1\.00, субагентов 3\n/);
});
test('лок не даёт второго прогона', () => {
  const p = paths(bareProject());
  assert.equal(acquireLock(p), true); assert.equal(acquireLock(p), false); releaseLock(p); assert.equal(acquireLock(p), true); releaseLock(p);
});
test('commitRunState коммитит служебные файлы прогона', () => {
  const dir = bareProject(); const p = paths(dir);
  spawnSync('git', ['init', '-q'], { cwd: dir }); spawnSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init'], { cwd: dir });
  recordRun(p, { id: 'r1', mode: 'day', slot: null, started_at: new Date().toISOString(), ended_at: new Date().toISOString(), status: 'ok' });
  const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
  const prev = process.env; process.env = env;
  try { assert.equal(commitRunState(dir, 'r1', () => {}), true); } finally { process.env = prev; }
  assert.match(spawnSync('git', ['log', '--oneline', '-1'], { cwd: dir, encoding: 'utf8' }).stdout, /результат прогона r1/);
  assert.equal(spawnSync('git', ['status', '--porcelain', 'mcfly/progress.md'], { cwd: dir, encoding: 'utf8' }).stdout.trim(), '');
});
test('writeFallbackSummary пишет авто-сводку, если репортёр не написал отчёт', () => {
  const dir = bareProject(); const p = paths(dir);
  const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
  spawnSync('git', ['init', '-q'], { cwd: dir, env }); spawnSync('git', ['commit', '-q', '--allow-empty', '-m', 'init'], { cwd: dir, env });
  const started = new Date(Date.now() - 60_000);
  spawnSync('git', ['commit', '-q', '--allow-empty', '-m', 'feat(x): работа ночью'], { cwd: dir, env });
  const runDir = path.join(p.runs, 'r2'); fs.mkdirSync(runDir, { recursive: true });
  assert.equal(writeFallbackSummary({ projectDir: dir, runDir, id: 'r2', started, resultText: 'Жду разработчика 3.2.' }), true);
  const text = fs.readFileSync(path.join(runDir, 'summary.md'), 'utf8');
  assert.match(text, /авто-сводка/); assert.match(text, /работа ночью/); assert.match(text, /Жду разработчика/);
  assert.equal(writeFallbackSummary({ projectDir: dir, runDir, id: 'r2', started, resultText: '' }), false, 'существующий отчёт не перезаписывается');
});
