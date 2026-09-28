import test from 'node:test';
import assert from 'node:assert/strict';
import { paths } from '../src/state.js';
import { parseMessage, applyMessages } from '../src/answers.js';
import { loadQuestions, addQuestion, saveQuestions } from '../src/questions.js';
import { listChanges, requestApproval } from '../src/approvals.js';
import { readText } from '../src/util.js';
import { cfg, bareProject, addChange } from './helpers.js';

test('parseMessage: ответы на вопросы', () => {
  assert.deepEqual(parseMessage('Q3: b'), { type: 'answer', id: 'Q3', text: 'b' });
  assert.deepEqual(parseMessage('#q12 свой текст'), { type: 'answer', id: 'Q12', text: 'свой текст' });
  assert.deepEqual(parseMessage('Q7 — да, делаем'), { type: 'answer', id: 'Q7', text: 'да, делаем' });
});
test('parseMessage: одобрения, запуск, заметки', () => {
  assert.deepEqual(parseMessage('approve add-cache'), { type: 'approve', change: 'add-cache', note: '' });
  assert.deepEqual(parseMessage('одобряю add-cache но без кеша'), { type: 'approve', change: 'add-cache', note: 'но без кеша' });
  assert.deepEqual(parseMessage('reject add-cache слишком сложно'), { type: 'reject', change: 'add-cache', note: 'слишком сложно' });
  assert.equal(parseMessage('запусти').type, 'run');
  assert.equal(parseMessage('/start').type, 'ignore');
  assert.deepEqual(parseMessage('подумай про кеш'), { type: 'note', text: 'подумай про кеш' });
});
test('applyMessages меняет состояние и возвращает подтверждения', () => {
  const dir = bareProject(); const p = paths(dir);
  const now = new Date(2026, 8, 29, 9, 0);
  const data = loadQuestions(p); addQuestion(data, { category: 'spec', text: 'Формат?', defaultAnswer: 'YAML', now }, cfg); saveQuestions(p, data);
  addChange(dir, 'add-x'); requestApproval(listChanges(p.openspecChanges)[0], { now });
  const acks = applyMessages(p, [{ text: 'Q1: JSON' }, { text: 'approve add-x' }, { text: 'reject nope' }, { text: 'заметка' }], { now });
  assert.equal(loadQuestions(p).questions[0].answer, 'JSON');
  assert.equal(listChanges(p.openspecChanges)[0].mcfly.approval, 'approved');
  assert.match(acks[0], /Q1/); assert.match(acks[1], /одобрено/); assert.match(acks[2], /не найдено/); assert.match(acks[3], /заметку/);
  assert.match(readText(p.answers), /ответ на Q1\nJSON/);
});
