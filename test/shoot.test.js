// 0.20.0: снимки образцов командой mcfly — без Playwright MCP и без http-сервера.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs'; import path from 'node:path';
import { findBrowser, sampleFiles, shootFiles, CHROME } from '../src/shoot.js';
import { tmpDir } from './helpers.js';

const BROWSER = findBrowser();
const pngWidth = (file) => fs.readFileSync(file).readUInt32BE(16);
const DARK_HTML = '<!doctype html><html><head><style>:root.dark{background:#000}</style><script>if(location.search.includes("theme=dark"))document.documentElement.classList.add("dark")</script></head><body style="margin:0"><div id="shot" style="width:390px;height:120px">Образец</div></body></html>';
const PLAIN_HTML = '<!doctype html><html><body style="margin:0"><p>Экран</p></body></html>';
function samples(files) {
  const dir = tmpDir('shoot-'); const at = path.join(dir, 'design', 'samples', 'demo'); fs.mkdirSync(at, { recursive: true });
  for (const [name, html] of Object.entries(files)) fs.writeFileSync(path.join(at, name), html);
  return { dir, at };
}

test('findBrowser: настройка, затем Chrome, затем новейший Chromium Playwright', () => {
  const cache = '/h/Library/Caches/ms-playwright';
  const old = `${cache}/chromium-1200/chrome-mac/Chromium.app/Contents/MacOS/Chromium`;
  const fresh = `${cache}/chromium-1217/chrome-mac-arm64/Chromium.app/Contents/MacOS/Chromium`;
  const have = new Set(['/x/chrome', CHROME, old, fresh]);
  const list = (d) => (d === cache ? ['chromium-1200', 'chromium-1217', 'chromium_headless_shell-1217', 'ffmpeg-1011'] : d.endsWith('1200') ? ['chrome-mac'] : ['chrome-mac-arm64']);
  const exists = (p) => have.has(p) || p === cache;
  assert.equal(findBrowser({ configured: '/x/chrome', exists, home: '/h', list }), '/x/chrome');
  assert.equal(findBrowser({ exists, home: '/h', list }), CHROME);
  assert.equal(findBrowser({ exists: (p) => p !== CHROME && exists(p), home: '/h', list }), fresh, 'без Chrome — новейший chromium-*, не headless_shell');
  assert.equal(findBrowser({ configured: '/нет/такого', exists, home: '/h', list }), null, 'указанный в настройке, но несуществующий — не подменяем другим');
  assert.equal(findBrowser({ exists: () => false, home: '/h', list: () => [] }), null);
});

test('sampleFiles: NN.html по порядку, тёмная — только с theme=dark или .dark; плохое имя и пустой каталог — ошибка', () => {
  const { dir, at } = samples({ '02.html': PLAIN_HTML, '01.html': DARK_HTML, 'telegram-chat.html': DARK_HTML, '1a.html': PLAIN_HTML });
  const r = sampleFiles(dir, 'demo');
  assert.equal(r.error, undefined);
  assert.deepEqual(r.files, [
    { html: path.join(at, '01.html'), light: path.join(at, '01-light.png'), dark: path.join(at, '01-dark.png') },
    { html: path.join(at, '02.html'), light: path.join(at, '02-light.png'), dark: null },
  ]);
  assert.match(sampleFiles(dir, '../x').error, /имя изменения/);
  assert.match(sampleFiles(dir, 'absent').error, /нет образцов/);
  assert.match(sampleFiles(dir, 'missing-one').error, /нет образцов/);
});

test('shootFiles: настоящий браузер снимает #shot в 780 точек шириной; onlyMissing не трогает готовые', { skip: !BROWSER && 'нет браузера' }, async () => {
  const { dir } = samples({ '01.html': DARK_HTML, '02.html': PLAIN_HTML });
  const { files } = sampleFiles(dir, 'demo');
  const r = await shootFiles(files, { browser: BROWSER });
  assert.deepEqual(r.failed, []);
  assert.deepEqual(r.shot.map((f) => path.basename(f)), ['01-light.png', '01-dark.png', '02-light.png']);
  assert.equal(pngWidth(files[0].light), 780);
  assert.notDeepEqual(fs.readFileSync(files[0].light), fs.readFileSync(files[0].dark), 'тёмная тема — другая картинка');
  const again = await shootFiles(files, { browser: BROWSER, onlyMissing: true });
  assert.deepEqual(again.shot, []); assert.equal(again.skipped.length, 3);
});

test('shootFiles: страница, которая не грузится за timeoutMs, — failed, остальные сняты', { skip: !BROWSER && 'нет браузера' }, async () => {
  const { dir } = samples({ '01.html': PLAIN_HTML, '02.html': '<!doctype html><script>while(true){}</script>' });
  const { files } = sampleFiles(dir, 'demo');
  const r = await shootFiles(files, { browser: BROWSER, timeoutMs: 3000 });
  assert.deepEqual(r.shot.map((f) => path.basename(f)), ['01-light.png']);
  assert.equal(r.failed.length, 1); assert.match(r.failed[0].file, /02\.html$/); assert.match(r.failed[0].error, /3 с|не загрузил/);
});

test('shootFiles: браузер не запускается — каждый образец в failed с причиной', async () => {
  const { dir } = samples({ '01.html': PLAIN_HTML });
  const r = await shootFiles(sampleFiles(dir, 'demo').files, { browser: '/нет/такого/браузера', timeoutMs: 3000 });
  assert.deepEqual(r.shot, []); assert.equal(r.failed.length, 1); assert.match(r.failed[0].error, /браузер/);
});

