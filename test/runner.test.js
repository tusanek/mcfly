import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs'; import path from 'node:path';
import { run, acquireLock, releaseLock, commitRunState, recordRun, writeFallbackSummary, currentRun } from '../src/runner.js';
import { spawn, spawnSync } from 'node:child_process';
import { paths } from '../src/state.js';
import { readMetrics } from '../src/metrics.js';
import { ensureGitignore, GITIGNORE_ENTRIES } from '../src/init.js';
import { listChanges, requestApproval } from '../src/approvals.js';
import { bareProject, fakeClaude, fakeClaudeSeq, fakeScutil, tmpDir, git, gitRepo, addChange } from './helpers.js';

const resultEvent = (over = {}) => ({ type: 'result', subtype: 'success', is_error: false, num_turns: 1, total_cost_usd: 0.1, session_id: 's', result: 'готово', ...over });
const readRecord = (p, id) => JSON.parse(fs.readFileSync(path.join(p.runs, id, 'result.json'), 'utf8'));

test('ночной прогон вне окна записывается как пропущенный', async () => {
  const dir = bareProject(); const p = paths(dir);
  const r = await run({ projectDir: dir, mode: 'night', now: new Date(2026, 8, 29, 6, 0), log: () => {} });
  assert.equal(r.status, 'missed');
  const rec = readMetrics(p)[0];
  assert.equal(rec.status, 'missed'); assert.match(rec.note, /вне окна/);
  assert.match(fs.readFileSync(p.progress, 'utf8'), /missed/);
});
test('dry-run внутри окна сохраняет промпт и не запускает claude', async () => {
  const dir = bareProject(); const p = paths(dir);
  const r = await run({ projectDir: dir, mode: 'night', dryRun: true, now: new Date(2026, 8, 29, 0, 5), log: () => {} });
  assert.equal(r.status, 'dry-run');
  assert.ok(fs.existsSync(path.join(p.logs, `dry-run-${r.id}.prompt.md`)));
  assert.equal(fs.existsSync(path.join(p.runs, r.id)), false, 'сухой прогон не создаёт каталог в runs');
  assert.equal(fs.existsSync(p.lock), false);
});
test('прогон запускает claude без фоновых задач и без потолка ожидания фона', async () => {
  const dir = bareProject();
  const { envFile } = fakeClaude(dir, { lines: [resultEvent()] });
  await run({ projectDir: dir, mode: 'day', log: () => {} });
  const env = fs.readFileSync(envFile, 'utf8');
  assert.match(env, /^CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1$/m);
  assert.match(env, /^CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS=0$/m);
});
test('прогон не передаёт агентам токен Telegram', async () => {
  const dir = bareProject();
  const { envFile } = fakeClaude(dir, { lines: [resultEvent()] });
  const prev = process.env.MCFLY_TELEGRAM_TOKEN; process.env.MCFLY_TELEGRAM_TOKEN = 'secret-bot-token';
  try { await run({ projectDir: dir, mode: 'day', log: () => {} }); } finally { if (prev === undefined) delete process.env.MCFLY_TELEGRAM_TOKEN; else process.env.MCFLY_TELEGRAM_TOKEN = prev; }
  assert.doesNotMatch(fs.readFileSync(envFile, 'utf8'), /MCFLY_TELEGRAM_TOKEN/);
});
test('result.json: ходы по всем событиям result и статистика субагентов', async () => {
  const dir = bareProject(); const p = paths(dir);
  const stats = { spawned: 8, requested: { background: 0, foreground: 0, unset: 8 }, started_in_background: 8, completed: 7, failed: 0, killed: { parent: 0, user: 0, system: 1 } };
  fakeClaude(dir, { lines: [resultEvent({ num_turns: 12, result: 'Жду devops.' }), resultEvent({ num_turns: 3, result: 'Жду разработчика 3.2.', subagent_stats: stats })] });
  const r = await run({ projectDir: dir, mode: 'day', log: () => {} });
  const rec = readRecord(p, r.id);
  assert.equal(rec.turns, 15);
  assert.deepEqual(rec.subagents, { spawned: 8, background: 8, failed: 0, killed: 1 });
});
test('stderr claude попадает в events.log', async () => {
  const dir = bareProject(); const p = paths(dir);
  fakeClaude(dir, { lines: [resultEvent()], stderr: 'Background tasks still running after 600s; terminating.' });
  const r = await run({ projectDir: dir, mode: 'day', log: () => {} });
  assert.match(fs.readFileSync(path.join(p.runs, r.id, 'events.log'), 'utf8'), /⚠ Background tasks still running after 600s; terminating\./);
});
/** Проект mcfly в git с .gitignore как после init: всё закоммичено, подставной claude печатает lines. */
function gitProject(lines = [resultEvent()]) {
  const dir = bareProject();
  fakeClaude(dir, { lines }); ensureGitignore(dir, GITIGNORE_ENTRIES);
  gitRepo(dir); git(dir, 'add', '.'); git(dir, 'commit', '-q', '-m', 'проект');
  return { dir, p: paths(dir) };
}
test('незакоммиченные файлы прогона не включают служебные файлы runner', async () => {
  const { dir, p } = gitProject();
  fs.appendFileSync(p.metrics, '{"type":"event","key":"review_rejections","value":1}\n'); // метрика команды за прогон
  fs.writeFileSync(path.join(dir, 'забытый.txt'), 'x');
  const r = await run({ projectDir: dir, mode: 'day', log: () => {} });
  const rec = readRecord(p, r.id);
  assert.equal(rec.dirty_files, 1);
  assert.match(rec.note, /незакоммиченных файлов: 1/);
});
test('незакоммиченная работа в worktree команды попадает в заметку прогона и авто-сводку', async () => {
  const { dir, p } = gitProject([resultEvent({ result: 'Жду разработчика 3.2.' })]);
  const wt = path.join(tmpDir(), 'ddm');
  git(dir, 'worktree', 'add', '-q', '-b', 'change/ddm', wt);
  fs.writeFileSync(path.join(wt, 'SiteBuilder.java'), 'class SiteBuilder {}'); git(wt, 'add', '.');
  const r = await run({ projectDir: dir, mode: 'day', log: () => {} });
  const where = `${fs.realpathSync(wt)} (change/ddm, 1)`;
  assert.ok(readRecord(p, r.id).note.includes(`незакоммиченная работа в worktree: ${where}`), readRecord(p, r.id).note);
  const summary = fs.readFileSync(path.join(p.runs, r.id, 'summary.md'), 'utf8');
  assert.match(summary, /## Worktree с незакоммиченной работой\n- .*ddm \(change\/ddm, 1\)/);
});
test('recordRun: строка журнала со статистикой субагентов, аномалии только ненулевые', () => {
  const p = paths(bareProject());
  recordRun(p, { id: 'r1', mode: 'night', slot: '04:00', started_at: new Date(2026, 8, 29, 4, 0).toISOString(), status: 'ok', turns: 30, cost_usd: 4.1, subagents: { spawned: 8, background: 8, failed: 0, killed: 1 } });
  recordRun(p, { id: 'r2', mode: 'night', slot: '00:00', started_at: new Date(2026, 8, 30, 0, 0).toISOString(), status: 'ok', turns: 5, cost_usd: 1, subagents: { spawned: 3, background: 0, failed: 0, killed: 0 } });
  const text = fs.readFileSync(p.progress, 'utf8');
  assert.match(text, /прогон r1 \(night, слот 04:00\): ok, 30 ходов, ~\$4\.10, субагентов 8 \(фоном 8, убито 1\)\n/);
  assert.match(text, /прогон r2 \(night, слот 00:00\): ok, 5 ходов, ~\$1\.00, субагентов 3\n/);
});
test('commitRunState коммитит только служебные файлы, чужой индекс не трогает', () => {
  const dir = bareProject(); const p = paths(dir);
  gitRepo(dir); git(dir, 'add', '.'); git(dir, 'commit', '-q', '-m', 'проект');
  fs.writeFileSync(path.join(dir, 'Half.java'), 'class Half {}'); git(dir, 'add', 'Half.java'); // работа агента в индексе на момент обрыва
  recordRun(p, { id: 'r1', mode: 'day', slot: null, started_at: new Date().toISOString(), status: 'timeout' });
  assert.equal(commitRunState(dir, 'r1', () => {}), true);
  assert.doesNotMatch(git(dir, 'show', '--name-only', '--format=', 'HEAD'), /Half\.java/);
  assert.match(git(dir, 'status', '--porcelain'), /^A {2}Half\.java$/m);
});
/** Живой процесс-владелец лока: с аргументами «mcfly run» выглядит как прогон mcfly, без них — как посторонний процесс с тем же pid. */
function liveProcess(asRunner) {
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60_000)', ...(asRunner ? ['mcfly', 'run'] : [])], { stdio: 'ignore' });
  spawnSync('sleep', ['0.3']); // дать процессу выполнить exec, чтобы ps видел его собственную команду
  return child;
}
const lockBy = (p, pid, ageMs = 0) => fs.writeFileSync(p.lock, JSON.stringify({ pid, at: new Date(Date.now() - ageMs).toISOString() }));
test('лок живого прогона mcfly держится и дольше лимита: Mac мог спать посреди прогона', () => {
  const p = paths(bareProject()); const other = liveProcess(true);
  try { lockBy(p, other.pid, 5 * 3600_000); assert.equal(acquireLock(p, { maxAgeMs: 3.5 * 3600_000 }), false); } finally { other.kill(); }
});
test('лок, чей pid занят посторонним процессом, считается брошенным', () => {
  const p = paths(bareProject()); const other = liveProcess(false);
  try { lockBy(p, other.pid); assert.equal(acquireLock(p), true); releaseLock(p); } finally { other.kill(); }
});
test('releaseLock снимает только свой лок', () => {
  const p = paths(bareProject());
  lockBy(p, 999_999); releaseLock(p);
  assert.ok(fs.existsSync(p.lock));
});
test('прогон, наткнувшийся на чужой лок, записывается как locked и лок не снимает', async () => {
  const dir = bareProject(); const p = paths(dir); const other = liveProcess(true);
  try {
    fakeClaude(dir, { lines: [resultEvent()] }); lockBy(p, other.pid); // идёт другой прогон
    const r = await run({ projectDir: dir, mode: 'day', log: () => {} });
    assert.equal(r.status, 'locked');
    assert.equal(readMetrics(p).at(-1).status, 'locked');
    assert.ok(fs.existsSync(p.lock), 'лок идущего прогона на месте');
  } finally { other.kill(); }
});
test('commitRunState сообщает, если git не смог добавить файлы (остался index.lock)', () => {
  const dir = bareProject(); const p = paths(dir);
  gitRepo(dir); git(dir, 'add', '.'); git(dir, 'commit', '-q', '-m', 'проект');
  recordRun(p, { id: 'r1', mode: 'day', slot: null, started_at: new Date().toISOString(), status: 'timeout' });
  fs.writeFileSync(path.join(dir, '.git', 'index.lock'), ''); // git агента убит по таймауту
  const lines = [];
  assert.equal(commitRunState(dir, 'r1', (s) => lines.push(s)), false);
  assert.match(lines.join('\n'), /Не удалось закоммитить файлы прогона/);
});
test('токен в stderr claude маскируется в events.log, result.json и журнале', async () => {
  const dir = bareProject(); const p = paths(dir);
  fakeClaude(dir, { lines: [], stderr: 'auth failed for sk-ant-oat01-SECRETSECRET', exitCode: 1 });
  const r = await run({ projectDir: dir, mode: 'day', log: () => {} });
  for (const file of [path.join(p.runs, r.id, 'events.log'), path.join(p.runs, r.id, 'result.json'), p.progress, p.metrics]) {
    assert.doesNotMatch(fs.readFileSync(file, 'utf8'), /SECRETSECRET/, file);
  }
  assert.match(fs.readFileSync(path.join(p.runs, r.id, 'events.log'), 'utf8'), /sk-ant-\*\*\*/);
});
test('dry-run при чужом локе не оставляет записей', async () => {
  const dir = bareProject(); const p = paths(dir); const other = liveProcess(true);
  try {
    lockBy(p, other.pid);
    const r = await run({ projectDir: dir, mode: 'day', dryRun: true, log: () => {} });
    assert.equal(r.status, 'locked');
    assert.equal(readMetrics(p).length, 0); assert.equal(fs.existsSync(path.join(p.runs, r.id)), false);
  } finally { other.kill(); }
});
test('метаданные одобрения, которые runner правит сам, коммитятся и не считаются незакоммиченными', async () => {
  const { dir, p } = gitProject();
  addChange(dir, 'add-x'); requestApproval(listChanges(p.openspecChanges)[0], { category: 'spec', now: new Date(Date.now() - 48 * 3600_000) });
  git(dir, 'add', '.'); git(dir, 'commit', '-q', '-m', 'изменение ждёт одобрения');
  const r = await run({ projectDir: dir, mode: 'day', log: () => {} }); // срок истёк — runner авто-одобряет
  assert.match(fs.readFileSync(path.join(dir, 'openspec', 'changes', 'add-x', '.openspec.yaml'), 'utf8'), /approval: approved/);
  assert.equal(readRecord(p, r.id).dirty_files, 0);
  assert.equal(git(dir, 'status', '--porcelain'), '');
});
test('commitRunState не коммитит сырой stdout.log, даже без строки в .gitignore', () => {
  const dir = bareProject(); const p = paths(dir);
  gitRepo(dir); git(dir, 'add', '.'); git(dir, 'commit', '-q', '-m', 'проект');
  fs.mkdirSync(path.join(p.runs, 'r1'), { recursive: true }); fs.writeFileSync(path.join(p.runs, 'r1', 'stdout.log'), 'сырой вывод');
  recordRun(p, { id: 'r1', mode: 'day', slot: null, started_at: new Date().toISOString(), status: 'ok' });
  assert.equal(commitRunState(dir, 'r1', () => {}), true);
  assert.doesNotMatch(git(dir, 'show', '--name-only', '--format=', 'HEAD'), /stdout\.log/);
});
test('лок не даёт второго прогона', () => {
  const p = paths(bareProject());
  assert.equal(acquireLock(p), true); assert.equal(acquireLock(p), false); releaseLock(p); assert.equal(acquireLock(p), true); releaseLock(p);
});
test('commitRunState коммитит служебные файлы прогона', () => {
  const dir = bareProject(); const p = paths(dir);
  spawnSync('git', ['init', '-q'], { cwd: dir }); spawnSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init'], { cwd: dir });
  recordRun(p, { id: 'r1', mode: 'day', slot: null, started_at: new Date().toISOString(), ended_at: new Date().toISOString(), status: 'ok' });
  const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
  const prev = process.env; process.env = env;
  try { assert.equal(commitRunState(dir, 'r1', () => {}), true); } finally { process.env = prev; }
  assert.match(spawnSync('git', ['log', '--oneline', '-1'], { cwd: dir, encoding: 'utf8' }).stdout, /результат прогона r1/);
  assert.equal(spawnSync('git', ['status', '--porcelain', 'mcfly/progress.md'], { cwd: dir, encoding: 'utf8' }).stdout.trim(), '');
});
test('writeFallbackSummary пишет авто-сводку, если репортёр не написал отчёт', () => {
  const dir = bareProject(); const p = paths(dir);
  const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
  spawnSync('git', ['init', '-q'], { cwd: dir, env }); spawnSync('git', ['commit', '-q', '--allow-empty', '-m', 'init'], { cwd: dir, env });
  const started = new Date(Date.now() - 60_000);
  spawnSync('git', ['commit', '-q', '--allow-empty', '-m', 'feat(x): работа ночью'], { cwd: dir, env });
  const runDir = path.join(p.runs, 'r2'); fs.mkdirSync(runDir, { recursive: true });
  assert.equal(writeFallbackSummary({ projectDir: dir, runDir, id: 'r2', started, resultText: 'Жду разработчика 3.2.' }), true);
  const text = fs.readFileSync(path.join(runDir, 'summary.md'), 'utf8');
  assert.match(text, /авто-сводка/); assert.match(text, /работа ночью/); assert.match(text, /Жду разработчика/);
  assert.equal(writeFallbackSummary({ projectDir: dir, runDir, id: 'r2', started, resultText: '' }), false, 'существующий отчёт не перезаписывается');
});

