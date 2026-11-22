// 0.20.2: правка видимого, одобряемая без владельца (быстрый путь, доделка), без дельт спецификаций — отказ с подсказкой:
// после слияния openspec validate --strict и архивация падали «Change must have at least one delta».
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs'; import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { paths } from '../src/state.js';
import { listChanges } from '../src/approvals.js';
import { loadIdeas, saveIdeas, addIdea, transitionIdea } from '../src/ideas.js';
import { bareProject, addChange } from './helpers.js';

const bin = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'mcfly');
const cli = (args, dir) => spawnSync(process.execPath, [bin, ...args], { cwd: dir, encoding: 'utf8', env: { ...process.env, MCFLY_PROJECT_DIR: '', MCFLY_RUN_ID: '20261122-1200' } });
const EDIT = '# Proposal\n\n## Простыми словами\nПоправляем подсказку.\n\n## Как это будет выглядеть\nПравка существующего: ответ бота «не нашёл» — добавляем строку\n### Было\n```\nНичего не нашёл\n```\n### Стало\n```\nНичего не нашёл\nПередумали — /отмена\n```\n';
const NEWUI = '# Proposal\n\n## Как это будет выглядеть\n### Новая кнопка\n```\nГотово\n[Отменить]\n```\n';
const CONFIG = 'project: demo\nlimits:\n  followups_per_run: 3\nideas:\n  fast_sizes: [S, M]\n  fast_edits: true\n';
const delta = (dir) => { fs.mkdirSync(path.join(dir, 'specs', 'bot'), { recursive: true }); fs.writeFileSync(path.join(dir, 'specs', 'bot', 'spec.md'), '## MODIFIED Requirements\n'); };
const byName = (p) => Object.fromEntries(listChanges(p.openspecChanges).map((c) => [c.name, c]));
function setup() {
  const dir = bareProject(); const p = paths(dir); fs.writeFileSync(p.config, CONFIG);
  const data = loadIdeas(p);
  for (const [i, size] of ['S', 'S', 'M'].entries()) { const it = addIdea(data, { title: `Пункт ${i + 1}`, benefit: 'польза', source: 'team', size }); transitionIdea(data, it.id, 'taken', { actor: 'session' }); }
  saveIdeas(p, data); return { dir, p };
}

test('быстрый путь: правка существующего без дельт — отказ, пункт остаётся взятым; с дельтой — одобрено сразу', () => {
  const { dir, p } = setup(); const at = addChange(dir, 'edit', { proposal: EDIT });
  const r = cli(['approval', 'request', 'edit', '--idea', 'I1'], dir);
  assert.equal(r.status, 1); assert.match(r.stderr, /дельт спецификаций нет/); assert.match(r.stderr, /MODIFIED/);
  assert.equal(loadIdeas(p).ideas.find((x) => x.id === 'I1').status, 'taken', 'пункт не ушёл в «спланировано»');
  assert.equal(byName(p).edit.mcfly.approval, undefined, 'одобрение не запрошено');
  delta(at);
  const ok = cli(['approval', 'request', 'edit', '--idea', 'I1'], dir);
  assert.equal(ok.status, 0, ok.stderr); assert.match(ok.stdout, /Одобрено сразу: edit/);
});

test('доделка — правка видимого без дельт: отказ; с дельтой — одобрена', () => {
  const { dir, p } = setup();
  const parent = addChange(dir, 'parent'); const to = path.join(dir, 'openspec', 'changes', 'archive', '2026-11-22-parent');
  fs.mkdirSync(path.dirname(to), { recursive: true }); fs.renameSync(parent, to);
  const at = addChange(dir, 'hint', { proposal: EDIT });
  const r = cli(['approval', 'request', 'hint', '--followup', 'parent'], dir);
  assert.equal(r.status, 1); assert.match(r.stderr, /дельт спецификаций нет/);
  assert.notEqual(byName(p).hint.mcfly.approval, 'approved');
  delta(at);
  assert.equal(cli(['approval', 'request', 'hint', '--followup', 'parent'], dir).status, 0);
  assert.equal(byName(p).hint.mcfly.approval, 'approved');
});

test('план, который ждёт владельца, без дельт не отклоняется (это решает владелец и сессия)', () => {
  const { dir } = setup(); addChange(dir, 'newui', { proposal: NEWUI });
  const r = cli(['approval', 'request', 'newui', '--idea', 'I2'], dir);
  assert.equal(r.status, 0, r.stderr); assert.match(r.stdout, /Ждёт кнопки владельца/);
});