// --- задача 2: команда, approval request, doctor, настройки ---
import { spawnSync } from 'node:child_process';
import { MCFLY_ROOT } from '../src/prompt.js';
import { bareProject, gitRepo, git, addChange } from './helpers.js';
const cli = (args, cwd) => spawnSync(process.execPath, [path.join(MCFLY_ROOT, 'bin', 'mcfly'), ...args], { cwd, encoding: 'utf8', env: { ...process.env, MCFLY_PROJECT_DIR: '', MCFLY_RUN_ID: '' } });
const putSamples = (dir, name, files) => { const at = path.join(dir, 'design', 'samples', name); fs.mkdirSync(at, { recursive: true }); for (const [n, h] of Object.entries(files)) fs.writeFileSync(path.join(at, n), h); return at; };

test('samples shoot: без имени и с плохим именем — код 1; браузер из настройки не найден — код 1 с причиной', () => {
  const dir = bareProject();
  const none = cli(['samples', 'shoot'], dir); assert.equal(none.status, 1); assert.match(none.stderr, /mcfly samples shoot <изменение>/);
  assert.equal(cli(['samples', 'shoot', '../x'], dir).status, 1);
  putSamples(dir, 'demo', { '01.html': PLAIN_HTML });
  fs.writeFileSync(path.join(dir, 'mcfly', 'config.yaml'), 'project: demo\nsamples:\n  browser: /нет/такого\n');
  const r = cli(['samples', 'shoot', 'demo'], dir); assert.equal(r.status, 1); assert.match(r.stderr, /браузер не найден/);
});

test('samples shoot из worktree — картинки в этом worktree, не в основном каталоге', { skip: !BROWSER && 'нет браузера' }, () => {
  const dir = gitRepo(bareProject()); git(dir, 'add', '-A'); git(dir, 'commit', '-q', '-m', 'p');
  const wt = path.join(tmpDir('wt-'), 'agent-1'); git(dir, 'worktree', 'add', '-q', '-b', 'worktree-agent-1', wt);
  const at = putSamples(wt, 'demo', { '01.html': DARK_HTML });
  const r = cli(['samples', 'shoot', 'demo', '--project', wt], dir);
  assert.equal(r.status, 0, r.stderr); assert.match(r.stdout, /Снято: 01-light\.png, 01-dark\.png/); assert.match(r.stdout, /Картинка:/);
  assert.ok(fs.existsSync(path.join(at, '01-light.png')));
  assert.ok(!fs.existsSync(path.join(dir, 'design', 'samples', 'demo')), 'в основном каталоге ничего не появилось');
  const here = cli(['samples', 'shoot', 'demo'], wt); assert.equal(here.status, 0, here.stderr); assert.match(here.stdout, /Снято/);
});

test('approval request снимает недостающие картинки; без браузера — предупреждение, запрос принят', { skip: !BROWSER && 'нет браузера' }, () => {
  const dir = bareProject(); addChange(dir, 'demo', { proposal: '## Простыми словами\nП.\n\n## Как это будет выглядеть\n### Ответ\n```\nГотово\n```\n' });
  const at = putSamples(dir, 'demo', { '01.html': PLAIN_HTML });
  const r = cli(['approval', 'request', 'demo'], dir);
  assert.equal(r.status, 0, r.stderr); assert.ok(fs.existsSync(path.join(at, '01-light.png'))); assert.match(r.stdout, /Снято: 01-light\.png/);
  const mtime = fs.statSync(path.join(at, '01-light.png')).mtimeMs;
  cli(['approval', 'request', 'demo'], dir); assert.equal(fs.statSync(path.join(at, '01-light.png')).mtimeMs, mtime, 'повтор не переснимает');
  const dir2 = bareProject(); addChange(dir2, 'demo', { proposal: '## Простыми словами\nП.\n' }); putSamples(dir2, 'demo', { '01.html': PLAIN_HTML });
  fs.writeFileSync(path.join(dir2, 'mcfly', 'config.yaml'), 'project: demo\nsamples:\n  browser: /нет/такого\n');
  const w = cli(['approval', 'request', 'demo'], dir2); assert.equal(w.status, 0, w.stderr); assert.match(w.stdout, /⚠ Картинки не сняты: браузер не найден/);
});

test('doctor проверяет браузер для снимков; шаблон настроек разрешает mcfly samples shoot; samples.browser — строка', async () => {
  const { doctor } = await import('../src/doctor.js'); const { parseConfig } = await import('../src/config.js');
  const dir = bareProject(); fs.writeFileSync(path.join(dir, 'mcfly', 'config.yaml'), 'project: demo\nsamples:\n  browser: /нет/такого\n');
  assert.ok(doctor({ projectDir: dir, log: () => {} }).some((c) => !c.ok && /браузер для снимков образцов/.test(c.label) && /samples\.browser/.test(c.hint)));
  assert.throws(() => parseConfig('project: x\nsamples:\n  browser: 5\n'), /samples\.browser/);
  const settings = JSON.parse(fs.readFileSync(path.join(MCFLY_ROOT, 'templates', 'settings.json'), 'utf8'));
  assert.ok(settings.permissions.allow.includes('Bash(mcfly samples shoot *)'));
});
