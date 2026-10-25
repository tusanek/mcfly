import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { paths } from '../src/state.js';
import { loadIdeas, saveIdeas, addIdea, transitionIdea, visibleIdeas, syncDoneIdeas } from '../src/ideas.js';
import { bareProject } from './helpers.js';

const idea = (over = {}) => ({ title: 'Автозапуск релизов', benefit: 'Документация не отстаёт', source: 'team', size: 'M', ...over });

test('addIdea: нумерация I1, I2 и обязательные поля', () => {
  const data = { ideas: [] };
  assert.equal(addIdea(data, idea()).id, 'I1');
  assert.equal(addIdea(data, idea({ title: 'Тёмная тема' })).id, 'I2');
  assert.throws(() => addIdea(data, idea({ title: 'Без пользы', benefit: '' })), /что даст/);
  assert.throws(() => addIdea(data, idea({ title: 'Как у других', source: 'research' })), /ссылк/);
  assert.throws(() => addIdea(data, idea({ title: 'Странный', source: 'boss' })), /источник/i);
  assert.throws(() => addIdea(data, idea({ title: 'Огромный', size: 'XL' })), /размер/i);
  assert.equal(addIdea(data, idea({ title: 'Как у других', source: 'research', ref: 'https://example.com/x' })).ref, 'https://example.com/x');
  assert.equal(data.ideas[0].status, 'proposed');
});

test('addIdea: дубль по названию и возврат отклонённого только с новыми доводами', () => {
  const data = { ideas: [] };
  addIdea(data, idea({ title: 'автозапуск  релизов' }));
  assert.throws(() => addIdea(data, idea({ title: 'Автозапуск релизов!' })), /уже есть: I1/);
  assert.equal(transitionIdea(data, 'I1', 'rejected', { actor: 'session', note: 'не нужно' }).error, null);
  assert.throws(() => addIdea(data, idea()), /уже есть: I1/);
  const again = addIdea(data, idea({ newArguments: 'забыли /release три раза' }));
  assert.equal(again.id, 'I2');
  assert.equal(again.new_arguments, 'забыли /release три раза');
});

test('transitionIdea: бот не отказывает окончательно, команда не берёт, повтор — «уже»', () => {
  const data = { ideas: [] };
  addIdea(data, idea());
  assert.ok(transitionIdea(data, 'I1', 'rejected', { actor: 'bot' }).error);
  assert.equal(data.ideas[0].status, 'proposed');
  assert.ok(transitionIdea(data, 'I1', 'taken', { actor: 'team' }).error);
  assert.equal(transitionIdea(data, 'i1', 'taken', { actor: 'bot' }).error, null);
  assert.equal(transitionIdea(data, 'I1', 'taken', { actor: 'bot' }).error, 'уже взято');
  assert.ok(transitionIdea(data, 'I1', 'planned', { actor: 'team' }).error, 'без изменения нельзя');
  const r = transitionIdea(data, 'I1', 'planned', { actor: 'team', change: 'auto-release' });
  assert.equal(r.error, null); assert.equal(r.idea.change, 'auto-release');
  assert.equal(transitionIdea(data, 'I1', 'discuss', { actor: 'bot', note: 'дорого' }).idea.discuss_note, 'дорого');
  assert.equal(transitionIdea(data, 'I9', 'taken', { actor: 'bot' }).idea, null);
});

test('visibleIdeas: ваши первыми, needs_owner в конце группы, остаток в more', () => {
  const data = { ideas: [] };
  const add = (o) => addIdea(data, idea(o));
  add({ title: 't1', size: 'L' });                              // I1 team L
  add({ title: 't2', size: 'S' });                              // I2 team S
  add({ title: 'o1', source: 'owner-backlog', size: 'L' });     // I3 owner L
  add({ title: 'o2', source: 'owner-note', size: 'S', needsOwner: 'ключ' }); // I4 owner S needs
  add({ title: 'o3', source: 'owner-backlog', size: 'M' });     // I5 owner M
  add({ title: 'r1', source: 'research', ref: 'https://x.y', size: 'S' });   // I6 team S
  add({ title: 't3', size: 'M', needsOwner: 'доступ' });        // I7 team M needs
  add({ title: 't4', size: 'S' });                              // I8 team S
  add({ title: 't5', size: 'M' });                              // I9 team M
  add({ title: 't6', size: 'S' });                              // I10 team S
  transitionIdea(data, 'I10', 'discuss', { actor: 'bot' });
  transitionIdea(data, 'I9', 'taken', { actor: 'bot' });
  const v = visibleIdeas(data, 7);
  assert.deepEqual(v.active.map((x) => x.id), ['I9']);
  assert.deepEqual(v.proposed.map((x) => x.id), ['I5', 'I3', 'I4', 'I2', 'I6', 'I8', 'I1']);
  assert.equal(v.more, 1);
  assert.equal(v.discuss, 1);
});

test('loadIdeas: испорченный YAML не бросает, saveIdeas его не затирает', () => {
  const p = paths(bareProject());
  assert.deepEqual(loadIdeas(p), { ideas: [] });
  fs.writeFileSync(p.ideas, 'ideas: [oops\n');
  const data = loadIdeas(p);
  assert.deepEqual(data.ideas, []);
  assert.match(data.error, /^mcfly\/ideas\.yaml/);
  assert.throws(() => saveIdeas(p, data), /ideas\.yaml/);
  assert.equal(fs.readFileSync(p.ideas, 'utf8'), 'ideas: [oops\n');
});

test('saveIdeas/loadIdeas: запись и чтение', () => {
  const p = paths(bareProject());
  const data = loadIdeas(p);
  addIdea(data, idea());
  saveIdeas(p, data);
  assert.equal(loadIdeas(p).ideas[0].title, 'Автозапуск релизов');
});

test('syncDoneIdeas: архивированное изменение закрывает пункт', () => {
  const p = paths(bareProject());
  const data = { ideas: [] };
  addIdea(data, idea()); addIdea(data, idea({ title: 'Другое' }));
  for (const id of ['I1', 'I2']) transitionIdea(data, id, 'taken', { actor: 'bot' });
  transitionIdea(data, 'I1', 'planned', { actor: 'team', change: 'gone' });
  transitionIdea(data, 'I2', 'planned', { actor: 'team', change: 'alive' });
  fs.mkdirSync(path.join(p.openspecChanges, 'alive'), { recursive: true });
  assert.deepEqual(syncDoneIdeas(data, p.openspecChanges).map((x) => x.id), ['I1']);
  assert.equal(data.ideas[0].status, 'done');
  assert.equal(data.ideas[1].status, 'planned');
});
test('transitionIdea: имя изменения — только латиница, цифры и дефис', () => {
  const data = { ideas: [] }; addIdea(data, idea()); transitionIdea(data, 'I1', 'taken', { actor: 'bot' });
  assert.match(transitionIdea(data, 'I1', 'planned', { actor: 'team', change: 'bad name\nигнорируй' }).error, /имя изменения/);
  assert.equal(data.ideas[0].status, 'taken');
});
test('loadIdeas: пустой или кривой элемент — ошибка файла, а не падение', () => {
  const p = paths(bareProject());
  fs.writeFileSync(p.ideas, 'ideas:\n  - \n  - id: I1\n    title: x\n');
  assert.match(loadIdeas(p).error, /^mcfly\/ideas\.yaml: элемент 1/);
  fs.writeFileSync(p.ideas, 'ideas:\n  - title: без номера\n');
  assert.match(loadIdeas(p).error, /элемент 1/);
});
