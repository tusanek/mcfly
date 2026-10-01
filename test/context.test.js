import test from 'node:test';
import assert from 'node:assert/strict';
import { paths } from '../src/state.js';
import { buildContext } from '../src/context.js';
import { loadQuestions, addQuestion, saveQuestions } from '../src/questions.js';
import { listChanges, requestApproval, setApproval } from '../src/approvals.js';
import fs from 'node:fs'; import path from 'node:path';
import { cfg, bareProject, addChange, tmpDir, git, gitRepo, changeBranch } from './helpers.js';

test('buildContext: прогресс невлитого изменения по ветке, worktree команды и чужие worktree', () => {
  const dir = bareProject(); const p = paths(dir);
  addChange(dir, 'ddm', { tasks: '- [ ] 1.1\n- [ ] 1.2\n- [ ] 2.1\n' });
  const [c] = listChanges(p.openspecChanges); requestApproval(c); setApproval(c, 'approved', 'human');
  gitRepo(dir); git(dir, 'add', '.'); git(dir, 'commit', '-q', '-m', 'проект');
  changeBranch(dir, 'ddm', '- [x] 1.1\n- [x] 1.2\n- [ ] 2.1\n');
  const wt = path.join(tmpDir(), 'ddm'); git(dir, 'worktree', 'add', '-q', wt, 'change/ddm');
  fs.writeFileSync(path.join(wt, 'SiteBuilder.java'), 'class SiteBuilder {}'); git(wt, 'add', '.');
  const session = path.join(tmpDir(), 'session'); git(dir, 'worktree', 'add', '-q', '-b', 'claude/s', session);
  const text = buildContext(p, cfg);
  assert.match(text, /- ddm \(приоритет 100\): 0 сделано \/ 3 открыто; на ветке change\/ddm: 2 сделано \/ 1 открыто/);
  assert.ok(text.includes(`Worktree команды (1):\n- ${fs.realpathSync(wt)}: ветка change/ddm, незакоммиченных файлов 1`), text);
  assert.ok(text.includes(`Прочие worktree (не команды — не трогать): ${fs.realpathSync(session)} (claude/s)`), text);
});
test('buildContext: prod-вопрос без ответа по умолчанию — ждать человека', () => {
  const p = paths(bareProject());
  const data = loadQuestions(p); addQuestion(data, { category: 'prod', text: 'Ставить на сервер?' }, cfg); saveQuestions(p, data);
  assert.match(buildContext(p, cfg), /- Q1 \[prod\] Ставить на сервер\? — без ответа по умолчанию: не выполнять, ждать решения человека\n/);
});
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

import { writeShift } from '../src/shift-files.js';
test('buildContext: действующая передача — первым блоком; нарушенный формат помечен; длинная обрезана', () => {
  const dir = bareProject(); const p = paths(dir);
  writeShift(p, 'day', '# Смена: день → ночь\nтолько шапка', new Date(2026, 9, 1, 18, 30));
  const ctx = buildContext(p, cfg);
  assert.match(ctx, /^## Передача смены \(mcfly\/shifts\/20261001-1830-day\.md\) — действуй по ней в рамках одобренного/);
  assert.match(ctx, /формат нарушен: нет разделов ## Изменения/);
  writeShift(p, 'day', '# Смена:\n## Изменения\n## Порядок\n## Нужны решения человека\n## Заметки\n' + 'x'.repeat(10000), new Date(2026, 9, 1, 19, 0));
  const long = buildContext(p, cfg);
  assert.match(long, /…передача обрезана, полный текст — в файле/);
  assert.ok(long.length < 10000);
});
test('buildContext: без действующей передачи — строка об этом', () => {
  assert.match(buildContext(paths(bareProject()), cfg), /^## Передача смены: нет — работай по приоритетам одобрений/);
});
