import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs'; import path from 'node:path';
import { init, upsertSection, mergeSettings, ensureGitignore } from '../src/init.js';
import { tmpDir } from './helpers.js';

test('init создаёт файлы, идемпотентен и не перезаписывает', () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'CLAUDE.md'), '# Проект\n\nСвои правила.\n');
  const r = init({ projectDir: dir, name: 'demo', skipOpenspec: true, log: () => {} });
  assert.ok(r.created.includes('mcfly/config.yaml'));
  assert.match(fs.readFileSync(path.join(dir, 'mcfly', 'config.yaml'), 'utf8'), /project: demo/);
  fs.writeFileSync(path.join(dir, 'mcfly', 'progress.md'), 'МОЁ');
  init({ projectDir: dir, name: 'demo', skipOpenspec: true, log: () => {} });
  assert.equal(fs.readFileSync(path.join(dir, 'mcfly', 'progress.md'), 'utf8'), 'МОЁ');
  const claude = fs.readFileSync(path.join(dir, 'CLAUDE.md'), 'utf8');
  assert.match(claude, /Свои правила/); assert.equal(claude.split('<!-- mcfly:start -->').length, 2);
  const settings = JSON.parse(fs.readFileSync(path.join(dir, '.claude', 'settings.json'), 'utf8'));
  assert.ok(settings.permissions.deny.includes('Bash(sudo *)'));
  assert.match(fs.readFileSync(path.join(dir, '.gitignore'), 'utf8'), /mcfly\/\.env/);
});
test('upsertSection заменяет блок между маркерами', () => {
  const once = upsertSection('старое', 'A');
  assert.equal(upsertSection(once, 'B'), 'старое\n\n<!-- mcfly:start -->\nB\n<!-- mcfly:end -->\n');
});
test('mergeSettings объединяет deny без дублей', () => {
  const m = mergeSettings({ permissions: { deny: ['X'], allow: ['Y'] }, other: 1 }, { enableAllProjectMcpServers: true, permissions: { deny: ['X', 'Z'] } });
  assert.deepEqual(m.permissions.deny, ['X', 'Z']); assert.deepEqual(m.permissions.allow, ['Y']); assert.equal(m.other, 1); assert.equal(m.enableAllProjectMcpServers, true);
});
test('ensureGitignore добавляет только недостающее', () => {
  const dir = tmpDir(); fs.writeFileSync(path.join(dir, '.gitignore'), 'a\n');
  assert.deepEqual(ensureGitignore(dir, ['a', 'b']), ['b']);
  assert.deepEqual(ensureGitignore(dir, ['a', 'b']), []);
});
