import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { parseDotenv, loadEnv } from '../src/env.js';

test('parseDotenv: комментарии, кавычки, export', () => {
  assert.deepEqual(parseDotenv('# c\nA=1\nexport B="два"\nC=\'3\'\n\nD = x y\n'), { A: '1', B: 'два', C: '3', D: 'x y' });
});
test('loadEnv не перекрывает уже заданные переменные', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcfly-env-'));
  fs.mkdirSync(path.join(dir, 'mcfly')); fs.writeFileSync(path.join(dir, 'mcfly', '.env'), 'T1=file\nT2=file\n');
  const env = { T1: 'shell' };
  loadEnv(dir, env);
  assert.deepEqual(env, { T1: 'shell', T2: 'file' });
});
test('loadEnv: токен прогонов из файла перекрывает окружение', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcfly-env-'));
  fs.mkdirSync(path.join(dir, 'mcfly')); fs.writeFileSync(path.join(dir, 'mcfly', '.env'), 'CLAUDE_CODE_OAUTH_TOKEN=file\n');
  const env = { CLAUDE_CODE_OAUTH_TOKEN: 'shell' };
  loadEnv(dir, env);
  assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, 'file');
});
