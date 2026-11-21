// Снимки образцов (0.20.0): mcfly сам снимает design/samples/<изменение>/NN.html в PNG — Chrome без окна,
// управление через канал отладки по трубам (--remote-debugging-pipe, дескрипторы 3 и 4). Без сетевого порта,
// без http-сервера и без Playwright MCP, который адреса file: не открывает.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';

export const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const WIDTH = 390;
const SCALE = 2;
const NAME = /^[a-z0-9][a-z0-9-]*$/;
const SAMPLE = /^(\d+)\.html$/;
const DARK = /theme=dark|\.dark\b/;
/** Имена исполняемых файлов Chrome и Chromium — samples.browser другим быть не может (защита от запуска чужой программы). */
export const BROWSER_NAME = /^(Google Chrome( for Testing| Canary| Beta| Dev)?|Chromium|chrome|chromium|chromium-browser|google-chrome)$/;
const isFile = (p) => { try { return fs.statSync(p).isFile(); } catch { return false; } };
const inside = (dir, p) => p === dir || p.startsWith(dir + path.sep);

/**
 * Браузер для снимков: samples.browser из настроек (если указан, то только он), иначе Google Chrome,
 * иначе новейший Chromium из кэша Playwright. null — не найден.
 */
export function findBrowser({ configured = '', exists = fs.existsSync, home = os.homedir(), list = (d) => fs.readdirSync(d), realpath = fs.realpathSync, file = isFile } = {}) {
  // настоящий путь (после ссылок) — его и запускаем, чтобы ссылку нельзя было подменить между проверкой и запуском
  if (configured) return exists(configured) && file(configured) ? trusted(configured, realpath) : null;
  if (exists(CHROME)) return CHROME;
  const cache = path.join(home, 'Library', 'Caches', 'ms-playwright');
  let dirs = []; try { dirs = exists(cache) ? list(cache) : []; } catch { return null; }
  const builds = dirs.map((d) => [d, /^chromium-(\d+)$/.exec(d)]).filter(([, m]) => m).sort((a, b) => Number(b[1][1]) - Number(a[1][1]));
  for (const [d] of builds) {
    let subs = []; try { subs = list(path.join(cache, d)); } catch { continue; }
    for (const s of subs.filter((x) => x.startsWith('chrome-mac'))) {
      const bin = path.join(cache, d, s, 'Chromium.app', 'Contents', 'MacOS', 'Chromium');
      if (exists(bin)) return bin;
    }
  }
  return null;
}

/**
 * безопасность: путь из samples.browser — абсолютный, с именем Chrome/Chromium, и настоящий файл (после ссылок) лежит в обычном
 * системном месте установки программ (/Applications, /usr/bin, /opt/google): иначе агент мог бы подложить свою программу под видом браузера.
 */
function trusted(p, realpath) {
  if (!path.isAbsolute(p) || !BROWSER_NAME.test(path.basename(p))) return null;
  let real = ''; try { real = realpath(p); } catch { return null; }
  // только системные места, куда без прав администратора не пишут; кэш Playwright — лишь для поиска по умолчанию
  return BROWSER_NAME.test(path.basename(real)) && ['/Applications', '/usr/bin', '/opt/google'].some((dir) => real.startsWith(dir + path.sep)) ? real : null;
}

/** Образцы изменения: NN.html по номеру; dark — null, если образец не знает тёмной темы. */
export function sampleFiles(baseDir, change) {
  if (!NAME.test(String(change || ''))) return { error: `плохое имя изменения «${change || ''}»: латиница, цифры, дефис`, files: [] };
  const dir = path.join(baseDir, 'design', 'samples', change);
  let names = []; try { names = fs.readdirSync(dir); } catch {}
  // безопасность: каталог образцов и сами файлы — внутри проекта, ссылки наружу не снимаем (браузер показал бы чужой файл)
  let real = ''; try { real = fs.realpathSync(dir); } catch {}
  if (names.length && !inside(fs.realpathSync(baseDir), real)) return { error: `design/samples/${change} ведёт за пределы проекта`, files: [] };
  const own = (n) => { try { return inside(real, fs.realpathSync(path.join(dir, n))); } catch { return false; } };
  const files = names.filter((n) => SAMPLE.test(n) && own(n)).sort((a, b) => Number(SAMPLE.exec(a)[1]) - Number(SAMPLE.exec(b)[1])).map((n) => {
    const html = path.join(dir, n); const base = n.replace(/\.html$/, '');
    return { html, light: path.join(dir, `${base}-light.png`), dark: DARK.test(fs.readFileSync(html, 'utf8')) ? path.join(dir, `${base}-dark.png`) : null };
  });
  if (!files.length) return { error: `нет образцов: в design/samples/${change}/ нет файлов NN.html`, files: [] };
  return { files };
}

