// 0.20.1: только светлая тема образцов — настройка samples.dark, флаг --light, запрос одобрения доснимает только указанные в плане картинки.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs'; import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { findBrowser, sampleFiles, keepReferenced } from '../src/shoot.js';
import { parseConfig } from '../src/config.js';
import { MCFLY_ROOT } from '../src/prompt.js';
import { tmpDir, bareProject, addChange } from './helpers.js';

const BROWSER = findBrowser();
const DARK_HTML = '<!doctype html><html><head><script>if(location.search.includes("theme=dark"))document.documentElement.classList.add("dark")</script></head><body style="margin:0"><div id="shot" style="width:390px;height:60px">Образец</div></body></html>';
const cli = (args, cwd) => spawnSync(process.execPath, [path.join(MCFLY_ROOT, 'bin', 'mcfly'), ...args], { cwd, encoding: 'utf8', env: { ...process.env, MCFLY_PROJECT_DIR: '', MCFLY_RUN_ID: '' } });
function put(dir, change, files) {
  const at = path.join(dir, 'design', 'samples', change); fs.mkdirSync(at, { recursive: true });
  for (const [n, html] of Object.entries(files)) fs.writeFileSync(path.join(at, n), html);
  return at;
}

test('sampleFiles с dark: false — тёмной картинки нет даже у образца с theme=dark', () => {
  const dir = tmpDir('light-'); const at = put(dir, 'demo', { '01.html': DARK_HTML });
  assert.equal(sampleFiles(dir, 'demo').files[0].dark, path.join(at, '01-dark.png'));
  assert.equal(sampleFiles(dir, 'demo', { dark: false }).files[0].dark, null);
});

test('keepReferenced: план ссылается на картинки — снимать только их; ссылок нет — всё', () => {
  const files = [{ html: '/p/01.html', light: '/p/01-light.png', dark: '/p/01-dark.png' }, { html: '/p/02.html', light: '/p/02-light.png', dark: '/p/02-dark.png' }];
  assert.deepEqual(keepReferenced(files, []), files);
  assert.deepEqual(keepReferenced(files, ['/p/01-light.png', '/p/02-light.png']), [
    { html: '/p/01.html', light: '/p/01-light.png', dark: null }, { html: '/p/02.html', light: '/p/02-light.png', dark: null }]);
  assert.deepEqual(keepReferenced(files, ['/p/02-dark.png']), [{ html: '/p/02.html', light: null, dark: '/p/02-dark.png' }]);
});

test('samples.dark — да или нет; по умолчанию да', () => {
  assert.equal(parseConfig('project: x\n').samples.dark, true);
  assert.equal(parseConfig('project: x\nsamples:\n  dark: false\n').samples.dark, false);
  assert.throws(() => parseConfig('project: x\nsamples:\n  dark: "нет"\n'), /samples\.dark/);
});

test('samples shoot --light и samples.dark: false — только светлые', { skip: !BROWSER && 'нет браузера' }, () => {
  const dir = bareProject(); const at = put(dir, 'demo', { '01.html': DARK_HTML });
  const r = cli(['samples', 'shoot', 'demo', '--light'], dir);
  assert.equal(r.status, 0, r.stderr); assert.ok(fs.existsSync(path.join(at, '01-light.png'))); assert.ok(!fs.existsSync(path.join(at, '01-dark.png')));
  fs.appendFileSync(path.join(dir, 'mcfly', 'config.yaml'), '\nsamples:\n  dark: false\n');
  const c = cli(['samples', 'shoot', 'demo'], dir);
  assert.equal(c.status, 0, c.stderr); assert.ok(!fs.existsSync(path.join(at, '01-dark.png')));
});

test('approval request не переснимает тёмную, если план ссылается только на светлую', { skip: !BROWSER && 'нет браузера' }, () => {
  const dir = bareProject(); const at = put(dir, 'demo', { '01.html': DARK_HTML });
  addChange(dir, 'demo', { proposal: '## Простыми словами\nП.\n\n## Как это будет выглядеть\n### Ответ\n```\nГотово\n```\nКартинка: design/samples/demo/01-light.png\n' });
  const r = cli(['approval', 'request', 'demo'], dir);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(fs.existsSync(path.join(at, '01-light.png')), 'указанная картинка доснята');
  assert.ok(!fs.existsSync(path.join(at, '01-dark.png')), 'тёмная не снята');
});
