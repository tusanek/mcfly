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

test('навыки передачи смены: take-shift и hand-shift с name и description', () => {
  for (const name of ['take-shift', 'hand-shift']) {
    const text = fs.readFileSync(path.join(MCFLY_ROOT, 'skills', name, 'SKILL.md'), 'utf8');
    assert.match(text, new RegExp(`^---\\nname: ${name}\\ndescription: .+\\n---\\n`));
    assert.match(text, /mcfly shift/);
  }
  assert.match(fs.readFileSync(path.join(MCFLY_ROOT, 'skills', 'mcfly-process', 'SKILL.md'), 'utf8'), /## Передача смены/);
});

test('hand-shift: [x] в tasks.md отмечается до shift merge — после merge сессия в detached HEAD', () => {
  const text = fs.readFileSync(path.join(MCFLY_ROOT, 'skills', 'hand-shift', 'SKILL.md'), 'utf8');
  assert.ok(text.indexOf('[x]') < text.indexOf('mcfly shift merge'), 'отметка задач раньше слияния');
  assert.match(text, /после merge .*не коммить/i);
});

const read = (...p) => fs.readFileSync(path.join(MCFLY_ROOT, ...p), 'utf8');
/** Тексты, которые читают агенты прогона: роли, навыки, промпт прогона, слэш-команды. */
function pluginTexts() {
  const files = [];
  for (const f of fs.readdirSync(path.join(MCFLY_ROOT, 'agents'))) files.push(['agents', f]);
  for (const d of fs.readdirSync(path.join(MCFLY_ROOT, 'skills'))) files.push(['skills', d, 'SKILL.md']);
  for (const f of fs.readdirSync(path.join(MCFLY_ROOT, 'prompts'))) files.push(['prompts', f]);
  for (const f of fs.readdirSync(path.join(MCFLY_ROOT, 'commands'))) files.push(['commands', f]);
  return files.filter((f) => f.at(-1).endsWith('.md')).map((f) => ({ name: f.join('/'), text: read(...f) }));
}

test('переключение и сброс веток упоминаются только как запрет — классификатор их отклоняет', () => {
  for (const { name, text } of pluginTexts()) {
    for (const line of text.split('\n')) {
      if (/git (checkout|switch|reset)\b/.test(line)) {
        assert.match(line, /запрещ|отклоня|не поручай/i, `${name}: ${line.slice(0, 120)}`);
      }
    }
  }
});

test('схема веток: worktree разработчику создаёт Claude Code, он сливает change/<имя>, лид забирает fetch', () => {
  const dev = read('agents', 'developer.md');
  assert.match(dev, /^isolation: worktree$/m);
  assert.match(dev, /git merge --ff-only change\/<имя>/);
  assert.match(dev, /git merge --no-edit change\/<имя>/);
  for (const f of [['skills', 'mcfly-process', 'SKILL.md'], ['prompts', 'run.md'], ['agents', 'lead.md']]) {
    assert.match(read(...f), /git fetch \. worktree-agent-<id>:change\/<имя>/, f.join('/'));
  }
  assert.match(read('skills', 'mcfly-process', 'SKILL.md'), /## Рабочие копии и ветки/);
});

test('репортёр без Write и Edit возвращает тексты, файлы отчёта пишет лид', () => {
  const rep = read('agents', 'reporter.md');
  const tools = /^tools: (.+)$/m.exec(rep)?.[1] || '';
  assert.ok(tools, 'у репортёра явный список инструментов');
  assert.ok(!/\b(Write|Edit)\b/.test(tools), tools);
  assert.match(rep, /^Файл: <путь>/m);
  assert.match(read('skills', 'mcfly-process', 'SKILL.md'), /## Отчёт прогона/);
  assert.match(read('prompts', 'run.md'), /файлы записываешь и коммитишь ты/);
});
