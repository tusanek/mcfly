import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs'; import path from 'node:path';
import { mainCheckout, shiftStart } from '../src/shift-git.js';
import { bareProject, gitRepo, git, changeBranch, tmpDir } from './helpers.js';

export function projectWithSession() {
  const dir = bareProject(); gitRepo(dir); git(dir, 'add', '.'); git(dir, 'commit', '-q', '-m', 'проект');
  changeBranch(dir, 'ddm', '- [ ] 1.1 a\n');
  const sess = path.join(tmpDir(), 'sess');
  git(dir, 'worktree', 'add', '-q', '-b', 'claude/sess', sess, 'main');
  return { dir, sess };
}
test('mainCheckout: из worktree сессии — основное дерево', () => {
  const { dir, sess } = projectWithSession();
  assert.equal(mainCheckout(sess), fs.realpathSync(dir));
});
test('shift start: ветка shift/<имя>-<время> от change/<имя> в worktree сессии', () => {
  const { dir, sess } = projectWithSession();
  const r = shiftStart({ sessionDir: sess, change: 'ddm', now: new Date(2026, 9, 1, 9, 30) });
  assert.deepEqual(r, { ok: true, branch: 'shift/ddm-20261001-0930' });
  assert.equal(git(sess, 'branch', '--show-current'), 'shift/ddm-20261001-0930');
  assert.equal(git(sess, 'rev-parse', 'HEAD'), git(dir, 'rev-parse', 'change/ddm'));
});
test('shift start: нет change/<имя> — ветка изменения создаётся от main', () => {
  const { dir, sess } = projectWithSession();
  fs.mkdirSync(path.join(dir, 'openspec', 'changes', 'new-x'), { recursive: true });
  const r = shiftStart({ sessionDir: sess, change: 'new-x', now: new Date(2026, 9, 1, 9, 30) });
  assert.equal(r.ok, true);
  assert.equal(git(dir, 'rev-parse', 'change/new-x'), git(dir, 'rev-parse', 'main'));
});
test('shift start отказывает: незакоммиченное в сессии, основное дерево, идёт прогон', () => {
  const { dir, sess } = projectWithSession();
  fs.writeFileSync(path.join(sess, 'x.txt'), 'x');
  assert.match(shiftStart({ sessionDir: sess, change: 'ddm', now: new Date() }).error, /незакоммиченн/);
  assert.match(shiftStart({ sessionDir: dir, change: 'ddm', now: new Date() }).error, /основном рабочем дереве/);
  fs.unlinkSync(path.join(sess, 'x.txt'));
  fs.writeFileSync(path.join(dir, 'mcfly', '.lock'), JSON.stringify({ pid: process.pid, at: new Date().toISOString(), id: 'r' }));
  assert.match(shiftStart({ sessionDir: sess, change: 'ddm', now: new Date() }).error, /идёт прогон/);
});

import { shiftMerge } from '../src/shift-git.js';
const commit = (dir, file, text) => { fs.writeFileSync(path.join(dir, file), text); git(dir, 'add', file); git(dir, 'commit', '-q', '-m', `feat(ddm): ${file}`); };

