import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs'; import path from 'node:path';
import { main } from '../src/cli.js';
import { validate, loadConfig } from '../src/config.js';
import { buildContext } from '../src/context.js';
import { paths } from '../src/state.js';
import { bareProject, gitRepo, git, tmpDir } from './helpers.js';

/** Проект в git с mcfly/config.yaml (общие папки shared), node_modules в основном каталоге и worktree агента. */
function project(shared, { withDeps = true } = {}) {
  const dir = gitRepo(bareProject());
  fs.writeFileSync(path.join(dir, 'mcfly', 'config.yaml'), `project: demo\nworktree:\n  shared: [${shared.join(', ')}]\n`);
  fs.writeFileSync(path.join(dir, '.gitignore'), 'node_modules/\n');
  git(dir, 'add', '-A'); git(dir, 'commit', '-q', '-m', 'project');
  if (withDeps) { fs.mkdirSync(path.join(dir, 'miniapp', 'node_modules', '.bin'), { recursive: true }); fs.writeFileSync(path.join(dir, 'miniapp', 'node_modules', '.bin', 'tsc'), '#!/bin/sh\n'); }
  const wt = path.join(tmpDir('wt-'), 'agent-1');
  git(dir, 'worktree', 'add', '-q', '-b', 'worktree-agent-1', wt);
  return { dir, wt };
}
const quiet = async (argv) => { const o = console.log, e = console.error; const out = []; console.log = (...a) => out.push(a.join(' ')); console.error = (...a) => out.push(a.join(' ')); try { return { code: await main(argv), out: out.join('\n') }; } finally { console.log = o; console.error = e; } };

test('0.18.0: mcfly worktree link — ссылка на зависимости основного каталога, git её не видит, повтор ничего не ломает', async () => {
  const { dir, wt } = project(['miniapp/node_modules']);
  const r = await quiet(['worktree', 'link', '--project', wt]);
  assert.equal(r.code, 0, r.out); assert.match(r.out, /Подключено: miniapp\/node_modules/);
  const link = path.join(wt, 'miniapp', 'node_modules');
  assert.ok(fs.lstatSync(link).isSymbolicLink());
  assert.ok(fs.existsSync(path.join(link, '.bin', 'tsc')));
  assert.equal(git(wt, 'status', '--porcelain'), '', 'ссылка не попадает в git, хотя .gitignore проекта — «node_modules/» с косой чертой');
  assert.match(fs.readFileSync(path.join(dir, '.git', 'info', 'exclude'), 'utf8'), /^\/miniapp\/node_modules$/m);
  const again = await quiet(['worktree', 'link', '--project', wt]);
  assert.equal(again.code, 0); assert.match(again.out, /Уже есть: miniapp\/node_modules/);
  assert.equal(fs.readFileSync(path.join(dir, '.git', 'info', 'exclude'), 'utf8').match(/\/miniapp\/node_modules/g).length, 1, 'строка исключения не дублируется');
});

test('0.18.0: нет папки в основном каталоге — код 1 и подсказка; в основном каталоге и без настройки — ничего не делает', async () => {
  const { dir, wt } = project(['miniapp/node_modules'], { withDeps: false });
  const r = await quiet(['worktree', 'link', '--project', wt]);
  assert.equal(r.code, 1); assert.match(r.out, /Нет в основном каталоге [^\n]*: miniapp\/node_modules — зависимости ставит лид или devops/);
  assert.ok(!fs.existsSync(path.join(wt, 'miniapp')));
  assert.match((await quiet(['worktree', 'link', '--project', dir])).out, /Это основной каталог проекта/);
  const plain = project([]);
  const none = await quiet(['worktree', 'link', '--project', plain.wt]);
  assert.equal(none.code, 0); assert.match(none.out, /Общих папок нет/);
});

