import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs'; import path from 'node:path';
import { init, upsertSection, mergeSettings, ensureGitignore } from '../src/init.js';
import { tmpDir } from './helpers.js';
import { parseConfig } from '../src/config.js';

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
  // 0.15.6: команды, которые процесс разрешает ролям, не зависят от автоматической проверки разрешений
  for (const rule of ['Bash(mcfly finding add *)', 'Bash(mcfly ideas add *)', 'Bash(mcfly metric add *)', 'Bash(mcfly question add *)']) assert.ok(settings.permissions.allow.includes(rule), rule);
  // секреты продукта в корневом .env агентам недоступны так же, как mcfly/.env
  for (const rule of ['Read(./.env)', 'Edit(./.env)']) assert.ok(settings.permissions.deny.includes(rule), rule);
  // 0.19.1: Claude Code не применяет запреты Write(...) и предупреждает о них на каждом claude -p — защищает Edit(...)
  assert.ok(!settings.permissions.deny.some((r) => r.startsWith('Write(')), JSON.stringify(settings.permissions.deny));
  assert.match(fs.readFileSync(path.join(dir, '.gitignore'), 'utf8'), /mcfly\/\.env/);
  assert.match(fs.readFileSync(path.join(dir, '.gitignore'), 'utf8'), /^\.playwright-mcp\/$/m, '0.17.2: файлы Playwright MCP не попадают в git');
  assert.ok(fs.existsSync(path.join(dir, 'mcfly', 'shifts')), 'init создаёт mcfly/shifts');
});
test('upsertSection заменяет блок между маркерами', () => {
  const once = upsertSection('старое', 'A');
  assert.equal(upsertSection(once, 'B'), 'старое\n\n<!-- mcfly:start -->\nB\n<!-- mcfly:end -->\n');
});
test('mergeSettings объединяет deny без дублей', () => {
  const m = mergeSettings({ permissions: { deny: ['X'], allow: ['Y'] }, other: 1 }, { enableAllProjectMcpServers: true, permissions: { deny: ['X', 'Z'] } });
  assert.deepEqual(m.permissions.deny, ['X', 'Z']); assert.deepEqual(m.permissions.allow, ['Y']); assert.equal(m.other, 1); assert.equal(m.enableAllProjectMcpServers, true);
});
test('mergeSettings не перетирает настройки пользователя значениями шаблона', () => {
  const m = mergeSettings({ enableAllProjectMcpServers: false }, { enableAllProjectMcpServers: true, permissions: { deny: ['Z'] } });
  assert.equal(m.enableAllProjectMcpServers, false); assert.deepEqual(m.permissions.deny, ['Z']);
});
test('mergeSettings убирает устаревшие запреты Write(...), которые ставил прежний mcfly', () => {
  const m = mergeSettings({ permissions: { deny: ['Write(./mcfly/config.yaml)', 'Write(./mcfly/.env)', 'Write(./.env)', 'Write(./своё)', 'X'] } }, { permissions: { deny: ['Edit(./.env)'] } });
  assert.deepEqual(m.permissions.deny, ['Write(./своё)', 'X', 'Edit(./.env)']);
});
test('ensureGitignore добавляет только недостающее', () => {
  const dir = tmpDir(); fs.writeFileSync(path.join(dir, '.gitignore'), 'a\n');
  assert.deepEqual(ensureGitignore(dir, ['a', 'b']), ['b']);
  assert.deepEqual(ensureGitignore(dir, ['a', 'b']), []);
});

test('0.7.0: init создаёт ideas.yaml и раздел ideas в config', () => {
  const dir = tmpDir();
  init({ projectDir: dir, name: 'demo', skipOpenspec: true, log: () => {} });
  assert.equal(fs.readFileSync(path.join(dir, 'mcfly', 'ideas.yaml'), 'utf8'), 'ideas: []\n');
  const conf = fs.readFileSync(path.join(dir, 'mcfly', 'config.yaml'), 'utf8');
  assert.match(conf, /^ideas:\n  enabled: true/m); assert.match(conf, /backlog: ""/);
  assert.equal(parseConfig(conf).ideas.per_run, 2);
});

test('0.15.7: повторный init без имени берёт проект из настроек, а не из названия папки', () => {
  const dir = tmpDir();
  init({ projectDir: dir, name: 'my-project', skipOpenspec: true, log: () => {} });
  const logs = []; init({ projectDir: dir, skipOpenspec: true, log: (s) => logs.push(s) });
  assert.match(fs.readFileSync(path.join(dir, 'CLAUDE.md'), 'utf8'), /Проект my-project разрабатывает/);
  assert.match(logs[0], /\(проект my-project\)/);
});
test('0.15.7: повторный init не перечисляет неизменённые файлы и не печатает подсказку первой установки', () => {
  const dir = tmpDir();
  const first = []; init({ projectDir: dir, name: 'demo', skipOpenspec: true, log: (s) => first.push(s) });
  assert.ok(first.some((l) => /впишите токен бота/.test(l)), 'первая установка — полная подсказка');
  fs.writeFileSync(path.join(dir, 'mcfly', '.env'), 'X=1\n');
  const again = []; const r = init({ projectDir: dir, skipOpenspec: true, log: (s) => again.push(s) });
  assert.deepEqual(r.created, []);
  assert.ok(!again.some((l) => /впишите токен бота/.test(l)), again.join('\n'));
  assert.ok(again.some((l) => /^Дальше: mcfly doctor/.test(l)), again.join('\n'));
});
