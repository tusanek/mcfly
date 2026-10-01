# Передача смены день ↔ ночь — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** дневная сессия «сдаёт смену» файлом в `mcfly/shifts/`, ночь работает по нему (или по авто-передаче) и утром оставляет ответную передачу; сводка показывает предложение на день.

**Architecture:** два новых модуля без побочных эффектов наружу — `shift-files.js` (имена, поиск, проверка формата, авто-передача) и `shift-git.js` (`start`, `merge`, `write`: действия с git). CLI `mcfly shift …` их вызывает; runner перед ночным прогоном подкладывает авто-передачу и в последнем слоте ночи — ночную; контекст лида начинается с действующей передачи; сводка берёт «Предложение на день». Навыки плагина `take-shift` и `hand-shift` — текст, механика в CLI.

**Tech Stack:** Node 24 ESM, `node:test`, git через `spawnSync` (как в `src/git.js`), YAML не нужен.

**Spec:** `docs/superpowers/specs/2026-09-30-shift-handoff-design.md` (одобрена владельцем 2026-10-01).

## Global Constraints

- Каталог `mcfly/shifts/`; имена `ГГГГММДД-ЧЧММ-day.md` и `ГГГГММДД-ЧЧММ-night.md`; файлы не переписываются (при совпадении минуты — суффикс `-2`, `-3`: `20261001-1830-day-2.md`).
- Обязательные заголовки: `# Смена:`, `## Изменения`, `## Порядок` или `## Предложение на день`, `## Нужны решения человека`, `## Заметки`.
- Ветка дневной работы: `shift/<изменение>-ГГГГММДД-ЧЧММ`, ответвлена от `change/<изменение>`.
- Слияние в `change/<имя>` только fast-forward; без `rebase` и `--force`; конфликт → `git merge --abort` и отказ.
- Есть живой `mcfly/.lock` → `start`, `merge`, `write` отказывают.
- Ночная передача — только в последнем слоте из `schedule.slots`; авто-передачи пишет только ночной режим.
- Тесты без сети, git во временных репозиториях (`gitRepo`, `changeBranch` из `test/helpers.js`), Telegram — подменённая функция `notify`.
- Версия 0.5.0 в `CHANGELOG.md`, `package.json`, `package-lock.json`, `.claude-plugin/plugin.json`.

## Review Focus

- Сдача смены запущена в основном рабочем дереве проекта (не в worktree сессии) — `start` и `merge` должны отказать, иначе переключат main. Тест в Task 3.
- Ветка `change/<имя>` не выведена ни в один worktree — fast-forward через `git fetch . <src>:<dst>`, без checkout. Тест в Task 4.
- В ветке сессии нет новых коммитов — `merge` сообщает «нечего вливать» и не падает. Тест в Task 4.
- Две сдачи смены в одну минуту — второй файл получает суффикс, первый не перезаписан. Тест в Task 1.
- Огромная передача (ручной текст на десятки КБ) — в контекст лида идёт не больше 6000 символов с пометкой об обрезке. Тест в Task 7.

---

## Карта файлов

- Create `src/shift-files.js` — имена файлов смен, список и «последний», действующая дневная передача, проверка формата, упомянутые изменения, текст авто-передачи.
- Create `src/shift-git.js` — `mainCheckout`, `shiftStart`, `shiftMerge`, `shiftWrite`.
- Modify `src/state.js` — путь `p.shifts`.
- Modify `src/init.js` — создавать `mcfly/shifts/`.
- Modify `src/git.js` — `shiftBranches(projectDir)`.
- Modify `src/cli.js` — `mcfly shift start|merge|write|auto`.
- Modify `src/runner.js` — авто-передача до ночного прогона, ночная после последнего слота, `mcfly/shifts` в служебных путях.
- Modify `src/context.js` — блок передачи первым.
- Modify `src/prompt.js`, `prompts/run.md` — указание лиду и репортёру про передачу.
- Modify `src/summary.js` — блок «🌅 Предложение на день».
- Create `skills/take-shift/SKILL.md`, `skills/hand-shift/SKILL.md`; Modify `agents/reporter.md`.
- Tests: `test/shift-files.test.js`, `test/shift-git.test.js`, правки `test/runner.test.js`, `test/context.test.js`, `test/summary.test.js`, `test/cli.test.js`, `test/init.test.js`.

---

### Task 1: Файлы смен — имена, поиск, проверка формата

**Files:**
- Create: `src/shift-files.js`
- Modify: `src/state.js` (добавить `shifts`), `src/init.js:38`
- Test: `test/shift-files.test.js`, `test/init.test.js`

**Interfaces:**
- Produces:
  - `shiftFileName(kind: 'day'|'night', now: Date): string` → `'20261001-1830-day.md'`
  - `listShifts(p): Array<{ file: string, path: string, kind: 'day'|'night', at: string }>` — по возрастанию имени
  - `latestShift(p, kind): { file, path, kind, at } | null`
  - `activeDayHandoff(p): { file, path, text } | null` — последний `-day` новее последнего `-night`
  - `validateHandoff(text): string[]` — недостающие заголовки
  - `mentionedChanges(text): string[]` — имена из `### <имя> —` и из нумерованных строк раздела «Порядок»/«Предложение на день»
  - `writeShift(p, kind, text, now): string` — путь записанного файла (без перезаписи)
  - `p.shifts` = `<projectDir>/mcfly/shifts`

- [ ] **Step 1: Write the failing test** — `test/shift-files.test.js`

```js
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
```

В `test/init.test.js` добавить в существующий тест `init` (после проверки `mcfly/runs`):

```js
  assert.ok(fs.existsSync(path.join(dir, 'mcfly', 'shifts')), 'init создаёт mcfly/shifts');
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/shift-files.test.js test/init.test.js`
Expected: FAIL — `Cannot find module '../src/shift-files.js'`.

- [ ] **Step 3: Write minimal implementation**

`src/state.js` — в объект `paths` после `logs`:

```js
    shifts: path.join(root, 'shifts'),
```

`src/init.js:38`:

```js
  ensureDir(p.runs); ensureDir(p.logs); ensureDir(p.shifts);
```

`src/shift-files.js`:

