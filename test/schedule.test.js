import test from 'node:test';
import assert from 'node:assert/strict';
import { planJobs, buildPlist, labelFor } from '../src/schedule.js';
import { cfg } from './helpers.js';

test('planJobs: прогоны по слотам и сводка', () => {
  const jobs = planJobs(cfg, { projectDir: '/p', node: '/usr/bin/node', mcflyBin: '/m/bin/mcfly', logsDir: '/p/mcfly/logs', pathEnv: '/usr/bin', home: '/Users/u' });
  assert.deepEqual(jobs.map((j) => [j.label, j.hour, j.minute]), [['com.mcfly.demo.run-0000', 0, 0], ['com.mcfly.demo.run-0400', 4, 0], ['com.mcfly.demo.summary', 8, 0]]);
  assert.match(jobs[0].plist, /<string>run<\/string>\s*<string>--mode<\/string>\s*<string>night<\/string>/);
  assert.match(jobs[2].plist, /<string>summary<\/string>\s*<string>--send<\/string>/);
  assert.match(jobs[0].plist, /<key>Hour<\/key><integer>0<\/integer>/);
  assert.match(jobs[0].plist, /com\.mcfly\.demo\.run-0000\.log/);
});
test('buildPlist экранирует XML', () => {
  const s = buildPlist({ label: labelFor('x', 'y'), node: '/n', mcflyBin: '/m', args: ['a&b'], projectDir: '/p', hour: 1, minute: 2, logPath: '/l', pathEnv: '/x', home: '/h' });
  assert.match(s, /a&amp;b/);
});