/** Chrome без окна с каналом отладки; send(method, params, sessionId) → result, close() — закрыть и убрать профиль. */
function launch(browser) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'mcfly-shot-'));
  const proc = spawn(browser, ['--headless', '--remote-debugging-pipe', '--no-first-run', '--no-default-browser-check', '--disable-gpu',
    '--hide-scrollbars',
    // безопасность: сеть закрыта на уровне браузера (имена не находятся), новые окна не открываются — вдобавок к перехвату запросов
    '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost', '--block-new-web-contents', `--user-data-dir=${profile}`, 'about:blank'], { stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] });
  let id = 0; let buf = ''; let dead = null;
  const waiting = new Map(); const listeners = new Set();
  const fail = (why) => { dead = dead || why; for (const [, w] of waiting) w.reject(new Error(dead)); waiting.clear(); };
  const exited = new Promise((resolve) => proc.once('exit', resolve));
  proc.once('error', (e) => fail(`браузер не запустился: ${e.code === 'ENOENT' ? `нет файла ${browser}` : e.message}`));
  proc.once('exit', () => fail('браузер закрылся'));
  proc.stdio[3].on('error', () => {}); proc.stdio[4].on('error', () => {});
  proc.stdio[4].on('data', (d) => {
    buf += d.toString();
    for (let i = buf.indexOf('\0'); i >= 0; i = buf.indexOf('\0')) {
      let m = null; try { m = JSON.parse(buf.slice(0, i)); } catch {} buf = buf.slice(i + 1);
      if (!m) continue;
      if (m.id && waiting.has(m.id)) { const w = waiting.get(m.id); waiting.delete(m.id); if (m.error) w.reject(new Error(m.error.message)); else w.resolve(m.result); }
      else for (const l of listeners) l(m);
    }
  });
  const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    if (dead) { reject(new Error(dead)); return; }
    const n = ++id; waiting.set(n, { resolve, reject });
    proc.stdio[3].write(JSON.stringify({ id: n, method, params, ...(sessionId ? { sessionId } : {}) }) + '\0');
  });
  const close = async () => {
    if (!dead) { send('Browser.close').catch(() => {}); }
    const t = setTimeout(() => proc.kill('SIGKILL'), 5000);
    if (proc.exitCode == null && proc.pid) await exited; clearTimeout(t);
    try { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch {}
  };
  const abort = (why) => { fail(why); proc.kill('SIGKILL'); };
  return { send, close, abort, on: (l) => { listeners.add(l); return () => listeners.delete(l); } };
}

const within = (p, ms, why) => { let t; return Promise.race([p, new Promise((_, rej) => { t = setTimeout(() => rej(new Error(why)), ms); })]).finally(() => clearTimeout(t)); };

