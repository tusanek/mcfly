import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { renderTemplate, buildLeadPrompt, MCFLY_ROOT } from '../src/prompt.js';
import { paths } from '../src/state.js';
import { cfg, bareProject } from './helpers.js';
import { exists } from '../src/util.js';

test('renderTemplate подставляет и очищает неизвестные', () => {
  assert.equal(renderTemplate('a {{X}} {{Y}}', { X: 1 }), 'a 1 ');
});
test('buildLeadPrompt содержит id, дедлайн и контекст', () => {
  const p = paths(bareProject());
  const text = buildLeadPrompt({ cfg, p, runId: '20260929-0000', mode: 'night', deadline: new Date(2026, 8, 29, 3, 0), context: 'КОНТЕКСТ-МАРКЕР' });
  assert.match(text, /20260929-0000/); assert.match(text, /2026-09-29 03:00/); assert.match(text, /КОНТЕКСТ-МАРКЕР/); assert.match(text, /mcfly\/runs\/20260929-0000/);
  assert.ok(!/\{\{\w+\}\}/.test(text), 'все плейсхолдеры подставлены');
});
test('шаблоны на месте', () => {
  for (const f of ['config.yaml', 'progress.md', 'answers.md', 'env.example', 'settings.json', 'CLAUDE.snippet.md', 'mcp.tracker.json']) assert.ok(exists(path.join(MCFLY_ROOT, 'templates', f)), f);
});

test('0.7.0: buildLeadPrompt с ideas — шаг «Предложения», план только по взятым', () => {
  const p = paths(bareProject());
  const c = { ...cfg, ideas: { ...cfg.ideas, backlog: 'SHARED-UNDERSTANDING.md §4.1' } };
  const text = buildLeadPrompt({ cfg: c, p, runId: 'r', mode: 'day', deadline: new Date(), context: '' });
  for (const s of ['mcfly ideas add', 'mcfly approval request <имя> --category spec --idea <Iн>', '## Простыми словами', 'новые изменения сами не планируй', 'с `mcfly.idea` не перерабатывай',
    'до 2 новых пунктов', 'до 4 пунктов', '10 %', '25 %', 'меньше 20 минут', 'не меньше 30 минут', 'SHARED-UNDERSTANDING.md §4.1', 'вне потолка']) assert.ok(text.includes(s), s);
  assert.ok(!/\{\{\w+\}\}/.test(text), 'все плейсхолдеры подставлены');
});
test('0.7.0: buildLeadPrompt с ideas.enabled false — прежний шаг 2b, без шага «Предложения»', () => {
  const p = paths(bareProject());
  const text = buildLeadPrompt({ cfg: { ...cfg, ideas: { ...cfg.ideas, enabled: false } }, p, runId: 'r', mode: 'day', deadline: new Date(), context: '' });
  assert.ok(text.includes('b. Нет → планирование: субагент mcfly:planner'));
  assert.ok(!text.includes('mcfly ideas add'));
  assert.ok(!/\{\{\w+\}\}/.test(text));
});
