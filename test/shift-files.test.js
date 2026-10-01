import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs'; import path from 'node:path';
import { paths } from '../src/state.js';
import { shiftFileName, listShifts, latestShift, activeDayHandoff, validateHandoff, mentionedChanges, writeShift } from '../src/shift-files.js';
import { bareProject } from './helpers.js';

export const HANDOFF = `# Смена: день → ночь, 2026-10-01 18:30 (источник: человек)
## Изменения
### llm-adaptation — ветка change/llm-adaptation @ 1a2b3c4, задач 4/10
- Где остановились: 2.3 наполовину
- Дальше: 2.3 → 2.4
## Порядок
1. llm-adaptation
2. page-map-seed
## Нужны решения человека
- нет
## Заметки
- нет
`;

test('shiftFileName: дата, время и вид', () => {
  assert.equal(shiftFileName('day', new Date(2026, 9, 1, 18, 30)), '20261001-1830-day.md');
  assert.equal(shiftFileName('night', new Date(2026, 9, 2, 6, 5)), '20261002-0605-night.md');
});
test('writeShift не перезаписывает файл той же минуты — суффикс', () => {
  const p = paths(bareProject()); const now = new Date(2026, 9, 1, 18, 30);
  const a = writeShift(p, 'day', 'первая', now); const b = writeShift(p, 'day', 'вторая', now);
  assert.equal(path.basename(a), '20261001-1830-day.md'); assert.equal(path.basename(b), '20261001-1830-day-2.md');
  assert.equal(fs.readFileSync(a, 'utf8'), 'первая');
  assert.equal(latestShift(p, 'day').file, '20261001-1830-day-2.md');
});
test('activeDayHandoff: дневная действует, пока не появилась более новая ночная', () => {
  const p = paths(bareProject());
  assert.equal(activeDayHandoff(p), null);
  writeShift(p, 'night', 'н', new Date(2026, 9, 1, 6, 40));
  assert.equal(activeDayHandoff(p), null, 'ночная новее — дневной нет');
  writeShift(p, 'day', 'д', new Date(2026, 9, 1, 18, 30));
  assert.equal(activeDayHandoff(p).text, 'д');
  writeShift(p, 'night', 'н2', new Date(2026, 9, 2, 6, 40));
  assert.equal(activeDayHandoff(p), null);
  assert.deepEqual(listShifts(p).map((s) => s.kind), ['night', 'day', 'night']);
});
test('validateHandoff: полный файл без замечаний; называет недостающее', () => {
  assert.deepEqual(validateHandoff(HANDOFF), []);
  assert.deepEqual(validateHandoff(HANDOFF.replace('## Порядок', '## Предложение на день')), []);
  assert.deepEqual(validateHandoff('# Смена: x\n## Изменения\n'), ['## Порядок или ## Предложение на день', '## Нужны решения человека', '## Заметки']);
});
test('mentionedChanges: из заголовков изменений и раздела «Порядок»', () => {
  assert.deepEqual(mentionedChanges(HANDOFF), ['llm-adaptation', 'page-map-seed']);
});
