import test from 'node:test';
import assert from 'node:assert/strict';
import { paths } from '../src/state.js';
import { loadQuestions, saveQuestions, addQuestion, answerQuestion, expireQuestions, openQuestions } from '../src/questions.js';
import { cfg, bareProject } from './helpers.js';

test('вопрос без ответа по умолчанию допустим только в категории без авто-ответа (prod)', () => {
  const data = { questions: [] };
  assert.throws(() => addQuestion(data, { category: 'spec', text: 'Формат?' }, cfg), /ответ по умолчанию/);
  assert.equal(addQuestion(data, { category: 'prod', text: 'Ставить на сервер?' }, cfg).id, 'Q1');
});
test('add/answer/expire', () => {
  const p = paths(bareProject());
  const data = loadQuestions(p);
  const now = new Date(2026, 8, 29, 1, 0);
  const q1 = addQuestion(data, { category: 'spec', text: 'Какой формат?', defaultAnswer: 'YAML', now }, cfg);
  const q2 = addQuestion(data, { category: 'prod', text: 'Ставить на сервер?', defaultAnswer: 'нет', now }, cfg);
  assert.equal(q1.id, 'Q1'); assert.equal(q2.id, 'Q2');
  saveQuestions(p, data);
  const again = loadQuestions(p);
  assert.equal(openQuestions(again).length, 2);
  assert.equal(answerQuestion(again, 'q1', 'JSON', 'human', now).status, 'answered');
  const later = new Date(now.getTime() + 25 * 3600_000);
  assert.deepEqual(expireQuestions(again, cfg, later).map((q) => q.id), []);
  const q3 = addQuestion(again, { category: 'deps', text: 'Брать библиотеку?', defaultAnswer: 'да', now }, cfg);
  assert.equal(q3.id, 'Q3');
  assert.deepEqual(expireQuestions(again, cfg, later).map((q) => q.id), ['Q3']);
  assert.equal(again.questions[2].answer, 'да');
  assert.throws(() => addQuestion(again, { category: 'nope', text: 'x' }, cfg), /категория/);
});
