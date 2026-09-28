import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs'; import path from 'node:path';
import { MCFLY_ROOT } from '../src/prompt.js';

const ROLES = ['lead', 'analyst', 'architect', 'planner', 'developer', 'tester', 'reviewer', 'devops', 'designer', 'reporter'];
test('манифест, агенты, скиллы и хук на месте', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(MCFLY_ROOT, '.claude-plugin', 'plugin.json'), 'utf8'));
  assert.equal(manifest.name, 'mcfly');
  for (const r of ROLES) {
    const text = fs.readFileSync(path.join(MCFLY_ROOT, 'agents', `${r}.md`), 'utf8');
    assert.match(text, new RegExp(`^---\\nname: ${r}\\ndescription: .+\\n`), r);
  }
  for (const s of ['mcfly-process', 'mcfly-openspec']) assert.match(fs.readFileSync(path.join(MCFLY_ROOT, 'skills', s, 'SKILL.md'), 'utf8'), new RegExp(`^---\\nname: ${s}\\n`));
  const hooks = JSON.parse(fs.readFileSync(path.join(MCFLY_ROOT, 'hooks', 'hooks.json'), 'utf8'));
  assert.ok(hooks.hooks.SessionStart);
  for (const c of ['run', 'status']) assert.match(fs.readFileSync(path.join(MCFLY_ROOT, 'commands', `${c}.md`), 'utf8'), /^---\ndescription: /);
});
