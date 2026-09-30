import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { tmpDir, addChange, git, gitRepo, changeBranch } from './helpers.js';
import { MCFLY_ROOT } from '../src/prompt.js';

const bin = path.join(MCFLY_ROOT, 'bin', 'mcfly');
const cli = (args, cwd) => spawnSync(process.execPath, [bin, ...args], { cwd, encoding: 'utf8', env: { ...process.env, MCFLY_PROJECT_DIR: '' } });

test('status показывает прогресс невлитого изменения по ветке change/<имя>', () => {
  const dir = tmpDir();
  cli(['init', '--name', 'demo'], dir);
  addChange(dir, 'ddm', { tasks: '- [ ] a\n- [ ] b\n- [ ] c\n' });
  cli(['approval', 'set', 'ddm', 'approved'], dir);
  gitRepo(dir); git(dir, 'add', '.'); git(dir, 'commit', '-q', '-m', 'проект');
  changeBranch(dir, 'ddm', '- [x] a\n- [x] b\n- [ ] c\n');
  assert.match(cli(['status'], dir).stdout, /- ddm: одобрение=approved, задач 0\/3 \(на ветке change\/ddm: 2\/3\)/);
});

test('одобрение: агент в прогоне не ставит approval set, неизвестная категория запроса отклоняется', () => {
  const dir = tmpDir();
  cli(['init', '--name', 'demo'], dir);
  addChange(dir, 'deploy-x');
  const inRun = spawnSync(process.execPath, [bin, 'approval', 'set', 'deploy-x', 'approved'], { cwd: dir, encoding: 'utf8', env: { ...process.env, MCFLY_PROJECT_DIR: '', MCFLY_RUN_ID: '20260930-0000' } });
  assert.equal(inRun.status, 1); assert.match(inRun.stderr, /только человек/);
  assert.match(cli(['approval', 'list'], dir).stdout, /deploy-x: не запрошено/);
  const bad = cli(['approval', 'request', 'deploy-x', '--category', 'production'], dir);
  assert.equal(bad.status, 1); assert.match(bad.stderr, /категория/);
});
test('help, init, status, question, approval, metric, context, doctor, dry-run, summary', () => {
  const dir = tmpDir();
  assert.match(cli(['--help'], dir).stdout, /Команды:/);
  assert.equal(cli(['status'], dir).status, 1);
  assert.match(cli(['init', '--name', 'demo'], dir).stdout, /инициализирован/);
  assert.match(cli(['status'], dir).stdout, /Проект demo/);
  assert.match(cli(['question', 'add', '--category', 'spec', '--text', 'Формат?', '--default', 'YAML'], dir).stdout, /Q1 зарегистрирован/);
  assert.match(cli(['question', 'list'], dir).stdout, /Q1 \[spec\] open: Формат\?/);
  assert.match(cli(['metric', 'add', '--key', 'tasks_done', '--value', '2'], dir).stdout, /записана/);
  assert.match(cli(['context'], dir).stdout, /Q1 \[spec\]/);
  assert.match(cli(['doctor'], dir).stdout, /конфигурация валидна/);
  assert.match(cli(['run', '--mode', 'day', '--dry-run'], dir).stdout, /dry-run/);
  assert.match(cli(['summary'], dir).stdout, /сводка/);
  assert.equal(cli(['approval', 'request', 'nope'], dir).status, 1);
});
