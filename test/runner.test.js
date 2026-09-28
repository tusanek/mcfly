import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs'; import path from 'node:path';
import { run, acquireLock, releaseLock } from '../src/runner.js';
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
  assert.ok(fs.existsSync(path.join(p.runs, r.id, 'prompt.md')));
  assert.equal(fs.existsSync(p.lock), false);
});
test('лок не даёт второго прогона', () => {
  const p = paths(bareProject());
  assert.equal(acquireLock(p), true); assert.equal(acquireLock(p), false); releaseLock(p); assert.equal(acquireLock(p), true); releaseLock(p);
});