```js
import fs from 'node:fs';
import path from 'node:path';
import { readText, writeText, pad2 } from './util.js';

const NAME = /^(\d{8}-\d{4})-(day|night)(?:-(\d+))?\.md$/;
export const REQUIRED = ['# Смена:', '## Изменения', ['## Порядок', '## Предложение на день'], '## Нужны решения человека', '## Заметки'];

export function shiftFileName(kind, now) {
  return `${now.getFullYear()}${pad2(now.getMonth() + 1)}${pad2(now.getDate())}-${pad2(now.getHours())}${pad2(now.getMinutes())}-${kind}.md`;
}
/** Файлы смен по возрастанию времени (суффикс -2, -3 — позже основного). */
export function listShifts(p) {
  let files = [];
  try { files = fs.readdirSync(p.shifts); } catch { return []; }
  return files.map((file) => ({ file, m: NAME.exec(file) })).filter((x) => x.m)
    .map(({ file, m }) => ({ file, path: path.join(p.shifts, file), kind: m[2], at: m[1], n: Number(m[3] || 1) }))
    .sort((a, b) => (a.at === b.at ? a.n - b.n : a.at < b.at ? -1 : 1))
    .map(({ n, ...s }) => s);
}
export function latestShift(p, kind) { return listShifts(p).filter((s) => s.kind === kind).at(-1) || null; }
/** Действующая дневная передача: последняя дневная, если она позже последней ночной. */
export function activeDayHandoff(p) {
  const all = listShifts(p);
  const last = all.at(-1);
  if (!last || last.kind !== 'day') return null;
  return { file: last.file, path: last.path, text: readText(last.path, '') };
}
export function validateHandoff(text) {
  const lines = String(text || '').split('\n').map((l) => l.trim());
  const has = (h) => lines.some((l) => l === h || l.startsWith(`${h} `) || (h.endsWith(':') && l.startsWith(h)));
  return REQUIRED.filter((h) => (Array.isArray(h) ? !h.some(has) : !has(h))).map((h) => (Array.isArray(h) ? h.join(' или ') : h));
}
/** Имена изменений: заголовки «### <имя> — …» и строки «1. <имя>» в разделе порядка. */
export function mentionedChanges(text) {
  const names = []; let inOrder = false;
  for (const line of String(text || '').split('\n')) {
    const h3 = /^###\s+([\w.-]+)\s+—/.exec(line);
    if (h3) names.push(h3[1]);
    if (/^##\s/.test(line)) inOrder = /^##\s+(Порядок|Предложение на день)\b/.test(line);
    const item = inOrder && /^\s*\d+\.\s+([\w.-]+)/.exec(line);
    if (item) names.push(item[1]);
  }
  return [...new Set(names)];
}
/** Пишет файл смены, не перезаписывая: занято — суффикс -2, -3. */
export function writeShift(p, kind, text, now) {
  const base = shiftFileName(kind, now).replace(/\.md$/, '');
  for (let n = 1; ; n++) {
    const file = path.join(p.shifts, `${base}${n > 1 ? `-${n}` : ''}.md`);
    if (!fs.existsSync(file)) { writeText(file, text); return file; }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/shift-files.test.js test/init.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/shift-files.js src/state.js src/init.js test/shift-files.test.js test/init.test.js
git commit -m "feat(shift): файлы смен — имена, поиск, действующая дневная передача, проверка формата"
```

---

### Task 2: Авто-передача по веткам и worktree

**Files:**
- Modify: `src/git.js` (добавить `shiftBranches`), `src/shift-files.js` (добавить `renderAutoHandoff`)
- Test: `test/shift-files.test.js`

**Interfaces:**
- Consumes: `branchProgress(projectDir, name)`, `teamWorktrees(projectDir)` из `src/git.js`; `listChanges`, `priorityOf` из `src/approvals.js`; `writeShift` из Task 1.
- Produces:
  - `shiftBranches(projectDir): Array<{ branch: string, change: string, ahead: number, dirty: number }>` — ветки `shift/<имя>-…`, число коммитов, которых нет в `change/<имя>`, и незакоммиченные файлы в их worktree.
  - `renderAutoHandoff(p, kind: 'day'|'night', now: Date, { runs = [] } = {}): string` — текст в формате передачи с `(источник: авто)`; `runs` — id прогонов ночи для ночной шапки.

- [ ] **Step 1: Write the failing test** — добавить в `test/shift-files.test.js`

```js
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/shift-files.test.js`
Expected: FAIL — `shiftBranches` / `renderAutoHandoff` не экспортированы.

- [ ] **Step 3: Write minimal implementation**

`src/git.js` — в конец:

```js
/** Дневная работа: ветки shift/<изменение>-…, коммиты сверх change/<изменение> и незакоммиченное в их worktree. */
export function shiftBranches(projectDir) {
  const out = git(projectDir, ['branch', '--list', 'shift/*', '--format=%(refname:short)']);
  if (!out) return [];
  const wts = teamWorktrees(projectDir);
  return out.split('\n').filter(Boolean).map((branch) => {
    const change = /^shift\/(.+)-\d{8}-\d{4}$/.exec(branch)?.[1] || '';
    const ahead = Number((git(projectDir, ['rev-list', '--count', `change/${change}..${branch}`]) || '0').trim());
    const wt = wts.find((w) => w.branch === branch);
    return { branch, change, ahead, dirty: wt ? wt.dirty : 0 };
  });
}
/** Короткий sha ветки или null. */
export function branchSha(projectDir, branch) { return git(projectDir, ['rev-parse', '--short=7', branch])?.trim() || null; }
```

`src/shift-files.js` — в конец (импорты добавить в начало файла: `import { branchProgress, teamWorktrees, shiftBranches, branchSha } from './git.js';`, `import { listChanges, priorityOf } from './approvals.js';`, `import { fmtLocal } from './util.js';`):