const noAccess = { lines: [resultEvent({ is_error: true, result: 'Failed to authenticate. API Error: 403 Request not allowed', api_error_status: 403 })], exitCode: 1 };
test('нет доступа к API: прогон повторяется через паузу и продолжает, когда доступ появился', async () => {
  const dir = bareProject(); const p = paths(dir);
  const fake = fakeClaudeSeq(dir, [noAccess, { lines: [resultEvent()] }]);
  const waits = []; const notes = [];
  const r = await run({ projectDir: dir, mode: 'day', log: () => {}, sleep: async (ms) => { waits.push(ms); }, notify: async (t) => { notes.push(t); } });
  assert.equal(r.status, 'ok');
  assert.equal(fake.calls(), 2);
  assert.deepEqual(waits, [10 * 60_000]);
  const rec = readRecord(p, r.id);
  assert.equal(rec.attempts, 2);
  assert.match(fs.readFileSync(path.join(p.runs, r.id, 'events.log'), 'utf8'), /↻ нет доступа к API.*повтор через 10 мин \(попытка 2 из 7\)/);
  assert.equal(notes.length, 1); assert.match(notes[0], /^✅/, 'доступ появился — итог без тревоги');
});
test('нет доступа к API весь час: статус network и сразу сообщение в Telegram', async () => {
  const dir = bareProject(); const p = paths(dir);
  const fake = fakeClaudeSeq(dir, Array(7).fill(noAccess), { config: '  network_retries: 2\n  network_retry_minutes: 5\n' });
  const waits = []; const notes = [];
  const r = await run({ projectDir: dir, mode: 'day', log: () => {}, sleep: async (ms) => { waits.push(ms); }, notify: async (t) => { notes.push(t); } });
  assert.equal(r.status, 'network');
  assert.equal(fake.calls(), 3);
  assert.deepEqual(waits, [5 * 60_000, 5 * 60_000]);
  const rec = readRecord(p, r.id);
  assert.equal(rec.attempts, 3);
  assert.equal(notes.length, 1);
  assert.match(notes[0], /demo/); assert.match(notes[0], /нет доступа к API/); assert.match(notes[0], /VPN/); assert.match(notes[0], /3 попыт/);
});
test('ошибка прогона (не сеть) не повторяется, но сразу сообщается в Telegram', async () => {
  const dir = bareProject();
  const fake = fakeClaudeSeq(dir, [{ lines: [resultEvent({ is_error: true, result: 'Failed to authenticate. API Error: 401 Invalid bearer token' })], exitCode: 1 }]);
  const waits = []; const notes = [];
  const r = await run({ projectDir: dir, mode: 'day', log: () => {}, sleep: async (ms) => { waits.push(ms); }, notify: async (t) => { notes.push(t); } });
  assert.equal(r.status, 'error'); assert.equal(fake.calls(), 1); assert.deepEqual(waits, []);
  assert.equal(notes.length, 1); assert.match(notes[0], /401/);
});
test('успешный прогон и квота: одно сообщение о завершении, без тревоги', async () => {
  for (const [attempt, re] of [[{ lines: [resultEvent()] }, /✅ mcfly demo: прогон \d\d:\d\d завершён: ок, 1 ходов, ~\$0\.10/], [{ lines: [resultEvent({ is_error: true, result: "You've hit your weekly limit" })], exitCode: 1 }, /⏸ mcfly demo: прогон \d\d:\d\d завершён: остановлен: лимит квоты/]]) {
    const dir = bareProject(); fakeClaudeSeq(dir, [attempt]);
    const notes = [];
    await run({ projectDir: dir, mode: 'day', log: () => {}, sleep: async () => {}, notify: async (t) => { notes.push(t); } });
    assert.equal(notes.length, 1); assert.match(notes[0], re); assert.doesNotMatch(notes[0], /⚠️/);
  }
});
test('сообщение о завершении называет прогресс одобренных изменений по веткам', async () => {
  const dir = bareProject();
  addChange(dir, 'add-x', { tasks: '- [x] a\n- [ ] b\n', meta: { schema: 'spec-driven', mcfly: { approval: 'approved' } } });
  fakeClaudeSeq(dir, [{ lines: [resultEvent()] }]);
  const notes = [];
  await run({ projectDir: dir, mode: 'day', log: () => {}, sleep: async () => {}, notify: async (t) => { notes.push(t); } });
  assert.match(notes[0], /add-x 1\/2/);
});
test('сбой отправки тревоги не роняет прогон', async () => {
  const dir = bareProject();
  fakeClaudeSeq(dir, [{ lines: [], stderr: 'boom', exitCode: 1 }]);
  const logs = [];
  const r = await run({ projectDir: dir, mode: 'day', log: (s) => logs.push(s), sleep: async () => {}, notify: async () => { throw new Error('Telegram недоступен'); } });
  assert.equal(r.status, 'error');
  assert.ok(logs.some((s) => /Telegram недоступен/.test(s)));
});

