import test from 'node:test';
import assert from 'node:assert/strict';
import { planJobs, buildPlist, labelFor, staleLabels, ownLabels, jobWhen } from '../src/schedule.js';
import { cfg as baseCfg } from './helpers.js';

// Задание опроса ставится только при привязанном чате (chat_id)
const cfg = { ...baseCfg, telegram: { ...baseCfg.telegram, chat_id: '42' } };

test('planJobs: прогоны по слотам и сводка', () => {
  const jobs = planJobs(cfg, { projectDir: '/p', node: '/usr/bin/node', mcflyBin: '/m/bin/mcfly', logsDir: '/p/mcfly/logs', pathEnv: '/usr/bin', home: '/Users/u' });
  assert.deepEqual(jobs.map((j) => [j.label, j.hour, j.minute]), [['com.mcfly.demo.run-0000', 0, 0], ['com.mcfly.demo.run-0400', 4, 0], ['com.mcfly.demo.summary', 8, 0], ['com.mcfly.demo.answers', undefined, undefined]]);
  assert.match(jobs[0].plist, /<string>run<\/string>\s*<string>--mode<\/string>\s*<string>night<\/string>/);
  assert.match(jobs[2].plist, /<string>summary<\/string>\s*<string>--send<\/string>/);
  assert.match(jobs[0].plist, /<key>Hour<\/key><integer>0<\/integer>/);
  assert.match(jobs[0].plist, /com\.mcfly\.demo\.run-0000\.log/);
});
test('buildPlist экранирует XML', () => {
  const s = buildPlist({ label: labelFor('x', 'y'), node: '/n', mcflyBin: '/m', args: ['a&b'], projectDir: '/p', hour: 1, minute: 2, logPath: '/l', pathEnv: '/x', home: '/h' });
  assert.match(s, /a&amp;b/);
});
test('staleLabels: задания проекта, которых нет в плане (слот убран из конфигурации)', () => {
  const files = ['com.mcfly.demo.run-0000.plist', 'com.mcfly.demo.run-0200.plist', 'com.mcfly.demo.summary.plist',
    'com.mcfly.other.run-0000.plist', 'com.mcfly.demo.run-0400.plist.bak', 'com.apple.x.plist'];
  const planned = ['com.mcfly.demo.run-0200', 'com.mcfly.demo.run-0600', 'com.mcfly.demo.summary'];
  assert.deepEqual(staleLabels(files, 'demo', planned), ['com.mcfly.demo.run-0000']);
});
test('ownLabels: задания проекта с точкой в имени не принадлежат проекту-префиксу', () => {
  const files = ['com.mcfly.demo.run-0000.plist', 'com.mcfly.demo.v2.run-0000.plist', 'com.mcfly.demo.v2.summary.plist', 'com.mcfly.demo.summary.plist', 'com.mcfly.demo.notes.plist'];
  assert.deepEqual(ownLabels(files, 'demo'), ['com.mcfly.demo.run-0000', 'com.mcfly.demo.summary']);
  assert.deepEqual(ownLabels(files, 'demo.v2'), ['com.mcfly.demo.v2.run-0000', 'com.mcfly.demo.v2.summary']);
});

test('planJobs: опрос ответов из Telegram — постоянное задание (KeepAlive, не чаще раза в минуту); 0 — без задания', () => {
  const opts = { projectDir: '/p', node: '/n', mcflyBin: '/m', logsDir: '/l', pathEnv: '/x', home: '/h' };
  const answers = planJobs(cfg, opts).find((j) => j.label === 'com.mcfly.demo.answers');
  // StartInterval на батарее сдвигается и пропускается, если прошлый цикл ещё не вышел (02.10: опроса не было 10 минут)
  assert.match(answers.plist, /<key>KeepAlive<\/key><true\/>/);
  assert.match(answers.plist, /<key>ThrottleInterval<\/key><integer>60<\/integer>/);
  assert.doesNotMatch(answers.plist, /StartInterval/);
  assert.match(answers.plist, /<string>answers<\/string>/);
  assert.doesNotMatch(answers.plist, /StartCalendarInterval/);
  assert.equal(planJobs({ ...cfg, schedule: { ...cfg.schedule, answers_every_minutes: 0 } }, opts).some((j) => j.label.endsWith('.answers')), false);
  assert.equal(planJobs({ ...cfg, telegram: { ...cfg.telegram, chat_id: '' } }, opts).some((j) => j.label.endsWith('.answers')), false, 'без chat_id опрашивать некого');
});
test('ownLabels: задание опроса ответов принадлежит проекту', () => {
  assert.deepEqual(ownLabels(['com.mcfly.demo.answers.plist', 'com.mcfly.demo.v2.answers.plist'], 'demo'), ['com.mcfly.demo.answers']);
});

test('jobWhen: время задания по часам или интервал', () => {
  assert.equal(jobWhen({ hour: 2, minute: 0 }), '02:00');
  assert.equal(jobWhen({ interval: 600 }), 'каждые 10 мин');
  assert.equal(jobWhen({ keepAlive: true, window: 600 }), 'постоянно, цикл 10 мин');
});

