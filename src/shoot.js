// Снимки образцов (0.20.0): mcfly сам снимает design/samples/<изменение>/NN.html в PNG — Chrome без окна,
// управление через канал отладки по трубам (--remote-debugging-pipe, дескрипторы 3 и 4). Без сетевого порта,
// без http-сервера и без Playwright MCP, который адреса file: не открывает.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

export const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const WIDTH = 390;
const SCALE = 2;
const NAME = /^[a-z0-9][a-z0-9-]*$/;
const SAMPLE = /^(\d+)\.html$/;
const DARK = /theme=dark|\.dark\b/;

/**
 * Браузер для снимков: samples.browser из настроек (если указан, то только он), иначе Google Chrome,
 * иначе новейший Chromium из кэша Playwright. null — не найден.
 */
export function findBrowser({ configured = '', exists = fs.existsSync, home = os.homedir(), list = (d) => fs.readdirSync(d) } = {}) {
  if (configured) return exists(configured) ? configured : null;
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

/** Образцы изменения: NN.html по номеру; dark — null, если образец не знает тёмной темы. */
export function sampleFiles(baseDir, change) {
  if (!NAME.test(String(change || ''))) return { error: `плохое имя изменения «${change || ''}»: латиница, цифры, дефис`, files: [] };
  const dir = path.join(baseDir, 'design', 'samples', change);
  let names = []; try { names = fs.readdirSync(dir); } catch {}
  const files = names.filter((n) => SAMPLE.test(n)).sort((a, b) => Number(SAMPLE.exec(a)[1]) - Number(SAMPLE.exec(b)[1])).map((n) => {
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
    '--hide-scrollbars', `--user-data-dir=${profile}`, 'about:blank'], { stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] });
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
  return { send, close, on: (l) => { listeners.add(l); return () => listeners.delete(l); } };
}

const within = (p, ms, why) => { let t; return Promise.race([p, new Promise((_, rej) => { t = setTimeout(() => rej(new Error(why)), ms); })]).finally(() => clearTimeout(t)); };

/** Одна страница в новой вкладке: элемент #shot (без него — вся страница) в PNG. */
async function shootPage(b, url, out, timeoutMs) {
  const { targetId } = await b.send('Target.createTarget', { url: 'about:blank' });
  try {
    await within((async () => {
      const { sessionId } = await b.send('Target.attachToTarget', { targetId, flatten: true });
      await b.send('Emulation.setDeviceMetricsOverride', { width: WIDTH, height: 800, deviceScaleFactor: SCALE, mobile: false }, sessionId);
      await b.send('Page.enable', {}, sessionId);
      const loaded = new Promise((resolve) => { const off = b.on((m) => { if (m.sessionId === sessionId && m.method === 'Page.loadEventFired') { off(); resolve(); } }); });
      const nav = await b.send('Page.navigate', { url }, sessionId);
      if (nav.errorText) throw new Error(`страница не открылась: ${nav.errorText}`);
      await loaded;
      const { result } = await b.send('Runtime.evaluate', { expression: 'JSON.stringify((document.querySelector("#shot") || document.documentElement).getBoundingClientRect())', returnByValue: true }, sessionId);
      const r = JSON.parse(result.value);
      if (!r.width || !r.height) throw new Error('пустой образец: у #shot нет размера');
      const shot = await b.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, clip: { x: r.x, y: r.y, width: r.width, height: r.height, scale: 1 } }, sessionId);
      fs.writeFileSync(out, Buffer.from(shot.data, 'base64'));
    })(), timeoutMs, `страница не загрузилась за ${Math.round(timeoutMs / 1000)} с`);
  } finally {
    await within(b.send('Target.closeTarget', { targetId }), 3000, 'вкладка не закрылась').catch(() => {});
  }
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
      try { await shootPage(b, `file://${j.html}${j.query}`, j.out, timeoutMs); res.shot.push(j.out); }
      catch (e) { res.failed.push({ file: j.html, error: e.message }); }
    }
  } finally { await b.close(); }
  return res;
}
