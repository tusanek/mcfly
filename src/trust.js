import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { readJson, writeJson, ensureDir } from './util.js';
import { trustFile } from './actions.js';
import { DEFAULT_CONFIG } from './config.js';

/**
 * 0.22.0: команды проекта, которые обходят проверку разрешений Claude Code, — run.allow (правила для команды прогона) и
 * stand.command (сервер стенда, запускает mcfly). config.yaml лежит в репозитории, агент может его поправить, поэтому обе
 * настройки действуют, только если их сумма совпадает с подтверждённой владельцем командой mcfly trust (только в терминале).
 * Файл подтверждений — тот же, что у действий, вне проекта; ключ — «<каталог>#commands».
 */
// Режимы без проверки разрешений и лишние флаги claude тоже снимают защиту — подтверждаются вместе с командами.
export const RISKY_MODES = ['bypassPermissions', 'dontAsk'];
export const SAFE_MODE = 'auto';
export const trustedCommands = (cfg) => ({ allow: [...(cfg.run?.allow || [])], stand: String(cfg.stand?.command || ''),
  extra_args: [...(cfg.run?.extra_args || [])], mode: RISKY_MODES.includes(cfg.run?.permission_mode) ? cfg.run.permission_mode : '',
  // запускаемые программы и роль лида — подтверждаются, только если отличаются от стандартных
  bins: Object.fromEntries(BIN_KEYS.filter((k) => (cfg.run?.[k] ?? DEFAULT_CONFIG.run[k]) !== DEFAULT_CONFIG.run[k]).map((k) => [k, cfg.run[k]])) });
export const BIN_KEYS = ['claude_bin', 'scutil_bin', 'lead_agent'];
/** Конфигурация для команд вне прогона (ролик, режиссёр, VPN): без подтверждения — стандартные программы и роль лида. */
// Неподтверждённую программу не подменяем стандартной (запустился бы настоящий claude там, где его не ждали) — оставляем пустой:
// запуск сразу упадёт, а команды с запасным путём (ролик, VPN) пойдут им. Роль лида — стандартная.
export const withTrustedBins = (projectDir, cfg) => (commandsTrusted(projectDir, cfg) ? cfg : { ...cfg, run: untrustedRun(cfg.run) });
/** Своя программа (claude_bin, scutil_bin) не подтверждена — прогон не запускается. */
export const binsUntrusted = (projectDir, cfg) => ['claude_bin', 'scutil_bin'].some((k) => cfg.run[k] !== DEFAULT_CONFIG.run[k]) && !commandsTrusted(projectDir, cfg);
/** Настройки запуска без подтверждения владельца: стандартные программы, без флагов, режим без проверок — auto. */
export const untrustedRun = (run) => ({ ...run, extra_args: [], lead_agent: DEFAULT_CONFIG.run.lead_agent,
  ...Object.fromEntries(['claude_bin', 'scutil_bin'].map((k) => [k, run[k] === DEFAULT_CONFIG.run[k] ? run[k] : ''])),
  permission_mode: RISKY_MODES.includes(run.permission_mode) ? SAFE_MODE : run.permission_mode });
const digest = (cfg) => crypto.createHash('sha256').update(JSON.stringify(trustedCommands(cfg))).digest('hex');
const key = (projectDir) => { let d = path.resolve(projectDir); try { d = fs.realpathSync(d); } catch {} return `${d}#commands`; };
export const hasCommands = (cfg) => { const t = trustedCommands(cfg); return t.allow.length > 0 || !!t.stand || t.extra_args.length > 0 || !!t.mode || Object.keys(t.bins).length > 0; };
export function commandsTrusted(projectDir, cfg) {
  if (!hasCommands(cfg)) return true;
  return readJson(trustFile(), {})?.[key(projectDir)]?.digest === digest(cfg);
}
export function trustCommands(projectDir, cfg, now = new Date()) {
  const file = trustFile(); ensureDir(path.dirname(file));
  const all = readJson(file, {}) || {};
  all[key(projectDir)] = { digest: digest(cfg), at: now.toISOString(), ...trustedCommands(cfg) };
  writeJson(file, all);
}
export const UNTRUSTED_COMMANDS = 'run.allow, stand.command, run.extra_args, run.claude_bin, run.scutil_bin, run.lead_agent или режим разрешений без проверок в mcfly/config.yaml изменены и не подтверждены владельцем — не действуют (прогон — со стандартными настройками, режим auto). Проверьте и подтвердите в терминале: mcfly trust';
