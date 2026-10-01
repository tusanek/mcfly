import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs'; import path from 'node:path';
import { paths } from '../src/state.js';
import { shiftFileName, listShifts, latestShift, activeDayHandoff, validateHandoff, mentionedChanges, writeShift } from '../src/shift-files.js';
import { bareProject, HANDOFF } from './helpers.js';


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

import { renderAutoHandoff } from '../src/shift-files.js';
import { shiftBranches } from '../src/git.js';
import { addChange, git, gitRepo, changeBranch, tmpDir } from './helpers.js';
import { listChanges, requestApproval, setApproval } from '../src/approvals.js';

function projectWithChange() {
  const dir = bareProject(); const p = paths(dir);
  addChange(dir, 'ddm', { tasks: '- [ ] 1.1 a\n- [ ] 1.2 b\n' });
  const [c] = listChanges(p.openspecChanges); requestApproval(c); setApproval(c, 'approved', 'human', '', new Date(), { priority: 3 });
  gitRepo(dir); git(dir, 'add', '.'); git(dir, 'commit', '-q', '-m', 'проект');
  changeBranch(dir, 'ddm', '- [x] 1.1 a\n- [ ] 1.2 b\n');
  return { dir, p };
}
test('shiftBranches: несданная дневная ветка — коммиты сверх change/<имя> и грязный worktree', () => {
  const { dir } = projectWithChange();
  const wt = path.join(tmpDir(), 'sess');
  git(dir, 'worktree', 'add', '-q', '-b', 'shift/ddm-20261001-1000', wt, 'change/ddm');
  fs.writeFileSync(path.join(wt, 'a.txt'), 'x'); git(wt, 'add', '.'); git(wt, 'commit', '-q', '-m', 'wip(ddm): a');
  fs.writeFileSync(path.join(wt, 'b.txt'), 'y');
  assert.deepEqual(shiftBranches(dir), [{ branch: 'shift/ddm-20261001-1000', change: 'ddm', ahead: 1, dirty: 1 }]);
});
test('renderAutoHandoff day: прогресс по ветке, порядок по приоритету, несданное — не трогать', () => {
  const { dir, p } = projectWithChange();
  git(dir, 'branch', 'shift/ddm-20261001-1000', 'change/ddm');
  git(dir, 'checkout', '-q', 'shift/ddm-20261001-1000'); git(dir, 'commit', '-q', '--allow-empty', '-m', 'wip(ddm): x'); git(dir, 'checkout', '-q', 'main');
  const text = renderAutoHandoff(p, 'day', new Date(2026, 9, 1, 2, 0));
  assert.deepEqual(validateHandoff(text), []);
  assert.match(text, /^# Смена: день → ночь, 2026-10-01 02:00 \(источник: авто\)/);
  assert.match(text, /### ddm — ветка change\/ddm @ [0-9a-f]{7}, задач 1\/2/);
  assert.match(text, /Не трогать: shift\/ddm-20261001-1000 — не сдано днём \(коммитов 1\), не повторять эту работу/);
  assert.match(text, /## Порядок\n1\. ddm/);
});
test('renderAutoHandoff night: шапка ночь → день, ссылки на прогоны, «Предложение на день»', () => {
  const { p } = projectWithChange();
  const text = renderAutoHandoff(p, 'night', new Date(2026, 9, 2, 6, 40), { runs: ['20261002-0200', '20261002-0600'] });
  assert.deepEqual(validateHandoff(text), []);
  assert.match(text, /^# Смена: ночь → день, 2026-10-02 06:40 \(источник: авто\)\nПрогоны: runs\/20261002-0200, runs\/20261002-0600/);
  assert.match(text, /## Предложение на день\n1\. ddm/);
});

test('0.5.1: validateHandoff строг к заголовкам разделов — «## Порядок на ночь» не считается', () => {
  assert.deepEqual(validateHandoff(HANDOFF.replace('## Порядок', '## Порядок на ночь')), ['## Порядок или ## Предложение на день']);
});
test('0.5.1: дневной и ночной файл одной минуты — ночной считается позже', () => {
  const p = paths(bareProject()); const t = new Date(2026, 9, 1, 6, 0);
  writeShift(p, 'night', 'н', t); writeShift(p, 'day', 'д', t);
  assert.deepEqual(listShifts(p).map((s) => s.kind), ['day', 'night']);
  assert.equal(activeDayHandoff(p), null);
});
test('0.5.1: авто-передача называет несданные ветки shift/* и у изменений вне работы', () => {
  const { dir, p } = projectWithChange();
  git(dir, 'branch', 'change/other', 'main'); git(dir, 'branch', 'shift/other-20261001-1000', 'change/other');
  git(dir, 'checkout', '-q', 'shift/other-20261001-1000'); git(dir, 'commit', '-q', '--allow-empty', '-m', 'wip(other): x'); git(dir, 'checkout', '-q', 'main');
  assert.match(renderAutoHandoff(p, 'day', new Date(2026, 9, 1, 2, 0)), /## Заметки\n(.*\n)*- Не трогать: shift\/other-20261001-1000 — не сдано днём \(коммитов 1\)/);
});
