import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { parseSlot } from './window.js';
import { ensureDir, writeText, exists, pad2 } from './util.js';

export function labelFor(project, job) { return `com.mcfly.${project}.${job}`; }
/** Когда запускается задание: «02:00» или «каждые 10 мин». */
export const jobWhen = (j) => (j.keepAlive ? `постоянно, цикл ${Math.round(j.window / 60)} мин` : j.interval ? `каждые ${Math.round(j.interval / 60)} мин` : `${pad2(j.hour)}:${pad2(j.minute)}`);
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function buildPlist({ label, node, mcflyBin, args, projectDir, hour, minute, interval, keepAlive = false, logPath, pathEnv, home, abandonGroup = false }) {
  // keepAlive: задание работает постоянно — launchd перезапускает его после выхода, но не чаще раза в минуту.
  const when = keepAlive
    ? `  <key>KeepAlive</key><true/>\n  <key>ThrottleInterval</key><integer>60</integer>`
    : interval
    ? `  <key>StartInterval</key><integer>${interval}</integer>`
    : `  <key>StartCalendarInterval</key>
  <dict><key>Hour</key><integer>${hour}</integer><key>Minute</key><integer>${minute}</integer></dict>`;
  const arr = [node, mcflyBin, ...args].map((a) => `    <string>${esc(a)}</string>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${esc(label)}</string>
  <key>ProgramArguments</key>
  <array>
${arr}
  </array>
  <key>WorkingDirectory</key><string>${esc(projectDir)}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>${esc(pathEnv)}</string>
    <key>HOME</key><string>${esc(home)}</string>
    <key>LANG</key><string>ru_RU.UTF-8</string>
  </dict>
${when}
${abandonGroup ? '  <key>AbandonProcessGroup</key><true/>\n' : ''}  <key>StandardOutPath</key><string>${esc(logPath)}</string>
  <key>StandardErrorPath</key><string>${esc(logPath)}</string>
</dict>
</plist>
`;
}

export function planJobs(cfg, { projectDir, node, mcflyBin, logsDir, pathEnv, home }) {
  const jobs = cfg.schedule.slots.map((slot) => { const m = parseSlot(slot); return { label: labelFor(cfg.project, `run-${slot.replace(':', '')}`), hour: Math.floor(m / 60), minute: m % 60, args: ['run', '--mode', 'night', '--project', projectDir] }; });
  const s = parseSlot(cfg.schedule.summary_at);
  jobs.push({ label: labelFor(cfg.project, 'summary'), hour: Math.floor(s / 60), minute: s % 60, args: ['summary', '--send', '--project', projectDir] });
  // Опрос ответов и нажатий кнопок из Telegram: иначе ответ на сводку применится только к ночному прогону.
  // Постоянное задание (KeepAlive): цикл длинного опроса answers_every_minutes минут, после выхода launchd сразу запускает новый.
  // StartInterval не годится: на батарее таймер сдвигается, и запуск, пришедшийся на ещё живой цикл, пропадает (02.10 — 10 минут без опроса).
  // Без chat_id опрашивать некого: постоянное задание выходило бы сразу и перезапускалось каждую минуту.
  if (cfg.schedule.answers_every_minutes > 0 && cfg.telegram?.chat_id) jobs.push({ label: labelFor(cfg.project, 'answers'), keepAlive: true, window: cfg.schedule.answers_every_minutes * 60, args: ['answers', '--project', projectDir], abandonGroup: true }); // «запусти» стартует прогон, который должен пережить задание
  return jobs.map((j) => ({ ...j, plist: buildPlist({ ...j, node, mcflyBin, projectDir, logPath: path.join(logsDir, `${j.label}.log`), pathEnv, home }) }));
}

function which(bin) { const r = spawnSync('which', [bin], { encoding: 'utf8' }); return r.status === 0 ? r.stdout.trim() : ''; }
export function defaultPathEnv() {
  const claude = which('claude');
  const dirs = [claude ? path.dirname(claude) : '', path.dirname(process.execPath), path.join(os.homedir(), '.local', 'bin'), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'].filter(Boolean);
  return [...new Set(dirs)].join(':');
}
export function launchAgentsDir() { return path.join(os.homedir(), 'Library', 'LaunchAgents'); }

/** Метки заданий проекта в LaunchAgents: ровно `com.mcfly.<проект>.run-ЧЧММ` или `.summary` — задания проекта `demo.v2` проекту `demo` не принадлежат. */
export function ownLabels(files, project) {
  const prefix = `com.mcfly.${project}.`;
  return files.filter((f) => f.startsWith(prefix) && f.endsWith('.plist'))
    .map((f) => f.slice(0, -'.plist'.length))
    .filter((label) => /^(run-\d{4}|summary|answers)$/.test(label.slice(prefix.length)));
}

/** Метки заданий проекта, которых нет в плане: слот убрали из конфигурации. */
export function staleLabels(files, project, plannedLabels) {
  return ownLabels(files, project).filter((label) => !plannedLabels.includes(label));
}

/** Вызов launchctl. Тесты подменяют его (опция `launchctl`), чтобы не трогать настоящие задания. */
export function runLaunchctl(args) {
  const r = spawnSync('launchctl', args, { encoding: 'utf8' });
  return { status: r.status ?? 1, out: String(r.stderr || r.stdout || '').trim() };
}
/** Синхронная пауза: install синхронный, а ждать выгрузку задания надо до 30 с. */
export function sleepSync(ms) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }

const UNLOAD_WAIT_MS = 30_000; const POLL_MS = 500; const LOAD_ATTEMPTS = 5; const RETRY_PAUSE_MS = 2_000;
/** Общие опции работы с launchd; всё подменяемо в тестах. */
function lc(opts) {
  return { launchctl: runLaunchctl, sleep: sleepSync, now: Date.now, uid: process.getuid(), agentsDir: launchAgentsDir(), log: console.log, ...opts };
}
/** Знает ли launchd задание: `launchctl print` по метке без ошибки. */
function isLoaded(label, o) { return o.launchctl(['print', `gui/${o.uid}/${label}`]).status === 0; }
/** Ждать, пока launchd отпустит задание, не дольше 30 с. */
function waitUnloaded(label, o) {
  const deadline = o.now() + UNLOAD_WAIT_MS;
  while (isLoaded(label, o)) { if (o.now() >= deadline) return false; o.sleep(POLL_MS); }
  return true;
}
/**
 * Выгрузить задание и дождаться, пока оно исчезнет. bootout возвращается сразу, а процесс ещё уходит:
 * 07.11 bootstrap сразу после bootout упал (ошибка 5 «Input/output error»), и answers пропал до повторного install.
 */
export function unloadJob(label, opts) {
  const o = lc(opts);
  if (!isLoaded(label, o)) return true;
  o.launchctl(['bootout', `gui/${o.uid}/${label}`]);
  return waitUnloaded(label, o);
}
/**
 * Загрузить задание (прежнее уже выгружено); при сбое — ещё попытки с паузой.
 * Если после сбоя launchd всё же знает метку — загрузилось наше задание: прежнее выгружено до вызова.
 */
export function loadJob(label, file, opts) {
  const o = lc(opts); let error = '';
  for (let i = 1; i <= LOAD_ATTEMPTS; i++) {
    const r = o.launchctl(['bootstrap', `gui/${o.uid}`, file]);
    if (r.status === 0) return { ok: true };
    error = r.out || `код ${r.status}`;
    if (i < LOAD_ATTEMPTS) o.sleep(RETRY_PAUSE_MS);
    if (isLoaded(label, o)) return { ok: true };
  }
  return { ok: false, error };
}

function removeJob(label, o) {
  const ok = unloadJob(label, o);
  fs.rmSync(path.join(o.agentsDir, `${label}.plist`), { force: true });
  return ok;
}

/** Ставит задания плана; возвращает { jobs, failed } — failed: метки, которые не работают после установки. */
export function install(cfg, opts) {
  const o = lc(opts); const { projectDir, mcflyBin, logsDir, dryRun = false, log } = o;
  const jobs = planJobs(cfg, { projectDir, node: process.execPath, mcflyBin, logsDir, pathEnv: defaultPathEnv(), home: os.homedir() });
  const failed = [];
  if (!dryRun) ensureDir(logsDir);
  const dir = dryRun ? o.agentsDir : ensureDir(o.agentsDir);
  for (const label of staleLabels(exists(dir) ? fs.readdirSync(dir) : [], cfg.project, jobs.map((j) => j.label))) {
    if (dryRun) { log(`[dry-run] удалить ${label} (слота нет в конфигурации)`); continue; }
    if (removeJob(label, o)) log(`✓ удалено ${label} (слота нет в конфигурации)`);
    else { failed.push(label); log(`✗ ${label}: plist удалён, но задание не выгрузилось за 30 с — выполните mcfly schedule install ещё раз`); }
  }
  for (const j of jobs) {
    const file = path.join(dir, `${j.label}.plist`);
    if (dryRun) { log(`[dry-run] ${file} → ${jobWhen(j)}`); continue; }
    const unloaded = unloadJob(j.label, o);
    writeText(file, j.plist);
    if (!unloaded) { failed.push(j.label); log(`✗ ${j.label} → ${jobWhen(j)}: прежнее задание не выгрузилось за 30 с, работает старая версия. Выполните mcfly schedule install ещё раз.`); continue; }
    const r = loadJob(j.label, file, o);
    if (r.ok) log(`✓ ${j.label} → ${jobWhen(j)}`);
    else { failed.push(j.label); log(`✗ ${j.label} → ${jobWhen(j)}: не загружено, задание не работает (${r.error}). Выполните mcfly schedule install ещё раз; проверка — mcfly schedule status.`); }
  }
  return { jobs, failed };
}
export function remove(cfg, opts) {
  const o = lc(opts); if (!exists(o.agentsDir)) return;
  for (const label of ownLabels(fs.readdirSync(o.agentsDir), cfg.project)) {
    const ok = removeJob(label, o);
    o.log(ok ? `✓ удалено ${label}` : `✗ ${label}: plist удалён, но задание не выгрузилось за 30 с`);
  }
}
/** Строки `launchctl list` проекта: метка → { pid, exit }. */
function listedJobs(cfg, o) {
  const prefix = `com.mcfly.${cfg.project}.`; const map = new Map();
  for (const line of o.launchctl(['list']).out.split('\n')) {
    const [pid, exit, label] = line.split('\t');
    if (label?.startsWith(prefix) && ownLabels([`${label}.plist`], cfg.project).length) map.set(label, { pid: pid === '-' ? '' : pid, exit });
  }
  return map;
}
/** Задания плана и их состояние в launchd; возвращает число заданий плана, которые не загружены. */
export function status(cfg, opts) {
  const o = lc(opts);
  const jobs = planJobs(cfg, { projectDir: o.projectDir, node: process.execPath, mcflyBin: o.mcflyBin, logsDir: o.logsDir, pathEnv: '', home: os.homedir() });
  const listed = listedJobs(cfg, o); let missing = 0;
  for (const j of jobs) {
    const s = listed.get(j.label);
    if (!s) { missing++; o.log(`✗ ${j.label} → ${jobWhen(j)} — НЕ загружено, задание не сработает. Выполните mcfly schedule install.`); continue; }
    const run = s.pid ? `работает (процесс ${s.pid})` : j.keepAlive ? 'загружено, процесс сейчас не запущен (перезапуск после паузы)' : 'загружено';
    o.log(`✓ ${j.label} → ${jobWhen(j)} — ${run}${s.exit && s.exit !== '0' ? `; последний выход с кодом ${s.exit}` : ''}`);
  }
  const planned = new Set(jobs.map((j) => j.label));
  for (const label of listed.keys()) if (!planned.has(label)) o.log(`⚠ ${label} — загружено, но слота нет в конфигурации; mcfly schedule install его уберёт.`);
  return missing;
}
