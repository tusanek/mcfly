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
