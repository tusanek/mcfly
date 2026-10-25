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
  assert.deepEqual(parseMessage('/start'), { type: 'view', view: 'help' });
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

test('applyMessages: ответ «по умолчанию» берёт текст ответа по умолчанию', () => {
  const dir = bareProject(); const p = paths(dir);
  const data = loadQuestions(p); addQuestion(data, { category: 'spec', text: 'Формат?', defaultAnswer: 'YAML' }, cfg); saveQuestions(p, data);
  const acks = applyMessages(p, [{ text: 'Q1 по умолчанию' }]);
  assert.equal(loadQuestions(p).questions[0].answer, 'YAML');
  assert.match(acks[0], /Q1/);
});

import fs from 'node:fs';
import { loadIdeas, saveIdeas, addIdea, transitionIdea } from '../src/ideas.js';
const seedIdeas = (p, n = 1) => { const d = loadIdeas(p); for (let i = 1; i <= n; i++) addIdea(d, { title: `Идея ${i}`, benefit: 'польза', source: 'team', size: 'S' }); saveIdeas(p, d); return d; };

test('parseMessage: берём, не сейчас, идея', () => {
  assert.deepEqual(parseMessage('берём i7'), { type: 'take', id: 'I7' });
  assert.deepEqual(parseMessage('Беру I7'), { type: 'take', id: 'I7' });
  assert.deepEqual(parseMessage('Не сейчас I7 дорого'), { type: 'defer', id: 'I7', note: 'дорого' });
  assert.deepEqual(parseMessage('💡 Тёмная тема сайта'), { type: 'idea', text: 'Тёмная тема сайта' });
  assert.deepEqual(parseMessage('Идея: тёмная тема\nчтобы глаза не уставали'), { type: 'idea', text: 'тёмная тема\nчтобы глаза не уставали' });
  assert.deepEqual(parseMessage('идея:'), { type: 'idea', text: '' });
  assert.equal(parseMessage('берём').type, 'note');
  assert.equal(parseMessage('идеальный вариант — кеш').type, 'note');
});

test('applyMessages: берём и не сейчас меняют список и пишут answers.md', () => {
  const p = paths(bareProject()); seedIdeas(p, 2);
  const acks = applyMessages(p, [{ text: 'берём I1' }, { text: 'не сейчас I2 позже' }]);
  const ideas = loadIdeas(p).ideas;
  assert.equal(ideas[0].status, 'taken'); assert.equal(ideas[1].status, 'discuss'); assert.equal(ideas[1].discuss_note, 'позже');
  assert.equal(acks[0], '✅ I1 взято — план пришлёт ближайший прогон');
  assert.equal(acks[1], '⏸ I2 отложено — обсудим в сессии');
  assert.match(readText(p.answers), /— взято I1/); assert.match(readText(p.answers), /— не сейчас I2\nпозже/);
});

test('applyMessages: старая кнопка по спланированному пункту — «уже», файл прежний', () => {
  const p = paths(bareProject()); const d = seedIdeas(p, 1);
  transitionIdea(d, 'I1', 'taken', { actor: 'bot' }); transitionIdea(d, 'I1', 'planned', { actor: 'team', change: 'x' }); saveIdeas(p, d);
  const before = fs.readFileSync(p.ideas, 'utf8');
  const acks = applyMessages(p, [{ text: 'берём I1' }, { text: 'берём I5' }]);
  assert.equal(acks[0], 'ℹ️ I1 уже спланирован — план ждёт решения в «Статусе»'); assert.equal(acks[1], '⚠️ I5: такого предложения нет');
  assert.equal(fs.readFileSync(p.ideas, 'utf8'), before);
});

test('applyMessages: идея владельца и пустая идея', () => {
  const p = paths(bareProject()); seedIdeas(p, 1);
  const acks = applyMessages(p, [{ text: 'идея: Тёмная тема\nглаза не устают' }, { text: 'идея:' }]);
  const added = loadIdeas(p).ideas[1];
  assert.equal(acks[0], '💡 I2 записал в предложения');
  assert.deepEqual([added.title, added.benefit, added.source, added.status], ['Тёмная тема', 'глаза не устают', 'owner-note', 'proposed']);
  assert.equal(acks[1], '⚠️ Пустая идея — напишите текст после «идея:»');
  assert.equal(loadIdeas(p).ideas.length, 2);
});