```js
/** Авто-передача по фактам: одобренные изменения с прогрессом по веткам, грязные worktree команды, несданная дневная работа. */
export function renderAutoHandoff(p, kind, now, { runs = [] } = {}) {
  const approved = listChanges(p.openspecChanges).filter((c) => c.mcfly.approval === 'approved' && c.tasksOpen + c.tasksDone > 0)
    .sort((a, b) => priorityOf(a) - priorityOf(b));
  const team = teamWorktrees(p.projectDir);
  const shifts = shiftBranches(p.projectDir);
  const L = [`# Смена: ${kind === 'day' ? 'день → ночь' : 'ночь → день'}, ${fmtLocal(now)} (источник: авто)`];
  if (kind === 'night' && runs.length) L.push(`Прогоны: ${runs.map((id) => `runs/${id}`).join(', ')}`);
  L.push('## Изменения');
  const active = approved.filter((c) => { const b = branchProgress(p.projectDir, c.name); return (b ? b.open : c.tasksOpen) > 0; });
  for (const c of active) {
    const b = branchProgress(p.projectDir, c.name);
    const x = b || { done: c.tasksDone, open: c.tasksOpen };
    const sha = b ? branchSha(p.projectDir, `change/${c.name}`) : null;
    L.push(`### ${c.name} — ${b ? `ветка change/${c.name} @ ${sha}` : 'ветки нет'}, задач ${x.done}/${x.done + x.open}`);
    const dirty = team.filter((w) => w.branch === `change/${c.name}` && w.dirty > 0);
    L.push(`- Где остановились: ${dirty.length ? `незакоммиченное в ${dirty.map((w) => `${w.path} (${w.dirty})`).join(', ')}` : 'по tasks.md ветки — первая задача без [x]'}`);
    for (const s of shifts.filter((s) => s.change === c.name && (s.ahead > 0 || s.dirty > 0))) {
      L.push(`- Не трогать: ${s.branch} — не сдано днём (коммитов ${s.ahead}${s.dirty ? `, незакоммиченных файлов ${s.dirty}` : ''}), не повторять эту работу`);
    }
  }
  if (!active.length) L.push('- одобренных изменений с открытыми задачами нет');
  L.push(kind === 'day' ? '## Порядок' : '## Предложение на день');
  L.push(...(active.length ? active.map((c, i) => `${i + 1}. ${c.name}`) : ['- нет']));
  L.push('## Нужны решения человека', active.length ? '- нет' : '- одобрить следующее изменение', '## Заметки', '- передача собрана автоматически: смену не сдавали');
  return L.join('\n') + '\n';
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/shift-files.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/git.js src/shift-files.js test/shift-files.test.js
git commit -m "feat(shift): авто-передача по веткам change/*, worktree и несданным веткам shift/*"
```

---

### Task 3: `shift start` — ветка дневной работы

**Files:**
- Create: `src/shift-git.js`
- Test: `test/shift-git.test.js`

**Interfaces:**
- Consumes: `currentRun(p)` из `src/runner.js`; `paths` из `src/state.js`.
- Produces:
  - `mainCheckout(dir): string` — путь основного рабочего дерева репозитория (первая запись `git worktree list --porcelain`).
  - `shiftStart({ sessionDir, change, now }): { ok: true, branch } | { ok: false, error }`

- [ ] **Step 1: Write the failing test** — `test/shift-git.test.js`

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs'; import path from 'node:path';
import { mainCheckout, shiftStart } from '../src/shift-git.js';
import { bareProject, gitRepo, git, changeBranch, tmpDir } from './helpers.js';

export function projectWithSession() {
  const dir = bareProject(); gitRepo(dir); git(dir, 'add', '.'); git(dir, 'commit', '-q', '-m', 'проект');
  changeBranch(dir, 'ddm', '- [ ] 1.1 a\n');
  const sess = path.join(tmpDir(), 'sess');
  git(dir, 'worktree', 'add', '-q', '-b', 'claude/sess', sess, 'main');
  return { dir, sess };
}
test('mainCheckout: из worktree сессии — основное дерево', () => {
  const { dir, sess } = projectWithSession();
  assert.equal(mainCheckout(sess), fs.realpathSync(dir));
});
test('shift start: ветка shift/<имя>-<время> от change/<имя> в worktree сессии', () => {
  const { dir, sess } = projectWithSession();
  const r = shiftStart({ sessionDir: sess, change: 'ddm', now: new Date(2026, 9, 1, 9, 30) });
  assert.deepEqual(r, { ok: true, branch: 'shift/ddm-20261001-0930' });
  assert.equal(git(sess, 'branch', '--show-current'), 'shift/ddm-20261001-0930');
  assert.equal(git(sess, 'rev-parse', 'HEAD'), git(dir, 'rev-parse', 'change/ddm'));
});
test('shift start: нет change/<имя> — ветка изменения создаётся от main', () => {
  const { dir, sess } = projectWithSession();
  const r = shiftStart({ sessionDir: sess, change: 'new-x', now: new Date(2026, 9, 1, 9, 30) });
  assert.equal(r.ok, true);
  assert.equal(git(dir, 'rev-parse', 'change/new-x'), git(dir, 'rev-parse', 'main'));
});
test('shift start отказывает: незакоммиченное в сессии, основное дерево, идёт прогон', () => {
  const { dir, sess } = projectWithSession();
  fs.writeFileSync(path.join(sess, 'x.txt'), 'x');
  assert.match(shiftStart({ sessionDir: sess, change: 'ddm', now: new Date() }).error, /незакоммиченн/);
  assert.match(shiftStart({ sessionDir: dir, change: 'ddm', now: new Date() }).error, /основном рабочем дереве/);
  fs.unlinkSync(path.join(sess, 'x.txt'));
  fs.writeFileSync(path.join(dir, 'mcfly', '.lock'), JSON.stringify({ pid: process.pid, at: new Date().toISOString(), id: 'r' }));
  assert.match(shiftStart({ sessionDir: sess, change: 'ddm', now: new Date() }).error, /идёт прогон/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/shift-git.test.js`
Expected: FAIL — нет модуля `src/shift-git.js`.

- [ ] **Step 3: Write minimal implementation** — `src/shift-git.js`

```js
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { paths } from './state.js';
import { currentRun } from './runner.js';
import { dirtyFiles } from './git.js';
import { shiftFileName } from './shift-files.js';

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
  const p = paths(main);
  if (currentRun(p)) return { error: 'идёт прогон команды (mcfly/.lock) — дождитесь его конца' };
  return { session, main, p };
}
export function shiftStart({ sessionDir, change, now = new Date() }) {
  const g = guard(sessionDir); if (g.error) return fail(g.error);
  if (dirtyFiles(g.session).length) return fail('в worktree сессии есть незакоммиченные изменения — закоммитьте их');
  if (!ok(g.main, ['rev-parse', '--verify', '-q', `refs/heads/change/${change}`]) && !ok(g.main, ['branch', `change/${change}`, 'main'])) {
    return fail(`не удалось создать ветку change/${change} от main`);
  }
  const branch = `shift/${change}-${shiftFileName('day', now).slice(0, 13)}`;
  const r = run(g.session, ['switch', '-q', '-c', branch, `change/${change}`]);
  return r.status === 0 ? { ok: true, branch } : fail(String(r.stderr).trim().slice(0, 200));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/shift-git.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/shift-git.js test/shift-git.test.js
git commit -m "feat(shift): shift start — ветка дневной работы от change/<изменение>"
```

---

### Task 4: `shift merge` — влить дневную работу в `change/<имя>`

**Files:**
- Modify: `src/shift-git.js`
- Test: `test/shift-git.test.js`

**Interfaces:**
- Consumes: `guard`, `mainCheckout` (Task 3); `teamWorktrees` из `src/git.js`.
- Produces: `shiftMerge({ sessionDir }): { ok: true, change, merged: boolean, message } | { ok: false, error }` — после успеха worktree сессии в detached HEAD на `change/<имя>`, ветка `shift/…` удалена.

- [ ] **Step 1: Write the failing test** — добавить в `test/shift-git.test.js`