/** Одна страница в новой вкладке: элемент #shot (без него — вся страница) в PNG. */
async function shootPage(b, { html, query, out }, timeoutMs) {
  // ревью: браузер, который запустился, но молчит, не должен вешать команду навсегда
  const { targetId } = await within(b.send('Target.createTarget', { url: 'about:blank' }), timeoutMs, 'браузер не отвечает')
    .catch((e) => { b.abort(e.message); throw e; });
  const dir = path.dirname(html); let cancelled = false; const offs = [];
  try {
    await within((async () => {
      const { sessionId } = await b.send('Target.attachToTarget', { targetId, flatten: true });
      // безопасность: образец (его пишет агент) загружает только файлы своей папки и встроенные данные — без сети и чужих файлов
      offs.push(b.on((m) => {
        if (m.sessionId !== sessionId || m.method !== 'Fetch.requestPaused') return;
        const { requestId, request } = m.params;
        b.send(allowed(request.url, dir) ? 'Fetch.continueRequest' : 'Fetch.failRequest', allowed(request.url, dir) ? { requestId } : { requestId, errorReason: 'BlockedByClient' }, sessionId).catch(() => {});
      }));
      await b.send('Fetch.enable', { patterns: [{ urlPattern: '*' }] }, sessionId);
      await b.send('Emulation.setDeviceMetricsOverride', { width: WIDTH, height: 800, deviceScaleFactor: SCALE, mobile: false }, sessionId);
      await b.send('Page.enable', {}, sessionId);
      const loaded = new Promise((resolve) => { offs.push(b.on((m) => { if (m.sessionId === sessionId && m.method === 'Page.loadEventFired') resolve(); })); });
      const nav = await b.send('Page.navigate', { url: pathToFileURL(html).href + query }, sessionId);
      if (nav.errorText) throw new Error(`страница не открылась: ${nav.errorText}`);
      await loaded;
      const { result } = await b.send('Runtime.evaluate', { expression: 'JSON.stringify((document.querySelector("#shot") || document.documentElement).getBoundingClientRect())', returnByValue: true }, sessionId);
      const r = JSON.parse(result.value);
      if (!r.width || !r.height) throw new Error('пустой образец: у #shot нет размера');
      const shot = await b.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, clip: { x: r.x, y: r.y, width: r.width, height: r.height, scale: 1 } }, sessionId);
      if (cancelled) return;
      writeSafe(out, Buffer.from(shot.data, 'base64'));
    })(), timeoutMs, `страница не загрузилась за ${Math.round(timeoutMs / 1000)} с`);
  } catch (e) { cancelled = true; throw e; } finally {
    for (const off of offs) off();
    await within(b.send('Target.closeTarget', { targetId }), 3000, 'вкладка не закрылась').catch(() => {});
  }
}

/** Адрес, который образцу можно загрузить: файл из его папки, встроенные данные, пустая страница. */
function allowed(url, dir) {
  if (/^(data|blob|about):/.test(url)) return true;
  if (!url.startsWith('file:')) return false;
  try { return inside(fs.realpathSync(dir), fs.realpathSync(fileURLToPath(url.replace(/[?#].*$/, '')))); } catch { return false; }
}

/** безопасность: не писать поверх ссылки на чужой файл; запись — через временный файл и переименование. */
function writeSafe(out, data) {
  let st = null; try { st = fs.lstatSync(out); } catch {}
  if (st && !st.isFile()) throw new Error(`${path.basename(out)} — ссылка или каталог, а не файл: не перезаписываю`);
  const tmp = `${out}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, data, { flag: 'wx' }); fs.renameSync(tmp, out);
}

/**
 * Снять образцы: shot — созданные PNG, skipped — уже были (onlyMissing), failed — { file, error }.
 * Один браузер на все файлы; сбой одной страницы не мешает остальным.
 */
export async function shootFiles(files, { browser, timeoutMs = 20000, onlyMissing = false } = {}) {
  const res = { shot: [], skipped: [], failed: [] };
  const jobs = [];
  for (const f of files) {
    for (const [out, query] of [[f.light, ''], ...(f.dark ? [[f.dark, '?theme=dark']] : [])]) {
      if (onlyMissing && fs.existsSync(out)) res.skipped.push(out); else jobs.push({ html: f.html, out, query });
    }
  }
  if (!jobs.length) return res;
  const b = launch(browser);
  try {
    for (const j of jobs) {
      if (res.failed.some((x) => x.file === j.html)) continue; // светлая не снялась — тёмную не ждём
      try { await shootPage(b, j, timeoutMs); res.shot.push(j.out); }
      catch (e) { res.failed.push({ file: j.html, error: e.message }); }
    }
  } finally { await b.close(); }
  return res;
}