test('applyMessages: испорченный ideas.yaml — остальные сообщения применены', () => {
  const p = paths(bareProject()); fs.writeFileSync(p.ideas, 'ideas: [oops\n');
  const acks = applyMessages(p, [{ text: 'берём I1' }, { text: 'просто заметка' }]);
  assert.match(acks[0], /^⚠️ mcfly\/ideas\.yaml.*список предложений не изменён$/);
  assert.match(acks[1], /заметку/);
  assert.equal(fs.readFileSync(p.ideas, 'utf8'), 'ideas: [oops\n');
});

test('ответ свайпом на отложенный пункт записывает причину', () => {
  const p = paths(bareProject()); seedIdeas(p, 1);
  applyMessages(p, [{ text: 'не сейчас I1' }]);
  const acks = applyMessages(p, [{ text: 'слишком дорого сейчас', replyTo: '⏸ I1 отложено — обсудим в сессии' }]);
  assert.equal(acks[0], '📝 I1: причина записана');
  assert.equal(loadIdeas(p).ideas[0].discuss_note, 'слишком дорого сейчас');
});

test('0.7.0: «Отклонить» плана по пункту — пункт на обсуждение; без mcfly.idea — как раньше', () => {
  const dir = bareProject(); const p = paths(dir);
  const d = seedIdeas(p, 1); transitionIdea(d, 'I1', 'taken', { actor: 'bot' }); transitionIdea(d, 'I1', 'planned', { actor: 'team', change: 'by-idea' }); saveIdeas(p, d);
  addChange(dir, 'by-idea'); addChange(dir, 'plain');
  const [a, b] = listChanges(p.openspecChanges);
  requestApproval(a, { idea: 'I1' }); requestApproval(b, {});
  const acks = applyMessages(p, [{ text: 'reject by-idea отклонено кнопкой в Telegram' }, { text: 'reject plain слишком сложно' }]);
  assert.equal(acks[0], '⏸ by-idea: не сейчас — пункт I1 ждёт обсуждения в сессии');
  assert.equal(acks[1], '⛔ отклонено: plain');
  const idea = loadIdeas(p).ideas[0];
  assert.equal(idea.status, 'discuss'); assert.equal(idea.discuss_note, 'план отклонён в Telegram: by-idea, отклонено кнопкой в Telegram');
  assert.deepEqual(listChanges(p.openspecChanges).map((c) => c.mcfly.approval), ['rejected', 'rejected']);
});
test('0.7.0: старые кнопки — понятное «уже …»; «Не сейчас» по спланированному не рвёт связь с планом', () => {
  const p = paths(bareProject()); const d = seedIdeas(p, 3);
  transitionIdea(d, 'I1', 'taken', { actor: 'bot' }); transitionIdea(d, 'I1', 'planned', { actor: 'team', change: 'ch-1' });
  transitionIdea(d, 'I2', 'rejected', { actor: 'session' }); transitionIdea(d, 'I3', 'discuss', { actor: 'bot' }); saveIdeas(p, d);
  const acks = applyMessages(p, [{ text: 'берём I1' }, { text: 'не сейчас I1' }, { text: 'берём I2' }, { text: 'берём I3' }]);
  assert.deepEqual(acks, [
    'ℹ️ I1 уже спланирован — план ждёт решения в «Статусе»',
    'ℹ️ I1 уже спланирован — «⏸ Не сейчас» под планом в «Статусе»',
    'ℹ️ I2 уже отклонён в сессии',
    'ℹ️ I3 уже отложен — обсудим в сессии',
  ]);
  assert.deepEqual(loadIdeas(p).ideas.map((x) => x.status), ['planned', 'rejected', 'discuss']);
});