/** Запуск из каталога cwd с MCFLY_PROJECT_DIR, как в прогоне: runner кладёт туда основной каталог. */
async function inDir(cwd, argv, env = {}) {
  const was = process.cwd(); const saved = {};
  for (const [k, v] of Object.entries(env)) { saved[k] = process.env[k]; process.env[k] = v; }
  process.chdir(cwd);
  try { return await quiet(argv); } finally {
    process.chdir(was);
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
}

test('0.18.1: в прогоне (MCFLY_PROJECT_DIR — основной каталог) из worktree агента ссылка создаётся', async () => {
  const { dir, wt } = project(['miniapp/node_modules']);
  const r = await inDir(wt, ['worktree', 'link'], { MCFLY_PROJECT_DIR: dir });
  assert.equal(r.code, 0, r.out); assert.match(r.out, /Подключено: miniapp\/node_modules/);
  assert.ok(fs.lstatSync(path.join(wt, 'miniapp', 'node_modules')).isSymbolicLink());
  assert.equal(git(wt, 'status', '--porcelain'), '');
});

test('0.18.1: --project с основным каталогом из worktree — ссылка в текущем worktree; из основного каталога — ссылки не нужны', async () => {
  const { dir, wt } = project(['miniapp/node_modules']);
  const r = await inDir(wt, ['worktree', 'link', '--project', dir], { MCFLY_PROJECT_DIR: dir });
  assert.equal(r.code, 0, r.out); assert.match(r.out, /Подключено/);
  assert.ok(fs.lstatSync(path.join(wt, 'miniapp', 'node_modules')).isSymbolicLink());
  const m = await inDir(dir, ['worktree', 'link'], { MCFLY_PROJECT_DIR: dir });
  assert.equal(m.code, 0); assert.match(m.out, /Это основной каталог проекта/);
  assert.ok(fs.lstatSync(path.join(dir, 'miniapp', 'node_modules')).isDirectory(), 'в основном каталоге папка не тронута');
});

test('0.18.0: worktree.shared проверяется при загрузке, попадает в контекст, разрешена в настройках проекта', () => {
  const dir = bareProject(); const ok = loadConfig(paths(dir).config);
  assert.deepEqual(ok.worktree.shared, []);
  assert.throws(() => validate({ ...ok, worktree: { shared: ['../x'] } }), /worktree\.shared/);
  assert.throws(() => validate({ ...ok, worktree: { shared: ['/abs'] } }), /worktree\.shared/);
  assert.throws(() => validate({ ...ok, worktree: { shared: 'node_modules' } }), /worktree\.shared/);
  assert.doesNotThrow(() => validate({ ...ok, worktree: { shared: ['miniapp/node_modules'] } }));

  assert.match(buildContext(paths(dir), { ...ok, worktree: { shared: ['miniapp/node_modules'] } }), /Общие папки \(worktree\.shared\): miniapp\/node_modules[^\n]*`mcfly worktree link`/);
  assert.doesNotMatch(buildContext(paths(dir), ok), /Общие папки/);
  const settings = JSON.parse(fs.readFileSync(new URL('../templates/settings.json', import.meta.url), 'utf8'));
  assert.ok(settings.permissions.allow.includes('Bash(mcfly worktree link)'));
});

test('0.19.3: worktree link и doctor называют папки зависимостей основного каталога, которых нет в worktree.shared', async () => {
  const { dir, wt } = project(['miniapp/node_modules']);
  fs.mkdirSync(path.join(dir, 'guide', 'node_modules', 'x'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'miniapp', 'node_modules', 'deep', 'node_modules'), { recursive: true });
  fs.mkdirSync(path.join(dir, '.venv'), { recursive: true });
  const { unsharedDeps } = await import('../src/worktree.js');
  assert.deepEqual(unsharedDeps(dir, ['miniapp/node_modules/']), ['.venv', 'guide/node_modules'], 'вложенные node_modules внутри общей папки — не в счёт');
  const r = await quiet(['worktree', 'link', '--project', wt]);
  assert.equal(r.code, 0, r.out); assert.match(r.out, /Подключено: miniapp\/node_modules/);
  assert.match(r.out, /нет в worktree\.shared: \.venv, guide\/node_modules/); assert.match(r.out, /Нужно от человека/);
  const { doctor } = await import('../src/doctor.js');
  assert.ok(doctor({ projectDir: dir, log: () => {} }).some((c) => !c.ok && /guide\/node_modules/.test(c.label)));
  fs.writeFileSync(path.join(dir, 'mcfly', 'config.yaml'), 'project: demo\nworktree:\n  shared: [miniapp/node_modules, guide/node_modules, .venv]\n');
  assert.deepEqual(unsharedDeps(dir, ['miniapp/node_modules', 'guide/node_modules', '.venv']), []);
  assert.ok(!doctor({ projectDir: dir, log: () => {} }).some((c) => /worktree\.shared/.test(c.label)));
});
