import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { ensureDir } from './util.js';

/**
 * 0.22.0 (F40): стенд для сверки вида — локальный сервер проекта из stand.command (config.yaml, правит владелец).
 * Субагенту проверка разрешений отклоняет «nohup … &» как скрытие, а фоновые задачи в прогоне выключены: mcfly запускает сервер сам,
 * отдельной группой процессов, журнал — в mcfly/logs/stand.log основного каталога, номер процесса — в mcfly/logs/stand.pid.
 */
const files = (logsDir) => ({ pid: path.join(logsDir, 'stand.pid'), log: path.join(logsDir, 'stand.log') });
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const readPid = (f) => { const n = Number(String(fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '').trim()); return Number.isInteger(n) && n > 0 ? n : null; };

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
  const old = readPid(f.pid);
  if (old && alive(old)) return { error: `стенд уже запущен (процесс ${old}): сначала mcfly stand stop` };
  if (await portOpen(port)) return { error: `порт ${port} уже занят другим процессом — стенд не запущен` };
  const out = fs.openSync(f.log, 'w');
  const child = spawn('/bin/sh', ['-c', command], { cwd: dir, detached: true, stdio: ['ignore', out, out], env: { ...process.env, PORT: String(port) } });
  fs.closeSync(out);
  child.unref();
  fs.writeFileSync(f.pid, String(child.pid));
  for (let t = 0; t < wait * 4; t += 1) {
    if (await portOpen(port)) return { url: `http://localhost:${port}/`, pid: child.pid, log: f.log };
    if (!alive(child.pid)) break;
    await sleep(250);
  }
  standStop({ logsDir });
  const tail = fs.existsSync(f.log) ? fs.readFileSync(f.log, 'utf8').trim().split('\n').slice(-5).join('\n') : '';
  return { error: `стенд не ответил на порту ${port} за ${wait} с${tail ? `; журнал:\n${tail}` : ''}` };
}

/** Останавливает стенд (всю его группу процессов). stopped — был ли он запущен. */
export function standStop({ logsDir }) {
  const f = files(logsDir); const pid = readPid(f.pid);
  try { fs.rmSync(f.pid, { force: true }); } catch {}
  if (!pid || !alive(pid)) return { stopped: false };
  try { process.kill(-pid, 'SIGTERM'); } catch { try { process.kill(pid, 'SIGTERM'); } catch {} }
  return { stopped: true, pid };
}
