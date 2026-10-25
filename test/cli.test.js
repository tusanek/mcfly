import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { tmpDir, addChange, git, gitRepo, changeBranch } from './helpers.js';
import { MCFLY_ROOT } from '../src/prompt.js';

const bin = path.join(MCFLY_ROOT, 'bin', 'mcfly');
const cli = (args, cwd) => spawnSync(process.execPath, [bin, ...args], { cwd, encoding: 'utf8', env: { ...process.env, MCFLY_PROJECT_DIR: '', MCFLY_RUN_ID: '' } });

test('status показывает прогресс невлитого изменения по ветке change/<имя>', () => {
  const dir = tmpDir();
  cli(['init', '--name', 'demo'], dir);
  addChange(dir, 'ddm', { tasks: '- [ ] a\n- [ ] b\n- [ ] c\n' });
  cli(['approval', 'set', 'ddm', 'approved'], dir);
  gitRepo(dir); git(dir, 'add', '.'); git(dir, 'commit', '-q', '-m', 'проект');
  changeBranch(dir, 'ddm', '- [x] a\n- [x] b\n- [ ] c\n');
  assert.match(cli(['status'], dir).stdout, /- ddm: одобрение=approved, задач 0\/3 \(на ветке change\/ddm: 2\/3\)/);
});

test('одобрение: агент в прогоне не ставит approval set, неизвестная категория запроса отклоняется', () => {
  const dir = tmpDir();
  cli(['init', '--name', 'demo'], dir);
  addChange(dir, 'deploy-x');
  const inRun = spawnSync(process.execPath, [bin, 'approval', 'set', 'deploy-x', 'approved'], { cwd: dir, encoding: 'utf8', env: { ...process.env, MCFLY_PROJECT_DIR: '', MCFLY_RUN_ID: '20260930-0000' } });
  assert.equal(inRun.status, 1); assert.match(inRun.stderr, /только человек/);
  assert.match(cli(['approval', 'list'], dir).stdout, /deploy-x: не запрошено/);
  const bad = cli(['approval', 'request', 'deploy-x', '--category', 'production'], dir);
  assert.equal(bad.status, 1); assert.match(bad.stderr, /категория/);
});
test('help, init, status, question, approval, metric, context, doctor, dry-run, summary', () => {
  const dir = tmpDir();
  assert.match(cli(['--help'], dir).stdout, /Команды:/);
  assert.equal(cli(['status'], dir).status, 1);
  assert.match(cli(['init', '--name', 'demo'], dir).stdout, /инициализирован/);
  assert.match(cli(['status'], dir).stdout, /Проект demo/);
  assert.match(cli(['question', 'add', '--category', 'spec', '--text', 'Формат?', '--default', 'YAML'], dir).stdout, /Q1 зарегистрирован/);
  assert.match(cli(['question', 'list'], dir).stdout, /Q1 \[spec\] open: Формат\?/);
  assert.match(cli(['metric', 'add', '--key', 'tasks_done', '--value', '2'], dir).stdout, /записана/);
  assert.match(cli(['context'], dir).stdout, /Q1 \[spec\]/);
  assert.match(cli(['doctor'], dir).stdout, /конфигурация валидна/);
  assert.match(cli(['run', '--mode', 'day', '--dry-run'], dir).stdout, /dry-run/);
  assert.match(cli(['summary'], dir).stdout, /🌙 Прогоны/);
  assert.equal(cli(['approval', 'request', 'nope'], dir).status, 1);
});

test('approval set человеком сразу коммитит метаданные одобрения', () => {
  const dir = tmpDir();
  cli(['init', '--name', 'demo'], dir);
  addChange(dir, 'ddm', { tasks: '- [ ] a\n' });
  gitRepo(dir); git(dir, 'add', '.'); git(dir, 'commit', '-q', '-m', 'проект');
  const r = cli(['approval', 'set', 'ddm', 'approved', '--priority', '3'], dir);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /Закоммичено/);
  assert.equal(git(dir, 'log', '-1', '--format=%s'), 'chore(ddm): одобрение человека — approved');
  assert.equal(git(dir, 'status', '--porcelain', '--', 'openspec'), '');
});

test('approval set во время прогона (есть mcfly/.lock) не коммитит: метаданные закоммитит прогон', () => {
  const dir = tmpDir();
  cli(['init', '--name', 'demo'], dir);
  addChange(dir, 'ddm', { tasks: '- [ ] a\n' });
  gitRepo(dir); git(dir, 'add', '.'); git(dir, 'commit', '-q', '-m', 'проект');
  fs.writeFileSync(path.join(dir, 'mcfly', '.lock'), JSON.stringify({ pid: process.pid }));
  const r = cli(['approval', 'set', 'ddm', 'approved'], dir);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /идёт прогон/);
  assert.equal(git(dir, 'log', '-1', '--format=%s'), 'проект');
});