test('0.5.2: задание answers не убивает запущенный из Telegram прогон (AbandonProcessGroup)', () => {
  const opts = { projectDir: '/p', node: '/n', mcflyBin: '/m', logsDir: '/l', pathEnv: '/x', home: '/h' };
  const jobs = planJobs(cfg, opts);
  assert.match(jobs.find((j) => j.label.endsWith('.answers')).plist, /<key>AbandonProcessGroup<\/key><true\/>/);
  assert.doesNotMatch(jobs.find((j) => j.label.endsWith('.summary')).plist, /AbandonProcessGroup/);
});

// ── 0.8.1: переустановка заданий без настоящего launchctl ──
import fs from 'node:fs';
import path from 'node:path';
import { install, status, remove } from '../src/schedule.js';
import { tmpDir } from './helpers.js';

/**
 * Подставной launchctl: задания gui-домена в памяти.
 * unloadPolls — сколько проверок `print` задание ещё видно после bootout (выгрузка асинхронная:
 * процесс answers с KeepAlive и длинным опросом Telegram уходит не мгновенно — 07.11 bootstrap сразу после bootout упал с ошибкой 5).
 */
function fakeLaunchctl({ loaded = [], unloadPolls = 0, bootstrapFailures = 0 } = {}) {
  const state = new Map(loaded.map((l) => [l, { left: 0, unloading: false }]));
  let fails = bootstrapFailures; const calls = [];
  const fn = (args) => {
    calls.push(args.join(' '));
    const [cmd, target, file] = args;
    const label = cmd === 'bootstrap' ? path.basename(file, '.plist') : String(target).split('/').pop();
    if (cmd === 'print') {
      const s = state.get(label); if (!s) return { status: 113, out: `Could not find service "${label}"` };
      if (s.unloading) { if (s.left <= 0) { state.delete(label); return { status: 113, out: 'Could not find service' }; } s.left -= 1; }
      return { status: 0, out: `${label} = { state = running }` };
    }
    if (cmd === 'bootout') {
      const s = state.get(label); if (!s) return { status: 3, out: 'Boot-out failed: 3: No such process' };
      if (unloadPolls > 0) { s.unloading = true; s.left = unloadPolls; } else state.delete(label);
      return { status: 0, out: '' };
    }
    if (cmd === 'bootstrap') {
      if (state.has(label) || fails > 0) { if (!state.has(label)) fails -= 1; return { status: 5, out: 'Bootstrap failed: 5: Input/output error' }; }
      state.set(label, { left: 0, unloading: false }); return { status: 0, out: '' };
    }
    if (cmd === 'list') return { status: 0, out: ['PID\tStatus\tLabel', ...[...state.keys()].map((l, i) => `${l.endsWith('.answers') ? 900 + i : '-'}\t0\t${l}`)].join('\n') };
    return { status: 1, out: `неизвестная команда ${cmd}` };
  };
  fn.state = state; fn.calls = calls;
  return fn;
}
/** Часы, которые идут только во время пауз: ожидание 30 с проходит мгновенно. */
function fakeClock() { let t = 0; return { now: () => t, sleep: (ms) => { t += ms; } }; }
function setup(opts = {}) {
  const agentsDir = tmpDir('mcfly-agents-'); const projectDir = tmpDir('mcfly-proj-');
  const launchctl = fakeLaunchctl(opts); const clock = fakeClock(); const lines = [];
  const o = { projectDir, mcflyBin: '/m/bin/mcfly', logsDir: path.join(projectDir, 'mcfly', 'logs'), agentsDir, uid: 501, launchctl, ...clock, log: (s) => lines.push(s) };
  return { o, launchctl, lines, agentsDir };
}
const LABELS = ['com.mcfly.demo.run-0000', 'com.mcfly.demo.run-0400', 'com.mcfly.demo.summary', 'com.mcfly.demo.answers'];
const putPlists = (dir, labels) => { for (const l of labels) fs.writeFileSync(path.join(dir, `${l}.plist`), '<plist/>'); };

test('0.8.1: install на работающем answers ждёт выгрузки и поднимает его снова (07.11 answers пропал до повторного install)', () => {
  const { o, launchctl, lines, agentsDir } = setup({ loaded: LABELS, unloadPolls: 4 });
  putPlists(agentsDir, LABELS);
  const r = install(cfg, o);
  assert.deepEqual(r.failed, []);
  assert.deepEqual([...launchctl.state.keys()].sort(), [...LABELS].sort(), 'все задания плана снова загружены');
  const calls = launchctl.calls; const i = calls.indexOf('bootstrap gui/501 ' + path.join(agentsDir, 'com.mcfly.demo.answers.plist'));
  assert.equal(calls[i - 1], 'print gui/501/com.mcfly.demo.answers', 'bootstrap — только после того, как print перестал видеть задание');
  assert.ok(lines.every((l) => l.startsWith('✓')), lines.join('\n'));
});