```js
import { shiftMerge } from '../src/shift-git.js';
const commit = (dir, file, text) => { fs.writeFileSync(path.join(dir, file), text); git(dir, 'add', file); git(dir, 'commit', '-q', '-m', `feat(ddm): ${file}`); };

test('shift merge: fast-forward ветки изменения без worktree команды, ветка shift удалена', () => {
  const { dir, sess } = projectWithSession();
  shiftStart({ sessionDir: sess, change: 'ddm', now: new Date(2026, 9, 1, 9, 30) });
  commit(sess, 'a.txt', 'a');
  const head = git(sess, 'rev-parse', 'HEAD');
  const r = shiftMerge({ sessionDir: sess });
  assert.equal(r.ok, true); assert.equal(r.merged, true);
  assert.equal(git(dir, 'rev-parse', 'change/ddm'), head);
  assert.equal(git(dir, 'branch', '--list', 'shift/*'), '');
});
test('shift merge: ветка изменения выведена в worktree команды — fast-forward там', () => {
  const { dir, sess } = projectWithSession();
  const team = path.join(tmpDir(), 'team'); git(dir, 'worktree', 'add', '-q', team, 'change/ddm');
  shiftStart({ sessionDir: sess, change: 'ddm', now: new Date(2026, 9, 1, 9, 30) });
  commit(sess, 'a.txt', 'a');
  assert.equal(shiftMerge({ sessionDir: sess }).ok, true);
  assert.equal(git(team, 'rev-parse', 'HEAD'), git(dir, 'rev-parse', 'change/ddm'));
  assert.ok(fs.existsSync(path.join(team, 'a.txt')));
});
test('shift merge: change ушла вперёд — сначала влить её в сессию', () => {
  const { dir, sess } = projectWithSession();
  shiftStart({ sessionDir: sess, change: 'ddm', now: new Date(2026, 9, 1, 9, 30) });
  commit(sess, 'a.txt', 'a');
  const team = path.join(tmpDir(), 'team'); git(dir, 'worktree', 'add', '-q', team, 'change/ddm'); commit(team, 'b.txt', 'b');
  assert.equal(shiftMerge({ sessionDir: sess }).ok, true);
  assert.ok(fs.existsSync(path.join(team, 'a.txt')) && fs.existsSync(path.join(team, 'b.txt')));
});
test('shift merge: нечего вливать — сообщение, без ошибки', () => {
  const { sess } = projectWithSession();
  shiftStart({ sessionDir: sess, change: 'ddm', now: new Date(2026, 9, 1, 9, 30) });
  const r = shiftMerge({ sessionDir: sess });
  assert.equal(r.ok, true); assert.equal(r.merged, false); assert.match(r.message, /нечего вливать/);
});
test('shift merge отказывает: конфликт (merge отменён), грязный worktree команды, не ветка shift/', () => {
  const { dir, sess } = projectWithSession();
  shiftStart({ sessionDir: sess, change: 'ddm', now: new Date(2026, 9, 1, 9, 30) });
  commit(sess, 'a.txt', 'день');
  const team = path.join(tmpDir(), 'team'); git(dir, 'worktree', 'add', '-q', team, 'change/ddm'); commit(team, 'a.txt', 'ночь');
  const c = shiftMerge({ sessionDir: sess });
  assert.equal(c.ok, false); assert.match(c.error, /конфликт/);
  assert.equal(git(sess, 'status', '--porcelain'), '', 'merge отменён');
  fs.writeFileSync(path.join(team, 'dirty.txt'), 'x');
  assert.match(shiftMerge({ sessionDir: sess }).error, /незакоммиченн/);
  git(sess, 'switch', '-q', 'claude/sess');
  assert.match(shiftMerge({ sessionDir: sess }).error, /ветк[аи] shift\//);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/shift-git.test.js`
Expected: FAIL — `shiftMerge` не экспортирован.

- [ ] **Step 3: Write minimal implementation** — добавить в `src/shift-git.js` (импорт `teamWorktrees` из `./git.js`)

```js
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/shift-git.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/shift-git.js test/shift-git.test.js
git commit -m "feat(shift): shift merge — fast-forward дневной работы в change/<изменение>, отказы при конфликте и грязном worktree"
```

---

### Task 5: `shift write` — запись передачи, коммит, журнал, Telegram

**Files:**
- Modify: `src/shift-git.js`
- Test: `test/shift-git.test.js`

**Interfaces:**
- Consumes: `validateHandoff`, `mentionedChanges`, `writeShift` (Task 1); `commitPaths` из `src/git.js`; `listChanges` из `src/approvals.js`; `appendText`, `fmtLocal`, `pad2` из `src/util.js`.
- Produces: `shiftWrite({ projectDir, text, kind = 'day', now, notify }): { ok: true, path, warnings: string[] } | { ok: false, error }`; `handoffLine(text, now): string` — строка для Telegram.

- [ ] **Step 1: Write the failing test** — добавить в `test/shift-git.test.js`

```js
import { shiftWrite, handoffLine } from '../src/shift-git.js';
import { HANDOFF } from './shift-files.test.js';
import { addChange } from './helpers.js';
import { listChanges, requestApproval, setApproval } from '../src/approvals.js';
import { paths } from '../src/state.js';

test('shift write: файл в mcfly/shifts закоммичен один, строка в журнале и в Telegram', async () => {
  const { dir } = projectWithSession();
  addChange(dir, 'llm-adaptation'); const [c] = listChanges(paths(dir).openspecChanges); requestApproval(c); setApproval(c, 'approved', 'human');
  git(dir, 'add', '.'); git(dir, 'commit', '-q', '-m', 'изменение');
  fs.writeFileSync(path.join(dir, 'чужое.txt'), 'не коммитить'); git(dir, 'add', 'чужое.txt');
  const notes = [];
  const r = await shiftWrite({ projectDir: dir, text: HANDOFF, now: new Date(2026, 9, 1, 18, 30), notify: async (t) => notes.push(t) });
  assert.equal(r.ok, true);
  assert.deepEqual(r.warnings, ['page-map-seed: не одобрено или не найдено — ночь его не тронет']);
  assert.deepEqual(git(dir, 'show', '--name-only', '--format=', 'HEAD').split('\n').sort(), ['mcfly/progress.md', 'mcfly/shifts/20261001-1830-day.md']);
  assert.match(git(dir, 'status', '--porcelain'), /^A {2}чужое\.txt$/m, 'чужой индекс не тронут');
  assert.match(fs.readFileSync(path.join(dir, 'mcfly', 'progress.md'), 'utf8'), /2026-10-01 18:30 смена сдана: llm-adaptation → page-map-seed/);
  assert.deepEqual(notes, ['🌙 Смена сдана 18:30: ночью llm-adaptation → page-map-seed; решений не ждёт']);
});
test('shift write: без обязательных заголовков не пишет и называет недостающее', async () => {
  const { dir } = projectWithSession();
  const r = await shiftWrite({ projectDir: dir, text: '# Смена: x\n', now: new Date(), notify: async () => {} });
  assert.equal(r.ok, false); assert.match(r.error, /## Изменения/);
  assert.equal(fs.existsSync(path.join(dir, 'mcfly', 'shifts')), false);
});
test('handoffLine: решения нужны — число пунктов', () => {
  const t = HANDOFF.replace('## Нужны решения человека\n- нет', '## Нужны решения человека\n- одобрить X\n- ответить на Q2');
  assert.equal(handoffLine(t, new Date(2026, 9, 1, 18, 30)), '🌙 Смена сдана 18:30: ночью llm-adaptation → page-map-seed; ждёт ваших решений: 2');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/shift-git.test.js`
