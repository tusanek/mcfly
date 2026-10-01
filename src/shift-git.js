import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { paths } from './state.js';
import { currentRun } from './runner.js';
import { dirtyFiles } from './git.js';
import { shiftFileName } from './shift-files.js';

const run = (dir, args) => spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
const ok = (dir, args) => run(dir, args).status === 0;
const out = (dir, args) => { const r = run(dir, args); return r.status === 0 ? r.stdout.trim() : null; };
const fail = (error) => ({ ok: false, error });

/** Основное рабочее дерево репозитория (первая запись git worktree list). */
export function mainCheckout(dir) {
  const list = out(dir, ['worktree', 'list', '--porcelain']) || '';
  return fs.realpathSync(/^worktree (.+)$/m.exec(list)?.[1] || dir);
}
/** Общие проверки дневной команды: worktree сессии, не основное дерево, нет прогона. */
function guard(sessionDir) {
  const top = out(sessionDir, ['rev-parse', '--show-toplevel']);
  if (!top) return { error: 'это не git-репозиторий' };
  const session = fs.realpathSync(top); const main = mainCheckout(session);
  if (session === main) return { error: 'команда работает в worktree сессии, а не в основном рабочем дереве проекта' };
  const p = paths(main);
  if (currentRun(p)) return { error: 'идёт прогон команды (mcfly/.lock) — дождитесь его конца' };
  return { session, main, p };
}
export function shiftStart({ sessionDir, change, now = new Date() }) {
  const g = guard(sessionDir); if (g.error) return fail(g.error);
  if (dirtyFiles(g.session).length) return fail('в worktree сессии есть незакоммиченные изменения — закоммитьте их');
  if (!ok(g.main, ['rev-parse', '--verify', '-q', `refs/heads/change/${change}`]) && !ok(g.main, ['branch', `change/${change}`, 'main'])) {
    return fail(`не удалось создать ветку change/${change} от main`);
  }
  const branch = `shift/${change}-${shiftFileName('day', now).slice(0, 13)}`;
  const r = run(g.session, ['switch', '-q', '-c', branch, `change/${change}`]);
  return r.status === 0 ? { ok: true, branch } : fail(String(r.stderr).trim().slice(0, 200));
}
