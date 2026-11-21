// 0.19.2: повторный запрос того же плана по пункту (F13) и план по пункту без дельт (F7).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs'; import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { paths } from '../src/state.js';
import { listChanges, setApproval } from '../src/approvals.js';
import { loadIdeas, saveIdeas, addIdea, transitionIdea } from '../src/ideas.js';
import { bareProject, addChange } from './helpers.js';

const bin = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'mcfly');
const cli = (args, dir) => spawnSync(process.execPath, [bin, ...args], { cwd: dir, encoding: 'utf8', env: { ...process.env, MCFLY_PROJECT_DIR: '', MCFLY_RUN_ID: '' } });
const QUIET = '# Proposal\n\n## Простыми словами\nЧиним внутреннее.\n\n## Как это будет выглядеть\nСнаружи ничего не меняется\n';
const NO_SECTION = '# Proposal\n\n## Простыми словами\nЧиним внутреннее.\n';
const VISIBLE = '# Proposal\n\n## Простыми словами\nП.\n\n## Как это будет выглядеть\n### Ответ бота\n```\nГотово\n```\n';
function take(p, n = 1) {
  const data = loadIdeas(p);
  for (let i = 0; i < n; i++) { const it = addIdea(data, { title: `Пункт ${i + 1}`, benefit: 'польза', source: 'team', size: 'L' }); transitionIdea(data, it.id, 'taken', { actor: 'session' }); }
  saveIdeas(p, data);
}
const byName = (p) => Object.fromEntries(listChanges(p.openspecChanges).map((c) => [c.name, c]));
const meta = (dir, n) => YAML.parse(fs.readFileSync(path.join(dir, 'openspec', 'changes', n, '.openspec.yaml'), 'utf8'));

test('F13: повторный запрос того же плана по тому же пункту принимается и не дублирует пункт', () => {
  const dir = bareProject(); const p = paths(dir); take(p); addChange(dir, 'plan', { proposal: VISIBLE });
  assert.equal(cli(['approval', 'request', 'plan', '--idea', 'I1'], dir).status, 0);
  const again = cli(['approval', 'request', 'plan', '--idea', 'I1'], dir);
  assert.equal(again.status, 0, again.stderr); assert.doesNotMatch(again.stderr, /не взят/);
  assert.equal(byName(p).plan.mcfly.approval, 'pending');
  const it = loadIdeas(p).ideas.find((x) => x.id === 'I1'); assert.equal(it.status, 'planned'); assert.equal(it.change, 'plan'); assert.equal(it.parts, undefined);
  // другой план по уже спланированному пункту — по-прежнему отказ с советом --part
  addChange(dir, 'other', { proposal: VISIBLE });
  const other = cli(['approval', 'request', 'other', '--idea', 'I1'], dir);
  assert.equal(other.status, 1); assert.match(other.stderr, /--part/);
});

test('F13: повторный запрос уже одобренного плана не сбрасывает одобрение; отклонённого — отказ', () => {
  const dir = bareProject(); const p = paths(dir); take(p, 2); addChange(dir, 'ok', { proposal: VISIBLE }); addChange(dir, 'no', { proposal: VISIBLE });
  cli(['approval', 'request', 'ok', '--idea', 'I1'], dir); cli(['approval', 'request', 'no', '--idea', 'I2'], dir);
  setApproval(byName(p).ok, 'approved', 'human-telegram'); setApproval(byName(p).no, 'rejected', 'human-telegram');
  const a = cli(['approval', 'request', 'ok', '--idea', 'I1'], dir);
  assert.equal(a.status, 0, a.stderr); assert.match(a.stdout, /уже одобрен/); assert.match(a.stdout, /картинки/);
  assert.equal(byName(p).ok.mcfly.approval, 'approved'); assert.equal(byName(p).ok.mcfly.by, 'human-telegram');
  const r = cli(['approval', 'request', 'no', '--idea', 'I2'], dir);
  assert.equal(r.status, 1); assert.match(r.stderr, /отклон/); assert.equal(byName(p).no.mcfly.approval, 'rejected');
});

test('F7: план по взятому пункту «Снаружи ничего не меняется» без дельт — skip_specs ставит mcfly; с дельтами и без явной строки — нет', () => {
  const dir = bareProject(); const p = paths(dir); take(p, 3);
  addChange(dir, 'tests-only', { proposal: QUIET });
  const withSpec = addChange(dir, 'with-spec', { proposal: QUIET });
  fs.mkdirSync(path.join(withSpec, 'specs', 'area'), { recursive: true }); fs.writeFileSync(path.join(withSpec, 'specs', 'area', 'spec.md'), '## MODIFIED Requirements\n');
  addChange(dir, 'silent', { proposal: NO_SECTION });
  const r = cli(['approval', 'request', 'tests-only', '--idea', 'I1'], dir);
  assert.equal(r.status, 0, r.stderr); assert.match(r.stdout, /skip_specs: true/);
  assert.equal(meta(dir, 'tests-only').skip_specs, true); assert.equal(meta(dir, 'tests-only').mcfly.approval, 'pending', 'одобряет по-прежнему владелец');
  assert.equal(cli(['approval', 'request', 'with-spec', '--idea', 'I2'], dir).status, 0);
  assert.equal(meta(dir, 'with-spec').skip_specs, undefined);
  assert.equal(cli(['approval', 'request', 'silent', '--idea', 'I3'], dir).status, 0);
  assert.equal(meta(dir, 'silent').skip_specs, undefined, 'без явной строки «Снаружи ничего не меняется» дельты не пропускаем');
});
