import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { paths } from '../src/state.js';
import { DEFAULT_CONFIG } from '../src/config.js';
import { weeklyData } from '../src/weekly.js';
import { parseResult } from '../src/claude.js';
import { runEnv } from '../src/runner.js';

test('F32: пункт, закрытый несколькими изменениями, — одна строка недели', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcfly-f32-')); const p = paths(dir); fs.mkdirSync(p.root, { recursive: true });
  const sample = '## Как это будет выглядеть\n### Экран\n```\nПривет\n```\n';
  for (const [n, idea, body] of [[0, 'I1', ''], [1, 'I1', sample], [2, 'I1', ''], [3, 'I2', sample]]) {
    const d = path.join(p.openspecChanges, 'archive', `2026-11-1${n}-c${n}`); fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, 'proposal.md'), `## Зачем\nПольза.\n\n${body}`);
    fs.writeFileSync(path.join(d, '.openspec.yaml'), `mcfly:\n  idea: ${idea}\n`);
    fs.utimesSync(d, new Date(2026, 10, 10 + n), new Date(2026, 10, 10 + n));
  }
  fs.writeFileSync(p.ideas, JSON.stringify({ ideas: [
    { id: 'I1', title: 'Экспорт', benefit: 'Видно неделю', source: 'team', size: 'M', status: 'done' },
    { id: 'I2', title: 'Подсказка', benefit: 'Понятно', source: 'team', size: 'S', status: 'done' }] }));
  const data = weeklyData(p, { ...DEFAULT_CONFIG, project: 'demo' }, { now: new Date(2026, 10, 15, 19) });
  assert.equal(data.closed.length, 4);
  assert.deepEqual(data.items.map((i) => i.title), ['Экспорт', 'Подсказка']);
  assert.ok(data.items[0].sample, 'образец берётся из любого изменения пункта');
  assert.deepEqual(data.features.map((f) => f.title), ['Экспорт', 'Подсказка']);
});

test('F25: «spawn claude ENOENT» — повтор, как при обрыве сети', () => {
  const r = parseResult({ exitCode: -1, stdout: '', stderr: 'Error: spawn claude ENOENT', timedOut: false });
  assert.equal(r.status, 'network');
});

test('F37: лимит прогона передаётся хуку через окружение', () => {
  assert.equal(runEnv({ PATH: '/bin' }, { id: 'x', projectDir: '/p', limit: 5 }).MCFLY_MAX_CHANGES, '5');
  assert.equal(runEnv({ PATH: '/bin' }, { id: 'x', projectDir: '/p' }).MCFLY_MAX_CHANGES, undefined);
});

test('F19/F34: подсказка тестов Python из worktree — только в Python-проекте', async () => {
  const { pythonTestHint } = await import('../src/worktree.js');
  const main = fs.mkdtempSync(path.join(os.tmpdir(), 'mcfly-py-')); const wt = fs.mkdtempSync(path.join(os.tmpdir(), 'mcfly-wt-'));
  assert.equal(pythonTestHint(main, wt), '');
  fs.writeFileSync(path.join(main, 'pyproject.toml'), ''); fs.mkdirSync(path.join(main, '.venv', 'bin'), { recursive: true });
  fs.writeFileSync(path.join(main, '.venv', 'bin', 'python'), ''); fs.mkdirSync(path.join(wt, 'src'));
  const h = pythonTestHint(main, wt);
  assert.ok(h.includes(`env -C ${wt} PYTHONPATH=${path.join(wt, 'src')} ${path.join(main, '.venv', 'bin', 'python')} -m pytest`), h);
});

test('F30/F35: одобренные — по зависимостям из планов; зависимость от неодобренного — «не брать»', async () => {
  const { listChanges, approvedWithWork, dependencyOrder } = await import('../src/approvals.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcfly-dep-'));
  const mk = (name, prio, approval, proposal, tasks = '- [ ] 1.1 сделать\n') => {
    const d = path.join(dir, name); fs.mkdirSync(d);
    fs.writeFileSync(path.join(d, '.openspec.yaml'), `mcfly:\n  approval: ${approval}\n  priority: ${prio}\n`);
    fs.writeFileSync(path.join(d, 'proposal.md'), proposal); fs.writeFileSync(path.join(d, 'tasks.md'), tasks);
  };
  mk('fast-input', 81, 'approved', '## Зачем\nБыстро.\n', '## 1. Время (делается после back-button)\n- [ ] 1.1 x\n');
  mk('back-button', 87, 'approved', '## Зачем\nНазад. Упоминание fast-input без слова-маркера.\n');
  mk('add-field', 83, 'approved', 'Строится поверх изменения `context-menu`, которое ждёт одобрения.\n');
  mk('context-menu', 90, 'pending', '## Зачем\nМеню.\n');
  mk('plain', 84, 'approved', 'Ничего не ждёт.\n');
  const all = listChanges(dir);
  const order = dependencyOrder(approvedWithWork(all), all);
  assert.deepEqual(order.map((o) => o.change.name), ['back-button', 'fast-input', 'add-field', 'plain']);
  assert.deepEqual(order[1].after, ['back-button']);
  assert.deepEqual(order[2].blockedBy, ['context-menu']);
  assert.deepEqual(order[3], { ...order[3], after: [], blockedBy: [] });
});

test('F20: run.allow — узкие правила идут в claude по одному, широкие отклоняются', async () => {
  const { parseConfig } = await import('../src/config.js');
  const { buildClaudeArgs } = await import('../src/claude.js');
  const cfg = parseConfig('project: x\nrun:\n  allow: ["Bash(npm run build --prefix *)"]\n');
  const args = buildClaudeArgs({ prompt: 'P', cfg });
  assert.ok(args.includes('--allowedTools=Bash(npm run build --prefix *)'));
  assert.equal(args.at(-1), 'P');
  for (const bad of ['Bash(*)', 'Bash(npm *)', 'Edit(*)', 'Bash']) assert.throws(() => parseConfig(`project: x\nrun:\n  allow: ["${bad}"]\n`), /run\.allow/);
});

test('F40: mcfly stand — запуск сервера, адрес, остановка; без настройки — понятный отказ', async () => {
  const { DEFAULT_CONFIG } = await import('../src/config.js');
  const { standStart, standStop } = await import('../src/stand.js');
  const logsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcfly-stand-'));
  assert.match((await standStart({ cfg: DEFAULT_CONFIG, dir: logsDir, logsDir })).error, /stand\.command/);
  const port = 20000 + Math.floor(Math.random() * 20000);
  const cfg = { ...DEFAULT_CONFIG, stand: { command: `exec node -e "require('http').createServer((q,s)=>s.end('ok')).listen(process.env.PORT)"`, port, ready_seconds: 10 } };
  const r = await standStart({ cfg, dir: logsDir, logsDir });
  assert.equal(r.url, `http://localhost:${port}/`, r.error);
  assert.equal(await (await fetch(r.url)).text(), 'ok');
  assert.match((await standStart({ cfg, dir: logsDir, logsDir })).error, /уже запущен/);
  assert.equal(standStop({ logsDir }).stopped, true);
  assert.equal(standStop({ logsDir }).stopped, false);
});
