import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs'; import path from 'node:path';
import { dirtyFiles, teamWorktrees, branchProgress, commitPaths } from '../src/git.js';
import { tmpDir, git, gitRepo, changeBranch } from './helpers.js';

test('dirtyFiles: изменённые и новые файлы, кроме исключённых путей', () => {
  const dir = gitRepo();
  fs.writeFileSync(path.join(dir, 'a.txt'), 'a'); git(dir, 'add', 'a.txt'); git(dir, 'commit', '-q', '-m', 'a');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'changed');
  fs.writeFileSync(path.join(dir, 'новый файл.txt'), 'x');
  fs.mkdirSync(path.join(dir, 'mcfly', 'runs', 'r1'), { recursive: true }); fs.writeFileSync(path.join(dir, 'mcfly', 'runs', 'r1', 'result.json'), '{}');
  fs.writeFileSync(path.join(dir, 'mcfly', 'metrics.jsonl'), '{}\n');
  assert.deepEqual(dirtyFiles(dir, { exclude: ['mcfly/runs/r1', 'mcfly/metrics.jsonl'] }).sort(), ['a.txt', 'новый файл.txt']);
});
test('dirtyFiles: вывод git status больше мегабайта не превращается в «чисто»', () => {
  const dir = gitRepo(); const many = path.join(dir, 'many'); fs.mkdirSync(many);
  const name = 'x'.repeat(120);
  for (let i = 0; i < 10_000; i++) fs.writeFileSync(path.join(many, `${name}-${i}.txt`), '');
  assert.equal(dirtyFiles(dir).length, 10_000);
});
test('dirtyFiles: не git-каталог — пустой список', () => {
  assert.deepEqual(dirtyFiles(tmpDir()), []);
});
test('teamWorktrees: worktree кроме основного — ветка, принадлежность команде, незакоммиченные файлы', () => {
  const dir = gitRepo(); const base = tmpDir();
  const ddm = path.join(base, 'ddm'); const session = path.join(base, 'session');
  git(dir, 'worktree', 'add', '-q', '-b', 'change/x', ddm);
  git(dir, 'worktree', 'add', '-q', '-b', 'claude/session', session);
  fs.writeFileSync(path.join(ddm, 'b.txt'), 'b'); git(ddm, 'add', 'b.txt');
  assert.deepEqual(teamWorktrees(dir), [
    { path: fs.realpathSync(ddm), branch: 'change/x', team: true, dirty: 1 },
    { path: fs.realpathSync(session), branch: 'claude/session', team: false, dirty: 0 },
  ]);
});
test('teamWorktrees: пропускает worktree, чей каталог удалён', () => {
  const dir = gitRepo(); const gone = path.join(tmpDir(), 'gone');
  git(dir, 'worktree', 'add', '-q', '-b', 'change/y', gone);
  fs.rmSync(gone, { recursive: true, force: true });
  assert.deepEqual(teamWorktrees(dir), []);
});
test('branchProgress: задачи изменения в ветке change/<имя>; нет ветки — null', () => {
  const dir = gitRepo();
  changeBranch(dir, 'x', '# Tasks\n- [x] 1.1 a\n- [x] 1.2 b\n- [ ] 2.1 c\n');
  assert.deepEqual(branchProgress(dir, 'x'), { done: 2, open: 1 });
  assert.equal(branchProgress(dir, 'нет-такой'), null);
});

test('commitPaths коммитит только указанный путь, чужой индекс не трогает', () => {
  const dir = gitRepo();
  fs.mkdirSync(path.join(dir, 'openspec/changes/x'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'openspec/changes/x/.openspec.yaml'), 'schema: spec-driven\n');
  fs.writeFileSync(path.join(dir, 'work.txt'), 'a');
  git(dir, 'add', '.'); git(dir, 'commit', '-q', '-m', 'base');
  fs.writeFileSync(path.join(dir, 'openspec/changes/x/.openspec.yaml'), 'schema: spec-driven\nmcfly:\n  approval: approved\n');
  fs.writeFileSync(path.join(dir, 'work.txt'), 'b'); git(dir, 'add', 'work.txt');
  const r = commitPaths(dir, ['openspec/changes/x/.openspec.yaml'], 'chore(x): одобрение человека — approved');
  assert.equal(r.ok, true);
  assert.equal(git(dir, 'log', '-1', '--format=%s'), 'chore(x): одобрение человека — approved');
  assert.match(git(dir, 'show', 'HEAD:openspec/changes/x/.openspec.yaml'), /approved/);
  assert.equal(git(dir, 'diff', '--cached', '--name-only'), 'work.txt');
});
test('commitPaths: неотслеживаемый путь или не git — ok false с причиной, без исключения', () => {
  const dir = gitRepo();
  fs.writeFileSync(path.join(dir, 'new.yaml'), 'x');
  const r = commitPaths(dir, ['new.yaml'], 'm');
  assert.equal(r.ok, false); assert.ok(r.error);
  assert.equal(commitPaths(tmpDir(), ['a'], 'm').ok, false);
});
