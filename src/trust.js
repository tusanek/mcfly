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
export const trustedCommands = (cfg) => ({ allow: [...(cfg.run?.allow || [])], stand: String(cfg.stand?.command || '') });
const digest = (cfg) => crypto.createHash('sha256').update(JSON.stringify(trustedCommands(cfg))).digest('hex');
const key = (projectDir) => `${path.resolve(projectDir)}#commands`;
export const hasCommands = (cfg) => { const t = trustedCommands(cfg); return t.allow.length > 0 || !!t.stand; };
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
export const UNTRUSTED_COMMANDS = 'run.allow и stand.command в mcfly/config.yaml изменены и не подтверждены владельцем — не действуют. Проверьте и подтвердите в терминале: mcfly trust';
