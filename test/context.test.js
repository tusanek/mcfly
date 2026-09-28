import test from 'node:test';
import assert from 'node:assert/strict';
import { paths } from '../src/state.js';
import { buildContext } from '../src/context.js';
import { loadQuestions, addQuestion, saveQuestions } from '../src/questions.js';
import { listChanges, requestApproval, setApproval } from '../src/approvals.js';
import { cfg, bareProject, addChange } from './helpers.js';

test('buildContext перечисляет изменения, вопросы, ответы и журнал', () => {
  const dir = bareProject(); const p = paths(dir);
  addChange(dir, 'add-a'); addChange(dir, 'add-b');
  const [a, b] = listChanges(p.openspecChanges);
  requestApproval(a); setApproval(a, 'approved', 'human'); requestApproval(b);
  const data = loadQuestions(p); addQuestion(data, { category: 'deps', text: 'Брать yaml?', defaultAnswer: 'да' }, cfg); saveQuestions(p, data);
  const text = buildContext(p, cfg);
  assert.match(text, /Одобренные изменения с открытыми задачами \(1\):\n- add-a \(приоритет 100\): 1 сделано \/ 1 открыто/);
  assert.match(text, /Ожидают одобрения \(1\):\n- add-b/);
  assert.match(text, /Q1 \[deps\] Брать yaml\? — по умолчанию: да/);
  assert.match(text, /Журнал/);
});
