import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { runId, fmtLocal, fmtShort, fmtDuration, truncate, readJson, writeJson, appendText, readText } from '../src/util.js';

test('runId и форматы дат', () => {
  const d = new Date(2026, 8, 29, 4, 5);
  assert.equal(runId(d), '20260929-0405');
  assert.equal(fmtLocal(d), '2026-09-29 04:05');
  assert.equal(fmtShort(d), '29.09 04:05');
});
test('fmtDuration и truncate', () => {
  assert.equal(fmtDuration(5 * 60000), '5 мин');
  assert.equal(fmtDuration(125 * 60000), '2 ч 05 мин');
  assert.equal(truncate('абвгд', 3), 'аб…');
  assert.equal(truncate('аб', 3), 'аб');
});
test('json и append создают каталоги', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcfly-util-'));
  const f = path.join(dir, 'a', 'b.json');
  writeJson(f, { x: 1 }); assert.deepEqual(readJson(f), { x: 1 });
  assert.equal(readJson(path.join(dir, 'нет.json'), 'fb'), 'fb');
  appendText(path.join(dir, 'c', 'log.md'), 'a\n'); appendText(path.join(dir, 'c', 'log.md'), 'b\n');
  assert.equal(readText(path.join(dir, 'c', 'log.md')), 'a\nb\n');
});
