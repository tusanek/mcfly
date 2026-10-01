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