test('status говорит, идёт ли прогон', () => {
  const dir = tmpDir(); gitRepo(dir);
  cli(['init', '--name', 'demo'], dir);
  assert.match(cli(['status'], dir).stdout, /^Прогон сейчас не идёт\./m);
  const runDir = path.join(dir, 'mcfly', 'runs', '20261001-0926'); fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(path.join(runDir, 'events.log'), '2026-10-01 09:55 → Bash: mvn test\n');
  // Лок живой, только если его держит процесс «mcfly … run».
  const runner = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)', 'mcfly', 'run'], { stdio: 'ignore' });
  fs.writeFileSync(path.join(dir, 'mcfly', '.lock'), JSON.stringify({ pid: runner.pid, at: new Date(2026, 9, 1, 9, 26).toISOString(), id: '20261001-0926' }));
  let out; try { out = cli(['status'], dir).stdout; } finally { runner.kill(); }
  assert.match(out, /^Идёт прогон 20261001-0926 с 09:26; последнее: 2026-10-01 09:55 → Bash: mvn test/m);
});

test('answers --once во время прогона старой версии ничего не забирает: тот читает без блокировки опроса', () => {
  const dir = tmpDir(); gitRepo(dir);
  cli(['init', '--name', 'demo'], dir);
  const runner = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)', 'mcfly', 'run'], { stdio: 'ignore' });
  fs.writeFileSync(path.join(dir, 'mcfly', '.lock'), JSON.stringify({ pid: runner.pid, at: new Date().toISOString(), id: '20261001-0926' }));
  let out, outNew; try {
    out = cli(['answers', '--once'], dir);
    fs.writeFileSync(path.join(dir, 'mcfly', '.lock'), JSON.stringify({ pid: runner.pid, at: new Date().toISOString(), id: '20261001-0926', pull_lock: true }));
    outNew = cli(['answers', '--once'], dir);
  } finally { runner.kill(); }
  assert.equal(out.status, 0); assert.match(out.stdout, /идёт прогон старой версии/);
  assert.match(outNew.stdout, /Telegram не настроен/, 'прогон 0.5.4 берёт блокировку опроса — читать можно');
});
test('0.5.4: answers без --once — цикл опроса; без Telegram сразу выходит', () => {
  const dir = tmpDir(); gitRepo(dir);
  cli(['init', '--name', 'demo'], dir);
  const t0 = Date.now(); const out = cli(['answers'], dir);
  assert.equal(out.status, 0); assert.match(out.stdout, /Telegram не настроен/); assert.ok(Date.now() - t0 < 10_000);
});

