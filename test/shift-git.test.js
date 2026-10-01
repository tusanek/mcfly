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
