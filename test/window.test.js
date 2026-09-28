import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSlot, matchSlot, expectedSlots } from '../src/window.js';

test('parseSlot', () => { assert.equal(parseSlot('04:30'), 270); assert.throws(() => parseSlot('4:30')); });
test('matchSlot внутри окна', () => { assert.equal(matchSlot(new Date(2026, 8, 29, 0, 10), ['00:00', '04:00'], 30), '00:00'); });
test('matchSlot позже окна', () => { assert.equal(matchSlot(new Date(2026, 8, 29, 6, 0), ['00:00', '04:00'], 30), null); });
test('matchSlot до полуночи не попадает в 00:00', () => { assert.equal(matchSlot(new Date(2026, 8, 28, 23, 50), ['00:00'], 30), null); });
test('expectedSlots между моментами', () => {
  const got = expectedSlots(new Date(2026, 8, 28, 8, 0), new Date(2026, 8, 29, 8, 0), ['00:00', '04:00']);
  assert.deepEqual(got.map((e) => e.key), ['2026-09-29-00:00', '2026-09-29-04:00']);
});
