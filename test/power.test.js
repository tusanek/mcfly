import test from 'node:test';
import assert from 'node:assert/strict';
import { parsePmsetCustom, parseOnBattery, parseLidClosed, readPower, powerChecks } from '../src/power.js';
import { doctor } from '../src/doctor.js';
import { bareProject } from './helpers.js';

const CUSTOM = (ac, batt = 1) => `Battery Power:
 Sleep On Power Button 1
 displaysleep         5
 sleep                ${batt}
 disksleep            10
AC Power:
 Sleep On Power Button 1
 displaysleep         5
 sleep                ${ac}
 disksleep            10
`;
const ON_AC = "Now drawing from 'AC Power'\n -InternalBattery-0 (id=1)\t100%; charged; 0:00 remaining present: true\n";
const ON_BATT = "Now drawing from 'Battery Power'\n -InternalBattery-0 (id=1)\t78%; discharging; 5:09 remaining present: true\n";
const LID = (closed) => `      "AppleClamshellCausesSleep" = No\n      "AppleClamshellState" = ${closed ? 'Yes' : 'No'}\n`;

test('parsePmsetCustom: sleep по профилям, «Sleep On Power Button» не путается со sleep', () => {
  assert.deepEqual(parsePmsetCustom(CUSTOM(1, 10)), { acSleep: 1, battSleep: 10 });
  assert.deepEqual(parsePmsetCustom(CUSTOM(0)), { acSleep: 0, battSleep: 1 });
  // настольный Mac: профиля аккумулятора нет
  assert.deepEqual(parsePmsetCustom('AC Power:\n sleep                0\n'), { acSleep: 0, battSleep: null });
  assert.deepEqual(parsePmsetCustom(''), { acSleep: null, battSleep: null });
});

test('parseOnBattery и parseLidClosed', () => {
  assert.equal(parseOnBattery(ON_BATT), true);
  assert.equal(parseOnBattery(ON_AC), false);
  assert.equal(parseOnBattery(''), null);
  assert.equal(parseLidClosed(LID(true)), true);
  assert.equal(parseLidClosed(LID(false)), false);
  assert.equal(parseLidClosed(''), null);
});

test('readPower собирает состояние из pmset и ioreg; сбой команды — неизвестно, не ошибка', () => {
  const run = (bin, args) => (bin === 'pmset' ? (args[1] === 'custom' ? CUSTOM(1) : ON_BATT) : LID(true));
  assert.deepEqual(readPower({ run }), { acSleep: 1, battSleep: 1, onBattery: true, lidClosed: true });
  assert.deepEqual(readPower({ run: () => null }), { acSleep: null, battSleep: null, onBattery: null, lidClosed: null });
});

test('powerChecks: сон от сети — ошибка с подсказкой sudo pmset -c sleep 0', () => {
  const bad = powerChecks({ acSleep: 1, battSleep: 1, onBattery: false, lidClosed: false });
  assert.equal(bad.length, 1);
  assert.equal(bad[0].ok, false);
  assert.match(bad[0].label, /засыпает от сети через 1 мин/);
  assert.match(bad[0].hint, /sudo pmset -c sleep 0/);
  const good = powerChecks({ acSleep: 0, battSleep: 1, onBattery: false, lidClosed: false });
  assert.deepEqual(good.map((c) => c.ok), [true]);
});

test('powerChecks: аккумулятор и закрытая крышка — отдельные предупреждения', () => {
  const c = powerChecks({ acSleep: 0, battSleep: 1, onBattery: true, lidClosed: true });
  assert.equal(c.length, 3);
  assert.ok(c.some((x) => !x.ok && /от аккумулятора/.test(x.label) && /зарядк/.test(x.hint)));
  assert.ok(c.some((x) => !x.ok && /крышка/.test(x.label)));
  // ничего не узнали (не macOS, команды нет) — молчим
  assert.deepEqual(powerChecks({ acSleep: null, battSleep: null, onBattery: null, lidClosed: null }), []);
});

test('doctor показывает проверки питания', () => {
  const checks = doctor({ projectDir: bareProject(), log: () => {}, power: () => ({ acSleep: 1, battSleep: 1, onBattery: true, lidClosed: false }) });
  assert.ok(checks.some((c) => !c.ok && /засыпает от сети/.test(c.label)));
  assert.ok(checks.some((c) => !c.ok && /от аккумулятора/.test(c.label)));
  assert.ok(!checks.some((c) => /крышка/.test(c.label)));
});
