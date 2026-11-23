import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { ensureDir } from './util.js';

/**
 * 0.22.0 (F40): стенд для сверки вида — локальный сервер проекта из stand.command (config.yaml, правит владелец).
 * Субагенту проверка разрешений отклоняет «nohup … &» как скрытие, а фоновые задачи в прогоне выключены: mcfly запускает сервер сам,
 * отдельной группой процессов, журнал — в mcfly/logs/stand.log основного каталога, номер процесса — в mcfly/logs/stand.pid.
 */
const files = (logsDir) => ({ pid: path.join(logsDir, 'stand.pid'), log: path.join(logsDir, 'stand.log') });
/** Время запуска и группа процесса по ps: номер процесса из файла мог достаться чужому — гасим, только если всё совпало. */
function procInfo(pid) {
  const r = spawnSync('ps', ['-o', 'pgid=,lstart=', '-p', String(pid)], { encoding: 'utf8' });
  const m = /^\s*(\d+)\s+(.+?)\s*$/.exec(String(r.stdout || ''));
  return m ? { pgid: Number(m[1]), started: m[2] } : null;
}
const readRec = (f) => { try { const r = JSON.parse(fs.readFileSync(f, 'utf8')); return Number.isInteger(r.pid) && r.pid > 0 ? r : null; } catch { return null; } };
/** Свой ли это ещё стенд: та же группа (лидер — он сам) и то же время запуска. */
const ours = (rec) => { const i = rec && procInfo(rec.pid); return !!i && i.pgid === rec.pid && i.started === rec.started; };

function portOpen(port, host = '127.0.0.1') {
  return new Promise((resolve) => {
    const s = net.connect({ port, host });
    s.once('connect', () => { s.destroy(); resolve(true); });
    s.once('error', () => resolve(false));
    s.setTimeout(1000, () => { s.destroy(); resolve(false); });
  });
}

export async function standStart({ cfg, dir, logsDir, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  const { command, port, ready_seconds: wait } = cfg.stand;
  if (!command) return { error: 'стенд не настроен: нет stand.command в mcfly/config.yaml — настройку добавляет владелец' };
  ensureDir(logsDir); const f = files(logsDir);
  const old = readRec(f.pid);
  if (ours(old)) return { error: `стенд уже запущен (процесс ${old.pid}): сначала mcfly stand stop` };
  if (await portOpen(port)) return { error: `порт ${port} уже занят другим процессом — стенд не запущен` };
  const out = fs.openSync(f.log, 'w');
  const child = spawn('/bin/sh', ['-c', command], { cwd: dir, detached: true, stdio: ['ignore', out, out], env: { ...process.env, PORT: String(port) } });
  fs.closeSync(out);
  child.unref();
  fs.writeFileSync(f.pid, JSON.stringify({ pid: child.pid, started: procInfo(child.pid)?.started || '' }));
  for (let t = 0; t < wait * 4; t += 1) {
    if (await portOpen(port)) return { url: `http://localhost:${port}/`, pid: child.pid, log: f.log };
    if (child.exitCode != null || !procInfo(child.pid)) break;
    await sleep(250);
  }
  standStop({ logsDir });
  const tail = fs.existsSync(f.log) ? fs.readFileSync(f.log, 'utf8').trim().split('\n').slice(-5).join('\n') : '';
  return { error: `стенд не ответил на порту ${port} за ${wait} с${tail ? `; журнал:\n${tail}` : ''}` };
}

/** Останавливает стенд (всю его группу процессов). stopped — был ли он запущен. */
export function standStop({ logsDir }) {
  const f = files(logsDir); const rec = readRec(f.pid);
  try { fs.rmSync(f.pid, { force: true }); } catch {}
  if (!ours(rec)) return { stopped: false };
  try { process.kill(-rec.pid, 'SIGTERM'); } catch { return { stopped: false }; }
  return { stopped: true, pid: rec.pid };
}
