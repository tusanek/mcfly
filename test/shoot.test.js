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
