import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { paths } from './state.js';
import { currentRun } from './runner.js';
import { dirtyFiles, teamWorktrees } from './git.js';
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

export function shiftMerge({ sessionDir }) {
  const g = guard(sessionDir); if (g.error) return fail(g.error);
  const branch = out(g.session, ['branch', '--show-current']) || '';
  const change = /^shift\/(.+)-\d{8}-\d{4}$/.exec(branch)?.[1];
  if (!change) return fail(`текущая ветка ${branch || '(нет)'} — не ветка shift/<изменение>-…: начните смену командой mcfly shift start`);
  if (dirtyFiles(g.session).length) return fail('в worktree сессии есть незакоммиченные изменения — закоммитьте их (красный тест — коммитом wip)');
  const target = `change/${change}`;
  const team = teamWorktrees(g.main).find((w) => w.branch === target);
  if (team && team.dirty) return fail(`в worktree команды ${team.path} есть незакоммиченные изменения — спросите владельца`);
  // change ушла вперёд — сначала она в сессию; конфликт — отмена и отказ.
  if (!ok(g.session, ['merge-base', '--is-ancestor', target, 'HEAD'])) {
    if (!ok(g.session, ['merge', '-q', '--no-edit', target])) { run(g.session, ['merge', '--abort']); return fail(`конфликт при слиянии ${target} в ${branch} — слияние отменено, нужен человек`); }
  }
  const ahead = Number(out(g.session, ['rev-list', '--count', `${target}..HEAD`]) || '0');
  if (ahead > 0) {
    const r = team ? run(team.path, ['merge', '-q', '--ff-only', branch]) : run(g.main, ['fetch', '-q', '.', `${branch}:${target}`]);
    if (r.status !== 0) return fail(`fast-forward ${target} не удался: ${String(r.stderr).trim().slice(0, 200)}`);
  }
  run(g.session, ['switch', '-q', '--detach', target]);
  run(g.session, ['branch', '-q', '-D', branch]); // коммиты уже в change/<имя> (или их не было)
  return { ok: true, change, merged: ahead > 0, message: ahead > 0 ? `влито в ${target}: коммитов ${ahead}` : `нечего вливать: в ${branch} нет новых коммитов` };
}
