import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { countTasks } from './approvals.js';

/** stdout git или null, если команда не удалась (не репозиторий, нет ветки и т. п.). */
function git(dir, args) {
  const r = spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
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