test('shift: start → merge → write из worktree сессии', () => {
  const dir = tmpDir(); gitRepo(dir);
  cli(['init', '--name', 'demo'], dir); git(dir, 'add', '.'); git(dir, 'commit', '-q', '-m', 'init');
  changeBranch(dir, 'ddm', '- [ ] 1.1 a\n');
  const sess = path.join(tmpDir(), 'sess'); git(dir, 'worktree', 'add', '-q', '-b', 'claude/s', sess, 'main');
  assert.match(cli(['shift', 'start', 'ddm'], sess).stdout, /shift\/ddm-\d{8}-\d{4}/);
  fs.writeFileSync(path.join(sess, 'a.txt'), 'a'); git(sess, 'add', '.'); git(sess, 'commit', '-q', '-m', 'feat(ddm): a');
  assert.match(cli(['shift', 'merge'], sess).stdout, /влито в change\/ddm: коммитов 1/);
  const file = path.join(tmpDir(), 'h.md');
  fs.writeFileSync(file, '# Смена: день → ночь, x (источник: человек)\n## Изменения\n### ddm — x\n## Порядок\n1. ddm\n## Нужны решения человека\n- нет\n## Заметки\n- нет\n');
  const w = cli(['shift', 'write', '--file', file], sess);
  assert.equal(w.status, 0, w.stderr); assert.match(w.stdout, /mcfly\/shifts\/\d{8}-\d{4}-day\.md/);
  assert.match(w.stdout, /ddm: не одобрено или не найдено/);
  assert.match(cli(['shift', 'auto'], dir).stdout, /^# Смена: день → ночь, .* \(источник: авто\)/m);
  const bad = cli(['shift', 'merge'], dir);
  assert.equal(bad.status, 1); assert.match(bad.stderr, /основном рабочем дереве/);
});

test('0.5.1: shift write --file на несуществующий файл — «файл не найден»', () => {
  const dir = tmpDir(); gitRepo(dir); cli(['init', '--name', 'demo'], dir); git(dir, 'add', '.'); git(dir, 'commit', '-q', '-m', 'init');
  const sess = path.join(tmpDir(), 'sess'); git(dir, 'worktree', 'add', '-q', '-b', 'claude/s', sess, 'main');
  const r = cli(['shift', 'write', '--file', path.join(tmpDir(), 'нет.md')], sess);
  assert.equal(r.status, 1); assert.match(r.stderr, /файл не найден/);
});

import { paths as paths7 } from '../src/state.js';
import { loadIdeas as li7, saveIdeas as si7, addIdea as ai7, transitionIdea as ti7 } from '../src/ideas.js';
import { listChanges as lc7 } from '../src/approvals.js';
test('0.7.0: approval request --idea — только для взятого пункта; пункт становится спланированным', () => {
  const dir = tmpDir(); cli(['init', '--name', 'demo'], dir);
  const p = paths7(dir); const d = li7(p);
  ai7(d, { title: 'Взятый', benefit: 'y', source: 'team', size: 'S' }); ai7(d, { title: 'Не взятый', benefit: 'y', source: 'team', size: 'S' });
  ti7(d, 'I1', 'taken', { actor: 'bot' }); si7(p, d);
  addChange(dir, 'by-idea'); addChange(dir, 'other');
  const bad = cli(['approval', 'request', 'other', '--idea', 'I2'], dir);
  assert.equal(bad.status, 1); assert.match(bad.stderr, /I2 не взят владельцем \(статус: в списке\)/);
  const ok = cli(['approval', 'request', 'by-idea', '--idea', 'i1'], dir);
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(lc7(p.openspecChanges).find((c) => c.name === 'by-idea').mcfly.idea, 'I1');
  const after = li7(p).ideas[0];
  assert.deepEqual([after.status, after.change], ['planned', 'by-idea']);
});

test('0.7.0: mcfly ideas add/list — добавление, ошибки и вывод', () => {
  const dir = tmpDir(); cli(['init', '--name', 'demo'], dir);
  const ok = cli(['ideas', 'add', '--title', 'Автозапуск релизов', '--benefit', 'Документация не отстаёт', '--source', 'owner-backlog', '--size', 'M', '--ref', 'SHARED-UNDERSTANDING §4.1 п. 7'], dir);
  assert.equal(ok.status, 0, ok.stderr); assert.match(ok.stdout, /I1 добавлено в предложения/);
  const dup = cli(['ideas', 'add', '--title', 'автозапуск релизов', '--benefit', 'x', '--source', 'team', '--size', 'S'], dir);
  assert.equal(dup.status, 1); assert.match(dup.stderr, /уже есть: I1/);
  cli(['ideas', 'add', '--title', 'Как у других', '--benefit', 'удобнее', '--source', 'research', '--size', 'S', '--ref', 'https://example.com', '--needs-owner', 'доступ'], dir);
  const list = cli(['ideas', 'list'], dir).stdout;
  assert.match(list, /I1 \[в списке\] ваш · M — Автозапуск релизов/);
  assert.match(list, /I2 \[в списке\] команда · S — Как у других/);
  assert.doesNotMatch(cli(['ideas', 'list', '--status', 'taken'], dir).stdout, /I1/);
});

test('0.7.0: mcfly ideas set — в прогоне команды запрещено, в сессии — отказ и возврат', () => {
  const dir = tmpDir(); cli(['init', '--name', 'demo'], dir);
  cli(['ideas', 'add', '--title', 'Одна', '--benefit', 'польза', '--source', 'team', '--size', 'S'], dir);
  const inRun = spawnSync(process.execPath, [bin, 'ideas', 'set', 'I1', 'rejected'], { cwd: dir, encoding: 'utf8', env: { ...process.env, MCFLY_PROJECT_DIR: '', MCFLY_RUN_ID: '20261025-1200' } });
  assert.equal(inRun.status, 1); assert.match(inRun.stderr, /в прогоне команды ideas set запрещён/);
  const rej = cli(['ideas', 'set', 'I1', 'rejected', '--note', 'не нужно'], dir);
  assert.equal(rej.status, 0, rej.stderr); assert.match(cli(['ideas', 'list'], dir).stdout, /I1 \[отклонено\].*— причина: не нужно/);
  assert.equal(cli(['ideas', 'set', 'I1', 'proposed'], dir).status, 0);
  const bad = cli(['ideas', 'set', 'I1', 'done'], dir);
  assert.equal(bad.status, 1); assert.match(bad.stderr, /proposed \| taken \| rejected/);
});