test('shift merge: fast-forward ветки изменения без worktree команды, ветка shift удалена', () => {
  const { dir, sess } = projectWithSession();
  shiftStart({ sessionDir: sess, change: 'ddm', now: new Date(2026, 9, 1, 9, 30) });
  commit(sess, 'a.txt', 'a');
  const head = git(sess, 'rev-parse', 'HEAD');
  const r = shiftMerge({ sessionDir: sess });
  assert.equal(r.ok, true); assert.equal(r.merged, true);
  assert.equal(git(dir, 'rev-parse', 'change/ddm'), head);
  assert.equal(git(dir, 'branch', '--list', 'shift/*'), '');
});
test('shift merge: ветка изменения выведена в worktree команды — fast-forward там', () => {
  const { dir, sess } = projectWithSession();
  const team = path.join(tmpDir(), 'team'); git(dir, 'worktree', 'add', '-q', team, 'change/ddm');
  shiftStart({ sessionDir: sess, change: 'ddm', now: new Date(2026, 9, 1, 9, 30) });
  commit(sess, 'a.txt', 'a');
  assert.equal(shiftMerge({ sessionDir: sess }).ok, true);
  assert.equal(git(team, 'rev-parse', 'HEAD'), git(dir, 'rev-parse', 'change/ddm'));
  assert.ok(fs.existsSync(path.join(team, 'a.txt')));
});
test('shift merge: change ушла вперёд — сначала влить её в сессию', () => {
  const { dir, sess } = projectWithSession();
  shiftStart({ sessionDir: sess, change: 'ddm', now: new Date(2026, 9, 1, 9, 30) });
  commit(sess, 'a.txt', 'a');
  const team = path.join(tmpDir(), 'team'); git(dir, 'worktree', 'add', '-q', team, 'change/ddm'); commit(team, 'b.txt', 'b');
  assert.equal(shiftMerge({ sessionDir: sess }).ok, true);
  assert.ok(fs.existsSync(path.join(team, 'a.txt')) && fs.existsSync(path.join(team, 'b.txt')));
});
test('shift merge: нечего вливать — сообщение, без ошибки', () => {
  const { sess } = projectWithSession();
  shiftStart({ sessionDir: sess, change: 'ddm', now: new Date(2026, 9, 1, 9, 30) });
  const r = shiftMerge({ sessionDir: sess });
  assert.equal(r.ok, true); assert.equal(r.merged, false); assert.match(r.message, /нечего вливать/);
});
test('shift merge отказывает: конфликт (merge отменён), грязный worktree команды, не ветка shift/', () => {
  const { dir, sess } = projectWithSession();
  shiftStart({ sessionDir: sess, change: 'ddm', now: new Date(2026, 9, 1, 9, 30) });
  commit(sess, 'a.txt', 'день');
  const team = path.join(tmpDir(), 'team'); git(dir, 'worktree', 'add', '-q', team, 'change/ddm'); commit(team, 'a.txt', 'ночь');
  const c = shiftMerge({ sessionDir: sess });
  assert.equal(c.ok, false); assert.match(c.error, /конфликт/);
  assert.equal(git(sess, 'status', '--porcelain'), '', 'merge отменён');
  fs.writeFileSync(path.join(team, 'dirty.txt'), 'x');
  assert.match(shiftMerge({ sessionDir: sess }).error, /незакоммиченн/);
  git(sess, 'switch', '-q', 'claude/sess');
  assert.match(shiftMerge({ sessionDir: sess }).error, /ветк[аи] shift\//);
});

import { shiftWrite, handoffLine } from '../src/shift-git.js';
import { HANDOFF } from './helpers.js';
import { addChange } from './helpers.js';
import { listChanges, requestApproval, setApproval } from '../src/approvals.js';
import { paths } from '../src/state.js';

test('shift write: файл в mcfly/shifts закоммичен один, строка в журнале и в Telegram', async () => {
  const { dir } = projectWithSession();
  addChange(dir, 'llm-adaptation'); const [c] = listChanges(paths(dir).openspecChanges); requestApproval(c); setApproval(c, 'approved', 'human');
  git(dir, 'add', '.'); git(dir, 'commit', '-q', '-m', 'изменение');
  fs.writeFileSync(path.join(dir, 'other.txt'), 'не коммитить'); git(dir, 'add', 'other.txt');
  const notes = [];
  const r = await shiftWrite({ projectDir: dir, text: HANDOFF, now: new Date(2026, 9, 1, 18, 30), notify: async (t) => notes.push(t) });
  assert.equal(r.ok, true);
  assert.deepEqual(r.warnings, ['page-map-seed: не одобрено или не найдено — ночь его не тронет']);
  assert.deepEqual(git(dir, 'show', '--name-only', '--format=', 'HEAD').split('\n').sort(), ['mcfly/progress.md', 'mcfly/shifts/20261001-1830-day.md']);
  assert.match(git(dir, 'status', '--porcelain'), /^A {2}other\.txt$/m, 'чужой индекс не тронут');
  assert.match(fs.readFileSync(path.join(dir, 'mcfly', 'progress.md'), 'utf8'), /2026-10-01 18:30 смена сдана: llm-adaptation → page-map-seed/);
  assert.deepEqual(notes, ['🌙 Смена сдана 18:30: ночью llm-adaptation; решений не ждёт; не одобрено — ночь не тронет: page-map-seed']);
});
test('shift write: без обязательных заголовков не пишет и называет недостающее', async () => {
  const { dir } = projectWithSession();
  const r = await shiftWrite({ projectDir: dir, text: '# Смена: x\n', now: new Date(), notify: async () => {} });
  assert.equal(r.ok, false); assert.match(r.error, /## Изменения/);
  assert.equal(fs.existsSync(path.join(dir, 'mcfly', 'shifts')), false);
});
test('handoffLine: решения нужны — число пунктов', () => {
  const t = HANDOFF.replace('## Нужны решения человека\n- нет', '## Нужны решения человека\n- одобрить X\n- ответить на Q2');
  assert.equal(handoffLine(t, new Date(2026, 9, 1, 18, 30)), '🌙 Смена сдана 18:30: ночью llm-adaptation → page-map-seed; ждёт ваших решений: 2');
});

test('shift start: без имени и с неизвестным изменением — отказ, мусорных веток нет', () => {
  const { dir, sess } = projectWithSession();
  assert.match(shiftStart({ sessionDir: sess, change: undefined, now: new Date() }).error, /укажите изменение/);
  assert.match(shiftStart({ sessionDir: sess, change: 'dmm', now: new Date() }).error, /изменение dmm не найдено/);
  assert.equal(git(dir, 'branch', '--list', 'change/dmm', 'change/undefined', 'shift/*'), '');
});

test('0.5.1: shift start из worktree команды (change/*, worktree-agent-*) — отказ', () => {
  const { dir } = projectWithSession();
  const team = path.join(tmpDir(), 'team'); git(dir, 'worktree', 'add', '-q', team, 'change/ddm');
  assert.match(shiftStart({ sessionDir: team, change: 'ddm', now: new Date() }).error, /worktree команды/);
});
test('0.5.1: shift merge — ветки изменения нет: понятное сообщение, не «конфликт»', () => {
  const { dir, sess } = projectWithSession();
  shiftStart({ sessionDir: sess, change: 'ddm', now: new Date(2026, 9, 1, 9, 30) });
  commit(sess, 'a.txt', 'a');
  git(dir, 'branch', '-D', 'change/ddm');
  const r = shiftMerge({ sessionDir: sess });
  assert.equal(r.ok, false); assert.match(r.error, /ветки change\/ddm нет/); assert.doesNotMatch(r.error, /конфликт/);
});
test('0.5.1: shift merge во время прогона — отказ', () => {
  const { dir, sess } = projectWithSession();
  shiftStart({ sessionDir: sess, change: 'ddm', now: new Date(2026, 9, 1, 9, 30) });
  fs.writeFileSync(path.join(dir, 'mcfly', '.lock'), JSON.stringify({ pid: process.pid, at: new Date().toISOString(), id: 'r' }));
  assert.match(shiftMerge({ sessionDir: sess }).error, /идёт прогон/);
});
test('0.5.1: строка Telegram не обещает неодобренное', async () => {
  const { dir } = projectWithSession();
  addChange(dir, 'llm-adaptation'); const [c] = listChanges(paths(dir).openspecChanges); requestApproval(c); setApproval(c, 'approved', 'human');
  git(dir, 'add', '.'); git(dir, 'commit', '-q', '-m', 'изменение');
  const notes = [];
  await shiftWrite({ projectDir: dir, text: HANDOFF, now: new Date(2026, 9, 1, 18, 30), notify: async (t) => notes.push(t) });
  assert.deepEqual(notes, ['🌙 Смена сдана 18:30: ночью llm-adaptation; решений не ждёт; не одобрено — ночь не тронет: page-map-seed']);
});
test('0.5.1: коммит передачи не удался — файл и строка журнала убраны', async () => {
  const { dir } = projectWithSession();
  fs.writeFileSync(path.join(dir, '.git', 'index.lock'), ''); // git commit упадёт
  const before = fs.readFileSync(path.join(dir, 'mcfly', 'progress.md'), 'utf8');
  const r = await shiftWrite({ projectDir: dir, text: HANDOFF, now: new Date(2026, 9, 1, 18, 30), notify: async () => {} });
  fs.unlinkSync(path.join(dir, '.git', 'index.lock'));
  assert.equal(r.ok, false); assert.match(r.error, /не закоммичен/);
  assert.equal(fs.existsSync(path.join(dir, 'mcfly', 'shifts', '20261001-1830-day.md')), false);
  assert.equal(fs.readFileSync(path.join(dir, 'mcfly', 'progress.md'), 'utf8'), before);
});