Expected: FAIL — `shiftWrite` не экспортирован.

- [ ] **Step 3: Write minimal implementation** — добавить в `src/shift-git.js` (импорты: `path` из `node:path`; `validateHandoff, mentionedChanges, writeShift` из `./shift-files.js`; `commitPaths` из `./git.js`; `listChanges` из `./approvals.js`; `appendText, fmtLocal, pad2` из `./util.js`)

```js
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
export function handoffLine(text, now) {
  const { order, decisions } = handoffFacts(text);
  return `🌙 Смена сдана ${pad2(now.getHours())}:${pad2(now.getMinutes())}: ${order.length ? `ночью ${order.join(' → ')}` : 'одобренной работы на ночь нет'}; ${decisions.length ? `ждёт ваших решений: ${decisions.length}` : 'решений не ждёт'}`;
}
export async function shiftWrite({ projectDir, text, kind = 'day', now = new Date(), notify = null }) {
  const main = mainCheckout(projectDir); const p = paths(main);
  if (currentRun(p)) return fail('идёт прогон команды (mcfly/.lock) — дождитесь его конца');
  const missing = validateHandoff(text);
  if (missing.length) return fail(`в передаче нет разделов: ${missing.join(', ')}`);
  const approved = new Set(listChanges(p.openspecChanges).filter((c) => c.mcfly.approval === 'approved').map((c) => c.name));
  const warnings = mentionedChanges(text).filter((n) => !approved.has(n)).map((n) => `${n}: не одобрено или не найдено — ночь его не тронет`);
  const file = writeShift(p, kind, text, now);
  appendText(p.progress, `- ${fmtLocal(now)} смена сдана: ${handoffFacts(text).order.join(' → ') || 'работы на ночь нет'} (${path.basename(file)})\n`);
  const rel = (f) => path.relative(main, f);
  run(main, ['add', '--', rel(file)]); // новый файл должен стать отслеживаемым для commit --only
  const c = commitPaths(main, [rel(file), rel(p.progress)], `chore(mcfly): смена сдана — ${path.basename(file)}`);
  if (!c.ok) return fail(`файл записан, но не закоммичен: ${c.error}`);
  if (notify) { try { await notify(handoffLine(text, now)); } catch (e) { warnings.push(`Telegram: ${e.message}`); } }
  return { ok: true, path: file, warnings };
}
```

Примечание для исполнителя: `git add` нового файла добавляет его в индекс, а `commit --only` коммитит только перечисленные пути — чужой индекс (`чужое.txt`) остаётся как был; тест это проверяет.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/shift-git.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/shift-git.js test/shift-git.test.js
git commit -m "feat(shift): shift write — проверка формата, коммит только файла смены и журнала, строка в Telegram"
```

---

### Task 6: CLI `mcfly shift start|merge|write|auto`

**Files:**
- Modify: `src/cli.js` (HELP, `parseArgs` options: `file: { type: 'string' }`, ветка `case 'shift'`)
- Test: `test/cli.test.js`

**Interfaces:**
- Consumes: `shiftStart`, `shiftMerge`, `shiftWrite` (Tasks 3–5); `renderAutoHandoff`, `writeShift` (Tasks 1–2); `telegramNotifier` из `src/runner.js`.
- Produces: команды
  - `mcfly shift start <изменение>` — из worktree сессии (cwd);
  - `mcfly shift merge` — из worktree сессии;
  - `mcfly shift write --file <путь>` (или текст из stdin, если `--file` нет) — в основное дерево;
  - `mcfly shift auto [--kind day|night]` — печатает авто-передачу, ничего не пишет (для проверки и навыка).
  Код выхода 1 при `ok: false`, сообщение об ошибке — в stderr.

- [ ] **Step 1: Write the failing test** — добавить в `test/cli.test.js`

```js
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
```

(`changeBranch`, `git`, `gitRepo` уже импортированы в `test/cli.test.js`.)

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/cli.test.js`
Expected: FAIL — неизвестная команда `shift`.

- [ ] **Step 3: Write minimal implementation** — `src/cli.js`

В HELP после строки `approval list`:

```
  shift start <изменение> | shift merge           дневная работа в ветке shift/<изменение>-… и её слияние в change/<изменение>
  shift write [--file <путь>] | shift auto [--kind day|night]   записать передачу смены / показать авто-передачу
```

В `parseArgs` options добавить `file: { type: 'string' }, kind: { type: 'string' }`.

`shift start`/`merge` работают из любого worktree, поэтому ветку `shift` обработать **до** проверки `isMcflyProject(p)` по `projectDir` сессии: основное дерево находится через `mainCheckout`. Вставить перед строкой `if (!isMcflyProject(p)) …`:

```js
  if (cmd === 'shift') {
    const { shiftStart, shiftMerge, shiftWrite, mainCheckout } = await import('./shift-git.js');
    const { renderAutoHandoff } = await import('./shift-files.js');
    const main = mainCheckout(projectDir); const mp = paths(main);
    if (!isMcflyProject(mp)) { console.error(`Это не проект mcfly: нет ${mp.config}.`); return 1; }
    loadEnv(main); const mcfg = loadConfig(mp.config); const at = new Date();
    const done = (r, text) => { if (!r.ok) { console.error(r.error); return 1; } log(text); for (const w of r.warnings || []) log(`⚠ ${w}`); return 0; };
    if (sub === 'start') { const r = shiftStart({ sessionDir: projectDir, change: rest[0], now: at }); return done(r, r.ok ? `Ветка дневной работы: ${r.branch}` : ''); }
    if (sub === 'merge') { const r = shiftMerge({ sessionDir: projectDir }); return done(r, r.message); }
    if (sub === 'write') {
      const text = values.file ? readText(values.file, '') : fs.readFileSync(0, 'utf8');
      const { telegramNotifier } = await import('./runner.js');
      const r = await shiftWrite({ projectDir: main, text, now: at, notify: telegramNotifier(mcfg) });
      return done(r, r.ok ? `Передача записана: ${path.relative(main, r.path)}` : '');
    }
    if (sub === 'auto') { log(renderAutoHandoff(mp, values.kind === 'night' ? 'night' : 'day', at)); return 0; }
    console.error('mcfly shift start <изменение> | merge | write [--file] | auto [--kind]'); return 1;
  }
```