test('0.8.1: незагруженное задание (plist есть, launchd его не знает) не выгружается, а сразу загружается', () => {
  const { o, launchctl, agentsDir } = setup();
  putPlists(agentsDir, LABELS);
  assert.deepEqual(install(cfg, o).failed, []);
  assert.equal(launchctl.calls.some((c) => c.startsWith('bootout')), false);
  assert.equal(launchctl.state.size, 4);
});

test('0.8.1: сбой bootstrap повторяется с паузой', () => {
  const { o, launchctl, lines } = setup({ bootstrapFailures: 2 });
  assert.deepEqual(install(cfg, o).failed, []);
  assert.equal(launchctl.state.size, 4);
  assert.equal(launchctl.calls.filter((c) => c.startsWith('bootstrap') && c.endsWith('run-0000.plist')).length, 3);
  assert.ok(lines.every((l) => l.startsWith('✓')), lines.join('\n'));
});

test('0.8.1: задание так и не загрузилось — понятная строка ✗ и метка в failed', () => {
  const { o, lines } = setup({ bootstrapFailures: 1000 });
  const r = install(cfg, o);
  assert.deepEqual(r.failed, LABELS);
  const bad = lines.find((l) => l.includes('com.mcfly.demo.answers'));
  assert.match(bad, /^✗ com\.mcfly\.demo\.answers.*не загружено.*Input\/output error/);
  assert.match(bad, /mcfly schedule install/);
});

test('0.8.1: задание не выгрузилось за 30 с — ✗, без bootstrap поверх старого', () => {
  const { o, launchctl, lines, agentsDir } = setup({ loaded: ['com.mcfly.demo.answers'], unloadPolls: 1e9 });
  putPlists(agentsDir, ['com.mcfly.demo.answers']);
  const r = install(cfg, o);
  assert.deepEqual(r.failed, ['com.mcfly.demo.answers']);
  assert.match(lines.find((l) => l.includes('.answers')), /^✗ .*не выгрузилось за 30 с/);
  assert.equal(launchctl.calls.some((c) => c.startsWith('bootstrap') && c.includes('answers')), false);
});

test('0.8.1: убранный слот выгружается, plist удаляется (ветка удаления раньше не была покрыта)', () => {
  const { o, launchctl, lines, agentsDir } = setup({ loaded: ['com.mcfly.demo.run-0600'], unloadPolls: 2 });
  putPlists(agentsDir, ['com.mcfly.demo.run-0600']);
  install(cfg, o);
  assert.equal(fs.existsSync(path.join(agentsDir, 'com.mcfly.demo.run-0600.plist')), false);
  assert.equal(launchctl.state.has('com.mcfly.demo.run-0600'), false);
  assert.ok(lines.includes('✓ удалено com.mcfly.demo.run-0600 (слота нет в конфигурации)'));
});

test('0.8.1: dry-run не вызывает launchctl', () => {
  const { o, launchctl } = setup({ loaded: LABELS });
  install(cfg, { ...o, dryRun: true });
  assert.deepEqual(launchctl.calls, []);
});

test('0.8.1: status называет задания плана, которые не загружены, и лишние', () => {
  const { o, lines } = setup({ loaded: ['com.mcfly.demo.run-0000', 'com.mcfly.demo.run-0400', 'com.mcfly.demo.summary', 'com.mcfly.demo.run-0600'] });
  const missing = status(cfg, o);
  assert.equal(missing, 1);
  assert.match(lines.find((l) => l.includes('.answers')), /^✗ com\.mcfly\.demo\.answers .*НЕ загружено.*mcfly schedule install/);
  assert.match(lines.find((l) => l.includes('run-0000')), /^✓ com\.mcfly\.demo\.run-0000 → 00:00 — загружено/);
  assert.match(lines.find((l) => l.includes('run-0600')), /^⚠ com\.mcfly\.demo\.run-0600 .*нет в конфигурации/);
});

test('0.8.1: status — работающий answers с номером процесса, всё на месте — 0', () => {
  const { o, lines } = setup({ loaded: LABELS });
  assert.equal(status(cfg, o), 0);
  assert.match(lines.find((l) => l.includes('.answers')), /^✓ .*работает \(процесс \d+\)/);
});

test('0.8.1: remove выгружает задания проекта и удаляет plist', () => {
  const { o, launchctl, agentsDir } = setup({ loaded: LABELS, unloadPolls: 2 });
  putPlists(agentsDir, LABELS);
  remove(cfg, o);
  assert.equal(launchctl.state.size, 0);
  assert.deepEqual(fs.readdirSync(agentsDir), []);
});

test('0.8.1: bootstrap вернул ошибку, но задание загрузилось — успех без лишних попыток', () => {
  const { o, launchctl } = setup();
  const real = launchctl;
  const flaky = (args) => { const r = real(args); if (args[0] === 'bootstrap' && args[2].endsWith('answers.plist') && r.status === 0) return { status: 37, out: 'Operation already in progress' }; return r; };
  flaky.calls = real.calls;
  const r = install(cfg, { ...o, launchctl: flaky });
  assert.deepEqual(r.failed, []);
  assert.equal(real.calls.filter((c) => c.startsWith('bootstrap') && c.endsWith('answers.plist')).length, 1);
});
