import test from 'node:test';
import assert from 'node:assert/strict';
import { parseConfig, DEFAULT_CONFIG, autoDefault } from '../src/config.js';
import { paths } from '../src/state.js';

test('пустой конфиг даёт дефолты', () => {
  const cfg = parseConfig('');
  assert.deepEqual(cfg.schedule.slots, ['00:00', '04:00']);
  assert.equal(cfg.run.permission_mode, 'auto');
  assert.equal(cfg.escalation.categories.prod.auto_default, false);
});
test('частичный конфиг сливается с дефолтами', () => {
  const cfg = parseConfig('project: demo\nschedule:\n  slots: ["01:00"]\nrun:\n  max_minutes: 60\n');
  assert.equal(cfg.project, 'demo');
  assert.deepEqual(cfg.schedule.slots, ['01:00']);
  assert.equal(cfg.schedule.tolerance_minutes, DEFAULT_CONFIG.schedule.tolerance_minutes);
  assert.equal(cfg.run.max_minutes, 60);
});
test('валидация ловит ошибки', () => {
  assert.throws(() => parseConfig('schedule:\n  slots: ["1:00"]\n'), /слот/);
  assert.throws(() => parseConfig('run:\n  permission_mode: yolo\n'), /permission_mode/);
});
test('paths строит пути состояния', () => {
  const p = paths('/tmp/proj');
  assert.equal(p.config, '/tmp/proj/mcfly/config.yaml');
  assert.equal(p.openspecChanges, '/tmp/proj/openspec/changes');
});
test('autoDefault: неизвестная категория и унаследованные ключи объекта сами не решают', () => {
  const cfg = parseConfig('');
  assert.equal(autoDefault(cfg, 'spec'), true); assert.equal(autoDefault(cfg, 'prod'), false);
  assert.equal(autoDefault(cfg, 'production'), false); assert.equal(autoDefault(cfg, 'toString'), false);
});
