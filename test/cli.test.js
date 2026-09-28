import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { tmpDir } from './helpers.js';
import { MCFLY_ROOT } from '../src/prompt.js';

const bin = path.join(MCFLY_ROOT, 'bin', 'mcfly');
const cli = (args, cwd) => spawnSync(process.execPath, [bin, ...args], { cwd, encoding: 'utf8', env: { ...process.env, MCFLY_PROJECT_DIR: '' } });

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