В импорты `src/cli.js` добавить `import fs from 'node:fs';`.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/cli.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/cli.js test/cli.test.js
git commit -m "feat(shift): команды mcfly shift start|merge|write|auto"
```

---

### Task 7: Runner и лид — авто-передача до ночи, передача в контексте, ночная передача в последнем слоте

**Files:**
- Modify: `src/runner.js` (`STATE_PATHS`, до прогона, после прогона), `src/context.js`, `src/prompt.js`, `prompts/run.md`
- Test: `test/runner.test.js`, `test/context.test.js`

**Interfaces:**
- Consumes: `activeDayHandoff`, `latestShift`, `listShifts`, `renderAutoHandoff`, `writeShift`, `validateHandoff` (Tasks 1–2).
- Produces:
  - `buildContext(p, cfg)` — первый блок «## Передача смены» (или «Передачи смены нет»), не длиннее 6000 символов текста передачи.
  - Переменная промпта `{{NIGHT_HANDOFF}}` — указание репортёру записать `mcfly/shifts/<имя>-night.md` (только в последнем слоте ночи), иначе пусто.
  - Прогон ночью без действующей дневной передачи пишет авто-передачу `-day.md` до запуска claude; после прогона последнего слота, если ночного файла нет, — авто `-night.md`.

- [ ] **Step 1: Write the failing test**

`test/context.test.js` — добавить:

```js
import { writeShift } from '../src/shift-files.js';
test('buildContext: действующая передача — первым блоком; нарушенный формат помечен; длинная обрезана', () => {
  const dir = bareProject(); const p = paths(dir);
  writeShift(p, 'day', '# Смена: день → ночь\nтолько шапка', new Date(2026, 9, 1, 18, 30));
  const ctx = buildContext(p, cfg);
  assert.match(ctx, /^## Передача смены \(mcfly\/shifts\/20261001-1830-day\.md\) — действуй по ней в рамках одобренного/);
  assert.match(ctx, /формат нарушен: нет разделов ## Изменения/);
  writeShift(p, 'day', '# Смена:\n## Изменения\n## Порядок\n## Нужны решения человека\n## Заметки\n' + 'x'.repeat(10000), new Date(2026, 9, 1, 19, 0));
  const long = buildContext(p, cfg);
  assert.match(long, /…передача обрезана, полный текст — в файле/);
  assert.ok(long.length < 10000);
});
test('buildContext: без действующей передачи — строка об этом', () => {
  assert.match(buildContext(paths(bareProject()), cfg), /^## Передача смены: нет — работай по приоритетам одобрений/);
});
```

`test/runner.test.js` — добавить:

```js
import { listShifts } from '../src/shift-files.js';
test('ночной прогон без сданной смены пишет авто-передачу до запуска claude', async () => {
  const dir = bareProject(); const p = paths(dir);
  const { envFile } = fakeClaude(dir, { lines: [resultEvent()] });
  await run({ projectDir: dir, mode: 'night', now: new Date(2026, 8, 29, 0, 5), log: () => {}, sleep: async () => {}, notify: async () => {} });
  const shifts = listShifts(p);
  assert.equal(shifts[0].kind, 'day');
  assert.match(fs.readFileSync(shifts[0].path, 'utf8'), /\(источник: авто\)/);
  assert.match(fs.readFileSync(path.join(p.runs, fs.readdirSync(p.runs)[0], 'prompt.md'), 'utf8'), /## Передача смены \(mcfly\/shifts\/.*-day\.md\)/);
});
test('ночь: прогон не последнего слота ночную передачу не пишет; последний слот без отчёта — авто -night.md', async () => {
  const dir = bareProject(); const p = paths(dir);
  fakeClaude(dir, { lines: [resultEvent()] }); // слоты по умолчанию 00:00 и 04:00
  await run({ projectDir: dir, mode: 'night', now: new Date(2026, 8, 29, 0, 5), log: () => {}, sleep: async () => {}, notify: async () => {} });
  assert.deepEqual(listShifts(p).map((s) => s.kind), ['day']);
  await run({ projectDir: dir, mode: 'night', now: new Date(2026, 8, 29, 4, 5), log: () => {}, sleep: async () => {}, notify: async () => {} });
  assert.deepEqual(listShifts(p).map((s) => s.kind), ['day', 'night'], '04:00 видит ту же дневную, после него — ночная');
  assert.match(fs.readFileSync(listShifts(p)[1].path, 'utf8'), /^# Смена: ночь → день, .*\(источник: авто\)\nПрогоны: runs\/20260929-0005, runs\/20260929-0405/);
});
test('дневной прогон авто-передач не пишет', async () => {
  const dir = bareProject(); const p = paths(dir);
  fakeClaude(dir, { lines: [resultEvent()] });
  await run({ projectDir: dir, mode: 'day', log: () => {}, sleep: async () => {}, notify: async () => {} });
  assert.deepEqual(listShifts(p), []);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/context.test.js test/runner.test.js`
Expected: FAIL — нет блока передачи, нет файлов смен.

- [ ] **Step 3: Write minimal implementation**

`src/context.js` — импорт `import { activeDayHandoff, validateHandoff } from './shift-files.js';`, в начало `buildContext` (до `L.push(\`Проект: …\`)`):

```js
  const H_LIMIT = 6000;
  const h = activeDayHandoff(p);
  if (h) {
    const missing = validateHandoff(h.text);
    L.push(`## Передача смены (mcfly/shifts/${h.file}) — действуй по ней в рамках одобренного: неодобренное не трогай, при расхождении правы одобрения и спецификации${missing.length ? `; формат нарушен: нет разделов ${missing.join(', ')}` : ''}`);
    L.push(h.text.length > H_LIMIT ? `${h.text.slice(0, H_LIMIT)}\n…передача обрезана, полный текст — в файле` : h.text.trim(), '');
  } else L.push('## Передача смены: нет — работай по приоритетам одобрений', '');
```

`src/prompt.js` — `buildLeadPrompt` принимает `nightHandoff = ''` и передаёт `NIGHT_HANDOFF: nightHandoff`.

`prompts/run.md`:
- в шаге 0 первой фразой: «Если в контексте есть «Передача смены» — начни с её раздела «Где остановились» и иди в порядке из «Порядок»; ветки `shift/*`, помеченные «не сдано днём», не трогай.»
- в шаге 6 после «пишет {{RUN_DIR}}/summary.md»: ` {{NIGHT_HANDOFF}}`

`src/runner.js`:
- импорт: `import { activeDayHandoff, latestShift, listShifts, renderAutoHandoff, writeShift } from './shift-files.js';`
- `STATE_PATHS` — добавить `'mcfly/shifts'`.
- после захвата лока, в блоке `if (!dryRun) { … }` перед построением промпта:

```js
      // Ночь без сданной смены — авто-передача по фактам (день работал, но смену не сдал).
      if (mode === 'night' && !activeDayHandoff(p)) writeShift(p, 'day', renderAutoHandoff(p, 'day', now), now);
```

- последний слот ночи и указание репортёру:

```js
    const lastSlot = mode === 'night' && slot === cfg.schedule.slots.at(-1);
    const nightFile = lastSlot ? `mcfly/shifts/${shiftFileName('night', now)}` : '';
    const nightHandoff = lastSlot ? `Это последний прогон ночи: репортёр также пишет ${nightFile} — передачу «ночь → день» по формату скилла mcfly-process (раздел «Передача смены»), со ссылками на прогоны ночи.` : '';
    const prompt = buildLeadPrompt({ cfg, p, runId: id, mode, deadline, context: buildContext(p, cfg), nightHandoff });
```

(импорт `shiftFileName` из `./shift-files.js`.)

- после `recordRun(p, record);` и перед `commitRunState(...)`:

```js
    // Последний слот ночи: репортёр не оставил ночную передачу — собрать по фактам.
    if (lastSlot) {
      const night = latestShift(p, 'night'); const day = latestShift(p, 'day');
      if (!night || (day && night.at < day.at)) {
        const since = day ? day.at : '';
        const runs = readMetrics(p).filter((r) => r.type === 'run' && r.mode === 'night' && r.id >= since.replace(/-\d{4}$/, '') ).map((r) => r.id);
        writeShift(p, 'night', renderAutoHandoff(p, 'night', new Date(), { runs }), new Date());
      }
    }
```

(импорт `readMetrics` из `./metrics.js`. Прогоны ночи — записи `mode: 'night'` начиная с даты действующей дневной передачи; тест проверяет оба id.)

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/context.test.js test/runner.test.js && npm test`
Expected: PASS, весь набор зелёный.

- [ ] **Step 5: Commit**

```bash
git add src/runner.js src/context.js src/prompt.js prompts/run.md test/runner.test.js test/context.test.js
git commit -m "feat(shift): runner — авто-передача до ночи, передача первым блоком контекста, ночная передача в последнем слоте"
```

---

### Task 8: Сводка — «Предложение на день»

**Files:**
- Modify: `src/summary.js`
- Test: `test/summary.test.js`

**Interfaces:**
- Consumes: `latestShift` (Task 1); `escHtml`, `inline` (уже в `src/summary.js`).
- Produces: после строки «🗓 Следующий прогон» — блок `<b>🌅 Предложение на день</b>` (до 6 строк раздела «Предложение на день» последнего `-night.md`, если он новее `since`), и строка «⚠️ смену не сдали — ночь шла по авто-передаче», если последний `-day.md` с `(источник: авто)` и новее `since`.

- [ ] **Step 1: Write the failing test** — добавить в `test/summary.test.js`

```js
import { writeShift } from '../src/shift-files.js';
test('сводка: предложение на день из ночной передачи и пометка об авто-передаче', () => {
  const p = paths(bareProject());
  writeShift(p, 'day', '# Смена: день → ночь, x (источник: авто)\n## Изменения\n## Порядок\n## Нужны решения человека\n## Заметки\n', new Date(2026, 9, 1, 0, 0));
  writeShift(p, 'night', '# Смена: ночь → день, x (источник: команда)\n## Изменения\n## Предложение на день\n1. ddm — доделать 2.3 вместе\n2. eval после правок\n## Нужны решения человека\n- нет\n## Заметки\n- нет\n', new Date(2026, 9, 1, 6, 40));
  const html = compose(p);
  assert.match(html, /<b>🌅 Предложение на день<\/b>\n1\. ddm — доделать 2\.3 вместе\n2\. eval после правок/);
  assert.match(html, /⚠️ смену не сдали — ночь шла по авто-передаче/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/summary.test.js`
Expected: FAIL — блока нет.

- [ ] **Step 3: Write minimal implementation** — `src/summary.js`

Импорт: `import { latestShift } from './shift-files.js';`. Вспомогательная функция рядом с `reportSections`:

```js
/** Строки раздела markdown-файла смены (без пустых), не больше n. */
function shiftSection(file, title, n = 6) {
  const text = readText(file, ''); const out = []; let on = false;
  for (const line of text.split('\n')) {
    if (/^##\s/.test(line)) { on = line.replace(/^##\s+/, '').trim() === title; continue; }
    if (on && line.trim()) out.push(line.trim());
  }
  return out.slice(0, n);
}
const shiftTime = (s) => new Date(Number(s.at.slice(0, 4)), Number(s.at.slice(4, 6)) - 1, Number(s.at.slice(6, 8)), Number(s.at.slice(9, 11)), Number(s.at.slice(11, 13)));
```

В `composeSummary` сразу после `L.push('', \`<b>🗓 Следующий прогон:</b> ${next}\`);`:

```js
  const night = latestShift(p, 'night'); const day = latestShift(p, 'day');
  if (night && (!since || shiftTime(night) > since)) {
    const lines = shiftSection(night.path, 'Предложение на день');
    if (lines.length) L.push('', '<b>🌅 Предложение на день</b>', ...lines.map(inline));
  }
  if (day && (!since || shiftTime(day) > since) && /\(источник: авто\)/.test(readText(day.path, '').split('\n')[0])) L.push('⚠️ смену не сдали — ночь шла по авто-передаче');
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/summary.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/summary.js test/summary.test.js
git commit -m "feat(shift): сводка — предложение на день из ночной передачи, пометка об авто-передаче"
```

---

### Task 9: Навыки «прими смену» и «сдай смену», формат для репортёра

**Files:**
- Create: `skills/take-shift/SKILL.md`, `skills/hand-shift/SKILL.md`
- Modify: `agents/reporter.md`, `skills/mcfly-process/SKILL.md` (раздел «Передача смены» с форматом)
- Test: `test/plugin.test.js` (проверка, что навыки с frontmatter `name` и `description` существуют)

**Interfaces:**
- Consumes: CLI из Task 6.
- Produces: `/mcfly:take-shift`, `/mcfly:hand-shift`.

- [ ] **Step 1: Write the failing test** — добавить в `test/plugin.test.js`

```js
test('навыки передачи смены: take-shift и hand-shift с name и description', () => {
  for (const name of ['take-shift', 'hand-shift']) {
    const text = fs.readFileSync(path.join(MCFLY_ROOT, 'skills', name, 'SKILL.md'), 'utf8');
    assert.match(text, new RegExp(`^---\\nname: ${name}\\ndescription: .+\\n---\\n`));
    assert.match(text, /mcfly shift/);
  }
  assert.match(fs.readFileSync(path.join(MCFLY_ROOT, 'skills', 'mcfly-process', 'SKILL.md'), 'utf8'), /## Передача смены/);
});
```

(`fs`, `path`, `MCFLY_ROOT` — проверить импорты в начале `test/plugin.test.js`, добавить недостающие.)

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/plugin.test.js`
Expected: FAIL — нет файлов навыков.

- [ ] **Step 3: Write the skills**

`skills/take-shift/SKILL.md`:

```markdown
---
name: take-shift
description: Принять смену у ночной команды mcfly утром — прочитать ночную передачу, сверить с фактами и предложить план дня. Триггеры — «прими смену», «что сделала ночь», «с чего начнём день».
---
# Прими смену

1. Если `mcfly status` пишет «Идёт прогон» — скажи владельцу и ничего не меняй.
2. Прочитай последний файл `mcfly/shifts/*-night.md` (самый новый по имени). Нет такого — возьми отчёты `mcfly/runs/<id>/summary.md` за ночь.
3. Сверь с фактами: прогресс веток `git show change/<имя>:openspec/changes/<имя>/tasks.md | grep -c '^- \[x\]'`, `result.json` прогонов ночи, `mcfly status`. Расхождения назови явно.
4. Предложи план дня тремя группами: что делаем вместе сейчас; что оставляем ночи; какие решения нужны от владельца (одобрения, вопросы Qn).
5. Когда владелец выбрал изменение для совместной работы — `mcfly shift start <изменение>` в worktree этой сессии (ветка `shift/<изменение>-…` от `change/<изменение>`). Работа вне изменений идёт от main, как обычно.
```

`skills/hand-shift/SKILL.md`:

```markdown
---
name: hand-shift
description: Сдать смену ночной команде mcfly вечером — влить дневную работу в ветку изменения, записать передачу и сообщить в Telegram. Триггеры — «сдай смену», «передай ночи», «на сегодня всё».
---
# Сдай смену

Лёгкая ежедневная команда, без ревью. Не выполняется во время прогона (`mcfly status` → «Идёт прогон»).

1. Закоммить работу сессии. Красный тест — коммитом `wip(<изменение>): <что не доделано>`.
2. Если сессия работала в ветке `shift/<изменение>-…`: `mcfly shift merge`. Отказ (конфликт, грязный worktree команды) — покажи сообщение владельцу и остановись.
3. Отметь `[x]` в `tasks.md` изменения для задач, которые сделаны и зелёные (в ветке `change/<изменение>`, через worktree команды или ветку сессии до merge).
4. Приоритеты и одобрения меняй только по слову владельца: `mcfly approval set <изменение> approved --priority N`.
5. Составь передачу по формату раздела «Передача смены» скилла mcfly-process: для каждого изменения — где остановились (задача, что сделано, что красное и почему), что дальше, что не трогать; порядок; решения человека; заметки. Пиши конкретно: номера задач, файлы, тесты.
6. Сохрани текст во временный файл и выполни `mcfly shift write --file <файл>`. Ошибка формата — допиши недостающие разделы и повтори. Предупреждения о неодобренном покажи владельцу.
7. Покажи владельцу итог: что ночь будет делать и в каком порядке, какие решения от него ждут.

Если текущее пятичасовое окно квоты истекает до 02:00 — заканчивай до его сброса; напомни владельцу сдать смену, если работа ещё идёт.
```

`skills/mcfly-process/SKILL.md` — добавить в конец:

```markdown
## Передача смены
Файлы `mcfly/shifts/ГГГГММДД-ЧЧММ-day.md` (день → ночь) и `-night.md` (ночь → день). Формат:

    # Смена: день → ночь, <дата время> (источник: человек | команда | авто)
    ## Изменения
    ### <изменение> — ветка change/<изменение> @ <sha>, задач <сделано>/<всего>
    - Где остановились: …
    - Дальше: …
    - Не трогать: …
    ## Порядок            (в ночной передаче — ## Предложение на день)
    1. <изменение>
    ## Нужны решения человека
    - … или «нет»
    ## Заметки
    - …

Передача действует в рамках одобренного: неодобренное не трогать, при расхождении правы одобрения и спецификации. Ветки `shift/*` — дневная работа человека: не трогать, не повторять.
```

`agents/reporter.md` — в конец абзаца после списка разделов добавить:

```markdown
Если промпт прогона говорит, что это последний прогон ночи, запиши также передачу «ночь → день» в указанный файл `mcfly/shifts/…-night.md` по формату раздела «Передача смены» скилла mcfly-process: шапка `# Смена: ночь → день, <дата время> (источник: команда)`, следующей строкой `Прогоны: runs/<id>, …`; в «Предложении на день» — что разумно сделать человеку вместе с Claude, что оставить следующей ночи.
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/plugin.test.js && claude plugin validate .`
Expected: PASS, `✔ Validation passed`.

- [ ] **Step 5: Commit**

```bash
git add skills/take-shift skills/hand-shift skills/mcfly-process/SKILL.md agents/reporter.md test/plugin.test.js
git commit -m "feat(shift): навыки «прими смену» и «сдай смену», формат передачи для лида и репортёра"
```

---

### Task 10: Документация и версия 0.5.0

**Files:**
- Modify: `README.md`, `CHANGELOG.md`, `package.json`, `package-lock.json` (две строки `version`), `.claude-plugin/plugin.json`, `docs/superpowers/specs/2026-09-30-shift-handoff-design.md` (статус: «одобрен владельцем 2026-10-01, реализован в 0.5.0»)

- [ ] **Step 1:** CHANGELOG — раздел `## 0.5.0 — <дата>`: передача смены (файлы `mcfly/shifts/`, `mcfly shift start|merge|write|auto`, навыки `take-shift`/`hand-shift`, авто-передача до ночи, ночная передача в последнем слоте, передача первым блоком контекста лида, «Предложение на день» в сводке). README — раздел «Передача смены»: утро `/mcfly:take-shift`, вечер `/mcfly:hand-shift`, что делает ночь без сдачи.
- [ ] **Step 2:** версии `0.4.4` → `0.5.0` в четырёх местах; `grep -c '0.5.0' package.json .claude-plugin/plugin.json package-lock.json` даёт 1, 1, 2.
- [ ] **Step 3:** `npm test` (все зелёные) и `claude plugin validate .` (`✔ Validation passed`).
- [ ] **Step 4: Commit**

```bash
git add README.md CHANGELOG.md package.json package-lock.json .claude-plugin/plugin.json docs/superpowers/specs/2026-09-30-shift-handoff-design.md
git commit -m "docs: передача смены — README, CHANGELOG, версия 0.5.0"
```

---

### Task 11: emmett-brown — wrap-up через «сдай смену», каталог смен

Репозиторий продукта `~/emmett_brown`, ветка сессии, затем `git -C ~/emmett_brown merge --ff-only <ветка>` (main чистый, `mcfly/.lock` нет). Выполнять после слияния 0.5.0 в `~/mcfly`.

**Files:**
- Modify: `.claude/skills/wrap-up-eb/SKILL.md` (шаг 4 «Бриф»)
- Create: `mcfly/shifts/.gitkeep`

- [ ] **Step 1:** В `wrap-up-eb` шаг 4 — первой строкой: «Если сессия работала над изменением OpenSpec (ветка `shift/*`) — вместо брифа выполни навык `/mcfly:hand-shift`; бриф пишется только для особых задач».
- [ ] **Step 2:** `mkdir -p mcfly/shifts && touch mcfly/shifts/.gitkeep`.
- [ ] **Step 3:** Проверка: `mcfly shift auto` в `~/emmett_brown` печатает передачу с `(источник: авто)` и текущими одобренными изменениями.
- [ ] **Step 4: Commit**

```bash
git add .claude/skills/wrap-up-eb/SKILL.md mcfly/shifts/.gitkeep
git commit -m "chore(mcfly): передача смены — wrap-up через «сдай смену», каталог mcfly/shifts"
```
