import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs'; import path from 'node:path';
import { paths } from '../src/state.js';
import { listChanges, requestApproval, setApproval, expireApprovals, pendingApprovals, approvedWithWork, proposalExcerpt } from '../src/approvals.js';
import { cfg, bareProject, addChange } from './helpers.js';

test('listChanges читает задачи и метаданные, пропускает archive', () => {
  const dir = bareProject(); const p = paths(dir);
  addChange(dir, 'add-a'); addChange(dir, 'add-b', { tasks: '- [x] всё\n' });
  fs.mkdirSync(path.join(dir, 'openspec', 'changes', 'archive', '2026-01-01-old'), { recursive: true });
  const list = listChanges(p.openspecChanges).map((c) => [c.name, c.tasksDone, c.tasksOpen]);
  assert.deepEqual(list, [['add-a', 1, 1], ['add-b', 1, 0]]);
  assert.equal(listChanges('/nonexistent').length, 0);
});
test('request/set/expire', () => {
  const dir = bareProject(); const p = paths(dir);
  addChange(dir, 'add-a'); addChange(dir, 'deploy-x'); addChange(dir, 'add-c');
  const now = new Date(2026, 8, 29, 1, 0);
  const [a, c, d] = listChanges(p.openspecChanges);
  requestApproval(a, { category: 'spec', now }); requestApproval(d, { category: 'prod', now }); requestApproval(c, { category: 'spec', now });
  let changes = listChanges(p.openspecChanges);
  assert.equal(pendingApprovals(changes).length, 3);
  setApproval(changes[0], 'approved', 'human', 'ок', now);
  changes = listChanges(p.openspecChanges);
  assert.deepEqual(approvedWithWork(changes).map((x) => x.name), ['add-a']);
  const later = new Date(now.getTime() + 25 * 3600_000);
  assert.deepEqual(expireApprovals(changes, cfg, later).map((x) => x.name), ['add-c']);
  changes = listChanges(p.openspecChanges);
  assert.equal(changes.find((x) => x.name === 'deploy-x').mcfly.approval, 'pending');
  assert.equal(changes.find((x) => x.name === 'add-c').mcfly.by, 'default');
  assert.equal(changes[0].meta.schema, 'spec-driven');
  assert.equal(proposalExcerpt(changes[0]), 'Зачем: тест.');
});
test('изменение с неизвестной категорией не одобряется молчанием', () => {
  const dir = bareProject(); const p = paths(dir);
  addChange(dir, 'deploy-y');
  const now = new Date(2026, 8, 29, 1, 0);
  requestApproval(listChanges(p.openspecChanges)[0], { category: 'production', now });
  assert.deepEqual(expireApprovals(listChanges(p.openspecChanges), cfg, new Date(now.getTime() + 25 * 3600_000)), []);
});
test('приоритет задаёт порядок списка', () => {
  const dir = bareProject(); const p = paths(dir);
  addChange(dir, 'a-late'); addChange(dir, 'b-first');
  const [a, b] = listChanges(p.openspecChanges);
  setApproval(a, 'approved', 'h', '', new Date(), { priority: 5 }); setApproval(b, 'approved', 'h', '', new Date(), { priority: 1 });
  assert.deepEqual(listChanges(p.openspecChanges).map((x) => x.name), ['b-first', 'a-late']);
});

test('0.5.3: proposalExcerpt пропускает заголовки markdown и пустые строки, берёт первый абзац', () => {
  const change = { proposal: '# Proposal: слить «Репорт УПД»\n\n## Why\n\nИмпорт прошлой документации\nсоздал вторую страницу.\n\nВторой абзац.\n' };
  assert.equal(proposalExcerpt(change), 'Импорт прошлой документации создал вторую страницу.');
  assert.equal(proposalExcerpt({ proposal: '## Зачем\n\n' + 'а'.repeat(300) }, 160).length, 160);
  assert.equal(proposalExcerpt({ proposal: '# Только заголовок\n' }), '');
});
