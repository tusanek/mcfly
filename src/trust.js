import crypto from 'node:crypto';
import path from 'node:path';
import { readJson, writeJson, ensureDir } from './util.js';
import { trustFile } from './actions.js';

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
  extra_args: [...(cfg.run?.extra_args || [])], mode: RISKY_MODES.includes(cfg.run?.permission_mode) ? cfg.run.permission_mode : '' });
const digest = (cfg) => crypto.createHash('sha256').update(JSON.stringify(trustedCommands(cfg))).digest('hex');
const key = (projectDir) => `${path.resolve(projectDir)}#commands`;
export const hasCommands = (cfg) => { const t = trustedCommands(cfg); return t.allow.length > 0 || !!t.stand || t.extra_args.length > 0 || !!t.mode; };
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
export const UNTRUSTED_COMMANDS = 'run.allow, stand.command, run.extra_args или режим разрешений без проверок в mcfly/config.yaml изменены и не подтверждены владельцем — не действуют (режим — auto). Проверьте и подтвердите в терминале: mcfly trust';
