import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { countTasks } from './approvals.js';

/** stdout git или null, если команда не удалась (не репозиторий, нет ветки и т. п.). */
function git(dir, args) {
  const r = spawnSync('git', args, { cwd: dir, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }); // тысячи файлов вне .gitignore не должны давать «чисто»
  return r.status === 0 ? r.stdout : null;
}

/** Пути с незакоммиченными изменениями (git status), кроме exclude — файлов или каталогов; не git — пустой список. */
export function dirtyFiles(dir, { exclude = [] } = {}) {
  const out = git(dir, ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
  if (!out) return [];
  const entries = out.split('\0'); const files = [];
  for (let i = 0; i < entries.length; i++) {
    if (!entries[i]) continue;
    files.push(entries[i].slice(3).replace(/\/$/, ''));
    if (/[RC]/.test(entries[i].slice(0, 2))) i++; // у переименования и копии следом идёт исходный путь
  }
  const bases = exclude.map((x) => x.replace(/\/$/, ''));
  return files.filter((f) => !bases.some((b) => f === b || f.startsWith(`${b}/`)));
}

/** Отслеживаемые файлы, изменённые относительно HEAD (в индексе или в рабочем дереве); новые и удалённые не входят. */
export function changedTrackedFiles(dir) {
  const out = git(dir, ['diff', 'HEAD', '--name-only', '--diff-filter=M', '-z']);
  return out ? out.split('\0').filter(Boolean) : [];
}

/**
 * Коммитит только указанные отслеживаемые пути (git commit --only): чужие изменения в индексе остаются как были.
 * Изменений в путях нет — { ok: true, committed: false }; неотслеживаемый путь или не git — { ok: false, error }.
 */
export function commitPaths(dir, paths, message) {
  const same = spawnSync('git', ['diff', '--quiet', 'HEAD', '--', ...paths], { cwd: dir, encoding: 'utf8' });
  const tracked = spawnSync('git', ['ls-files', '--error-unmatch', '--', ...paths], { cwd: dir, encoding: 'utf8' });
  if (same.status === 0 && tracked.status === 0) return { ok: true, committed: false };
  const r = spawnSync('git', ['commit', '-q', '--only', '-m', message, '--', ...paths], { cwd: dir, encoding: 'utf8' });
  return r.status === 0 ? { ok: true, committed: true } : { ok: false, error: String(r.stderr || r.stdout || '').trim().slice(0, 200) };
}

/** Ветки, на которых работает команда: изменения OpenSpec и worktree субагентов-разработчиков. */
const TEAM_BRANCH = /^(change\/|worktree-agent-)/;

/** Worktree репозитория, кроме projectDir: путь, ветка, принадлежит ли команде, число незакоммиченных файлов. */
export function teamWorktrees(projectDir) {
  const out = git(projectDir, ['worktree', 'list', '--porcelain']);
  if (!out) return [];
  const self = fs.realpathSync(projectDir);
  const list = [];
  for (const block of out.split('\n\n')) {
    const listed = /^worktree (.+)$/m.exec(block)?.[1];
    if (!listed || !fs.existsSync(listed)) continue;
    const wt = fs.realpathSync(listed);
    if (wt === self) continue;
    const branch = /^branch refs\/heads\/(.+)$/m.exec(block)?.[1] || '(detached)';
    list.push({ path: wt, branch, team: TEAM_BRANCH.test(branch), dirty: dirtyFiles(wt).length });
  }
  return list;
}

/** Задачи изменения в невлитой ветке change/<имя> ({done, open}) или null, если ветки нет. */
export function branchProgress(projectDir, name) {
  const tasks = git(projectDir, ['show', `change/${name}:openspec/changes/${name}/tasks.md`]);
  return tasks === null ? null : countTasks(tasks);
}

/** Дневная работа: ветки shift/<изменение>-…, коммиты сверх change/<изменение> и незакоммиченное в их worktree. */
export function shiftBranches(projectDir) {
  const out = git(projectDir, ['branch', '--list', 'shift/*', '--format=%(refname:short)']);
  if (!out) return [];
  const wts = teamWorktrees(projectDir);
  return out.split('\n').filter(Boolean).map((branch) => {
    const change = /^shift\/(.+)-\d{8}-\d{4}$/.exec(branch)?.[1] || '';
    const ahead = Number((git(projectDir, ['rev-list', '--count', `change/${change}..${branch}`]) || '0').trim());
    const wt = wts.find((w) => w.branch === branch);
    return { branch, change, ahead, dirty: wt ? wt.dirty : 0 };
  });
}
/** Короткий sha ветки или null. */
export function branchSha(projectDir, branch) { return git(projectDir, ['rev-parse', '--short=7', branch])?.trim() || null; }
