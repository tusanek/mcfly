import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { parseSlot } from './window.js';
import { ensureDir, writeText, exists, pad2 } from './util.js';

export function labelFor(project, job) { return `com.mcfly.${project}.${job}`; }
/** Когда запускается задание: «02:00» или «каждые 10 мин». */
export const jobWhen = (j) => (j.interval ? `каждые ${Math.round(j.interval / 60)} мин` : `${pad2(j.hour)}:${pad2(j.minute)}`);
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function buildPlist({ label, node, mcflyBin, args, projectDir, hour, minute, interval, logPath, pathEnv, home }) {
  const when = interval
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
  <key>StandardOutPath</key><string>${esc(logPath)}</string>
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
  if (cfg.schedule.answers_every_minutes > 0) jobs.push({ label: labelFor(cfg.project, 'answers'), interval: cfg.schedule.answers_every_minutes * 60, args: ['answers', '--project', projectDir] });
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

function removeJob(dir, uid, label) {
  spawnSync('launchctl', ['bootout', `gui/${uid}/${label}`], { encoding: 'utf8' });
  fs.unlinkSync(path.join(dir, `${label}.plist`));
}

export function install(cfg, { projectDir, mcflyBin, logsDir, dryRun = false, log = console.log }) {
  const jobs = planJobs(cfg, { projectDir, node: process.execPath, mcflyBin, logsDir, pathEnv: defaultPathEnv(), home: os.homedir() });
  ensureDir(logsDir);
  const dir = ensureDir(launchAgentsDir()); const uid = process.getuid();
  for (const label of staleLabels(fs.readdirSync(dir), cfg.project, jobs.map((j) => j.label))) {
    if (dryRun) { log(`[dry-run] удалить ${label} (слота нет в конфигурации)`); continue; }
    removeJob(dir, uid, label);
    log(`✓ удалено ${label} (слота нет в конфигурации)`);
  }
  for (const j of jobs) {
    const file = path.join(dir, `${j.label}.plist`);
    if (dryRun) { log(`[dry-run] ${file} → ${jobWhen(j)}`); continue; }
    if (exists(file)) spawnSync('launchctl', ['bootout', `gui/${uid}/${j.label}`], { encoding: 'utf8' });
    writeText(file, j.plist);
    const r = spawnSync('launchctl', ['bootstrap', `gui/${uid}`, file], { encoding: 'utf8' });
    log(`${r.status === 0 ? '✓' : '✗'} ${j.label} → ${jobWhen(j)}${r.status === 0 ? '' : ' ' + String(r.stderr || r.stdout).trim()}`);
  }
  return jobs;
}
export function remove(cfg, { log = console.log }) {
  const dir = launchAgentsDir(); if (!exists(dir)) return; const uid = process.getuid();
  for (const label of ownLabels(fs.readdirSync(dir), cfg.project)) {
    removeJob(dir, uid, label);
    log(`✓ удалено ${label}`);
  }
}
export function status(cfg, { log = console.log }) {
  const r = spawnSync('launchctl', ['list'], { encoding: 'utf8' });
  const lines = String(r.stdout || '').split('\n').filter((l) => l.includes(`com.mcfly.${cfg.project}.`));
  if (!lines.length) log('Задания launchd не установлены (mcfly schedule install).');
  for (const l of lines) log(l);
}