const vpnConfig = (f) => `  vpn_service: ${f.service}\n  scutil_bin: ${f.script}\n`;
test('VPN отключён перед прогоном: runner переподключает его и пишет об этом', async () => {
  const dir = bareProject(); const p = paths(dir);
  const vpn = fakeScutil({ state: 'Disconnected' });
  fakeClaudeSeq(dir, [{ lines: [resultEvent()] }], { config: vpnConfig(vpn) });
  const r = await run({ projectDir: dir, mode: 'day', log: () => {}, sleep: async () => {}, notify: async () => {} });
  assert.equal(r.status, 'ok');
  assert.ok(vpn.calls().includes(`start ${vpn.service}`));
  assert.match(fs.readFileSync(path.join(p.runs, r.id, 'events.log'), 'utf8'), /VPN «Test VPN» был отключён — переподключил/);
  assert.match(readRecord(p, r.id).note, /VPN «Test VPN» был отключён — переподключил/);
});
test('нет доступа к API и VPN упал: переподключение и повтор без паузы', async () => {
  const dir = bareProject();
  const vpn = fakeScutil();
  const fake = fakeClaudeSeq(dir, [noAccess, { lines: [resultEvent()] }], { config: vpnConfig(vpn) });
  const waits = [];
  // VPN падает после проверки перед прогоном — во время первой попытки.
  const r = await run({ projectDir: dir, mode: 'day', log: () => {}, sleep: async (ms) => { waits.push(ms); }, notify: async () => {},
    beforeAttempt: (n) => { if (n === 1) vpn.setState('Disconnected'); } });
  assert.equal(r.status, 'ok'); assert.equal(fake.calls(), 2);
  assert.deepEqual(waits, [], 'VPN переподключён — ждать 10 минут незачем');
});
test('нет доступа к API, VPN не поднимается: тревога говорит о VPN', async () => {
  const dir = bareProject();
  const vpn = fakeScutil({ state: 'Disconnected', stuck: true });
  fakeClaudeSeq(dir, Array(3).fill(noAccess), { config: vpnConfig(vpn) + '  network_retries: 2\n' });
  const notes = [];
  const r = await run({ projectDir: dir, mode: 'day', log: () => {}, sleep: async () => {}, notify: async (t) => { notes.push(t); } });
  assert.equal(r.status, 'network');
  assert.equal(notes.length, 1); assert.match(notes[0], /VPN «Test VPN» не подключился/);
});

test('currentRun: идущий прогон — id из лока и последнее событие; без лока — null', () => {
  const dir = bareProject(); const p = paths(dir);
  assert.equal(currentRun(p), null);
  assert.ok(acquireLock(p, { id: '20261001-0926' }));
  fs.mkdirSync(path.join(p.runs, '20261001-0926'), { recursive: true });
  fs.writeFileSync(path.join(p.runs, '20261001-0926', 'events.log'), '2026-10-01 09:55 → Bash: mvn test\n2026-10-01 09:56 ↻ повтор через 10 мин\n');
  const cur = currentRun(p);
  assert.equal(cur.id, '20261001-0926');
  assert.match(cur.lastEvent, /09:56 ↻ повтор/);
  releaseLock(p);
  assert.equal(currentRun(p), null);
});
