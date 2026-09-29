import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs'; import path from 'node:path';
import { run, acquireLock, releaseLock, commitRunState, recordRun, writeFallbackSummary } from '../src/runner.js';
import { spawnSync } from 'node:child_process';
import { paths } from '../src/state.js';
import { readMetrics } from '../src/metrics.js';
import { bareProject } from './helpers.js';

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
