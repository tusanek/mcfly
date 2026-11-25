import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { ensureDir } from './util.js';

/**
 * 0.22.0 (F40): стенд для сверки вида — локальный сервер проекта из stand.command (config.yaml, правит владелец).
 * Субагенту проверка разрешений отклоняет «nohup … &» как скрытие, а фоновые задачи в прогоне выключены: mcfly запускает сервер сам,
 * отдельной группой процессов, журнал и номер процесса — в mcfly/logs основного каталога.
 * 0.23.4 (F44): стенд свой у каждого каталога работы (основной каталог, копия разработчика, копия тестировщика):
 * свой порт — первый свободный от stand.port, свои файлы stand-<метка каталога>.pid/.log; stop гасит только стенд своего каталога.
 * Раньше стенд был один на прогон: участники перезапускали и гасили его друг у друга, пока соседи сверяли экраны.
 */
const PORTS_TRIED = 20;
const RESERVE_MS = 120_000;
const key = (dir) => crypto.createHash('sha1').update(path.resolve(dir)).digest('hex').slice(0, 8);
const files = (logsDir, dir) => ({ pid: path.join(logsDir, `stand-${key(dir)}.pid`), log: path.join(logsDir, `stand-${key(dir)}.log`) });
/** Время запуска и группа процесса по ps: номер процесса из файла мог достаться чужому — гасим, только если всё совпало. */
function procInfo(pid) {
  const r = spawnSync('ps', ['-o', 'pgid=,lstart=', '-p', String(pid)], { encoding: 'utf8' });
  const m = /^\s*(\d+)\s+(.+?)\s*$/.exec(String(r.stdout || ''));
  return m ? { pgid: Number(m[1]), started: m[2] } : null;
}
const readRec = (f) => { try { const r = JSON.parse(fs.readFileSync(f, 'utf8')); return r && typeof r === 'object' ? r : null; } catch { return null; } };
/** Свой ли это ещё стенд: та же группа (лидер — он сам) и то же время запуска. */
const ours = (rec) => { if (!(Number.isInteger(rec?.pid) && rec.pid > 0)) return false; const i = procInfo(rec.pid); return !!i && i.pgid === rec.pid && i.started === rec.started; };
/** Запись занимает порт: стенд жив или только что запускается (порт забронирован, процесса ещё нет). */
const holds = (rec, now) => ours(rec) || (!rec?.pid && Number(rec?.reserved_at) > now - RESERVE_MS);

/** Все стенды проекта: [{ file, rec }] по файлам stand-*.pid (и старому stand.pid). */
function allRecs(logsDir) {
  let names = [];
  try { names = fs.readdirSync(logsDir).filter((n) => /^stand(-[0-9a-f]{8})?\.pid$/.test(n)); } catch {}
  return names.map((n) => ({ file: path.join(logsDir, n), rec: readRec(path.join(logsDir, n)) }));
}

function portOpen(port, host = '127.0.0.1') {
  return new Promise((resolve) => {
    const s = net.connect({ port, host });
    s.once('connect', () => { s.destroy(); resolve(true); });
    s.once('error', () => resolve(false));
    s.setTimeout(1000, () => { s.destroy(); resolve(false); });
  });
}

/** Работающие стенды проекта: [{ dir, port, pid }]. */
export function standList({ logsDir }) {
  return allRecs(logsDir).filter(({ rec }) => ours(rec)).map(({ rec }) => ({ dir: rec.dir || '', port: rec.port, pid: rec.pid }));
}

export async function standStart({ cfg, dir, logsDir, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), now = Date.now }) {
  const { command, port: base, ready_seconds: wait } = cfg.stand;
  if (!command) return { error: 'стенд не настроен: нет stand.command в mcfly/config.yaml — настройку добавляет владелец' };
  ensureDir(logsDir); const f = files(logsDir, dir);
  const old = readRec(f.pid);
  // стенд этого каталога уже работает — отдаём его адрес, не перезапускаем (соседи на своих портах не задеты)
  if (ours(old)) return { url: `http://localhost:${old.port}/`, pid: old.pid, log: f.log, port: old.port, already: true };
  const taken = new Set(allRecs(logsDir).filter(({ file, rec }) => file !== f.pid && holds(rec, now())).map(({ rec }) => rec.port));
  let port = 0;
  for (let p = base; p < base + PORTS_TRIED && p < 65536; p += 1) if (!taken.has(p) && !(await portOpen(p))) { port = p; break; }
  if (!port) return { error: `нет свободного порта для стенда: ${base}–${base + PORTS_TRIED - 1} заняты` };
  fs.writeFileSync(f.pid, JSON.stringify({ pid: 0, port, dir, reserved_at: now() }));
  const out = fs.openSync(f.log, 'w');
  const child = spawn('/bin/sh', ['-c', command], { cwd: dir, detached: true, stdio: ['ignore', out, out], env: { ...process.env, PORT: String(port) } });
  fs.closeSync(out);
  child.unref();
  fs.writeFileSync(f.pid, JSON.stringify({ pid: child.pid, started: procInfo(child.pid)?.started || '', port, dir }));
  for (let t = 0; t < wait * 4; t += 1) {
    if (await portOpen(port)) return { url: `http://localhost:${port}/`, pid: child.pid, log: f.log, port };
    if (child.exitCode != null || !procInfo(child.pid)) break;
    await sleep(250);
  }
  standStop({ logsDir, dir });
  const tail = fs.existsSync(f.log) ? fs.readFileSync(f.log, 'utf8').trim().split('\n').slice(-5).join('\n') : '';
  const hint = port !== base ? ` (порт ${base} занят другим стендом; команда стенда должна слушать порт из $PORT)` : '';
  return { error: `стенд не ответил на порту ${port} за ${wait} с${hint}${tail ? `; журнал:\n${tail}` : ''}` };
}

function stopRec(file, rec) {
  try { fs.rmSync(file, { force: true }); } catch {}
  if (!ours(rec)) return false;
  try { process.kill(-rec.pid, 'SIGTERM'); return true; } catch { return false; }
}

/** Останавливает стенд своего каталога (всю его группу процессов). stopped — был ли он запущен; others — чужие стенды, их не трогаем. */
export function standStop({ logsDir, dir }) {
  const f = files(logsDir, dir); const rec = readRec(f.pid);
  const stopped = stopRec(f.pid, rec);
  const others = standList({ logsDir }).filter((s) => s.dir !== dir);
  return stopped ? { stopped: true, pid: rec.pid, others } : { stopped: false, others };
}

/** После прогона: гасит все стенды проекта (и стенд старого формата stand.pid). Возвращает число остановленных. */
export function standStopAll({ logsDir }) {
  let n = 0;
  for (const { file, rec } of allRecs(logsDir)) if (stopRec(file, rec)) n += 1;
  return n;
}
