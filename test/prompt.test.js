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
