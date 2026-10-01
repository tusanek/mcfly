import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { paths } from './state.js';
import { currentRun } from './runner.js';
import { dirtyFiles, teamWorktrees, commitPaths } from './git.js';
import { listChanges } from './approvals.js';
import { appendText, fmtLocal, pad2, readText, writeText } from './util.js';
import { shiftFileName, validateHandoff, mentionedChanges, writeShift } from './shift-files.js';

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
  const current = out(session, ['branch', '--show-current']) || '';
  if (/^(change\/|worktree-agent-)/.test(current)) return { error: `это worktree команды (ветка ${current}) — дневная работа идёт в worktree сессии` };
  const p = paths(main);
  if (currentRun(p)) return { error: 'идёт прогон команды (mcfly/.lock) — дождитесь его конца' };
  return { session, main, p };
}
export function shiftStart({ sessionDir, change, now = new Date() }) {
  const g = guard(sessionDir); if (g.error) return fail(g.error);
  if (!change) return fail('укажите изменение: mcfly shift start <изменение>');
  if (dirtyFiles(g.session).length) return fail('в worktree сессии есть незакоммиченные изменения — закоммитьте их');
  const known = ok(g.main, ['rev-parse', '--verify', '-q', `refs/heads/change/${change}`]) || fs.existsSync(path.join(g.main, 'openspec', 'changes', change));
  if (!known) return fail(`изменение ${change} не найдено: нет ни ветки change/${change}, ни openspec/changes/${change}`);
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
  if (!ok(g.main, ['rev-parse', '--verify', '-q', `refs/heads/${target}`])) return fail(`ветки ${target} нет — изменение, видимо, уже влито ночью; влейте ${branch} в main вручную или спросите владельца`);
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

/** Порядок и число решений из текста передачи — для Telegram и журнала. */
function handoffFacts(text) {
  const order = []; const decisions = []; let sec = '';
  for (const line of String(text).split('\n')) {
    if (/^##\s/.test(line)) { sec = line.replace(/^##\s+/, '').trim(); continue; }
    const item = /^\s*\d+\.\s+([\w.-]+)/.exec(line);
    if ((sec === 'Порядок' || sec === 'Предложение на день') && item) order.push(item[1]);
    const d = /^\s*-\s+(.+)$/.exec(line);
    if (sec === 'Нужны решения человека' && d && !/^(нет|ничего)\.?$/i.test(d[1].trim())) decisions.push(d[1]);
  }
  return { order, decisions };
}
/** approved — имена одобренных изменений; без него весь порядок считается одобренным. */
export function handoffLine(text, now, approved = null) {
  const { order: all, decisions } = handoffFacts(text);
  const order = approved ? all.filter((n) => approved.has(n)) : all;
  const skipped = approved ? all.filter((n) => !approved.has(n)) : [];
  return `🌙 Смена сдана ${pad2(now.getHours())}:${pad2(now.getMinutes())}: ${order.length ? `ночью ${order.join(' → ')}` : 'одобренной работы на ночь нет'}; ${decisions.length ? `ждёт ваших решений: ${decisions.length}` : 'решений не ждёт'}${skipped.length ? `; не одобрено — ночь не тронет: ${skipped.join(', ')}` : ''}`;
}
export async function shiftWrite({ projectDir, text, kind = 'day', now = new Date(), notify = null }) {
  const main = mainCheckout(projectDir); const p = paths(main);
  if (currentRun(p)) return fail('идёт прогон команды (mcfly/.lock) — дождитесь его конца');
  const missing = validateHandoff(text);
  if (missing.length) return fail(`в передаче нет разделов: ${missing.join(', ')}`);
  const approved = new Set(listChanges(p.openspecChanges).filter((c) => c.mcfly.approval === 'approved').map((c) => c.name));
  const warnings = mentionedChanges(text).filter((n) => !approved.has(n)).map((n) => `${n}: не одобрено или не найдено — ночь его не тронет`);
  const progressBefore = readText(p.progress, null);
  const file = writeShift(p, kind, text, now);
  appendText(p.progress, `- ${fmtLocal(now)} смена сдана: ${handoffFacts(text).order.join(' → ') || 'работы на ночь нет'} (${path.basename(file)})\n`);
  const rel = (f) => path.relative(main, f);
  run(main, ['add', '--', rel(file)]); // новый файл должен стать отслеживаемым для commit --only
  const c = commitPaths(main, [rel(file), rel(p.progress)], `chore(mcfly): смена сдана — ${path.basename(file)}`);
  if (!c.ok) {
    // Откат: повтор не должен плодить -2 и вторую строку журнала.
    run(main, ['reset', '-q', '--', rel(file)]); try { fs.unlinkSync(file); } catch {}
    if (progressBefore !== null) writeText(p.progress, progressBefore);
    return fail(`передача не закоммичена (${c.error}) — файл не сохранён, повторите после исправления`);
  }
  if (notify) { try { await notify(handoffLine(text, now, approved)); } catch (e) { warnings.push(`Telegram: ${e.message}`); } }
  return { ok: true, path: file, warnings };
}
