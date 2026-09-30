import path from 'node:path';
import { readText } from './util.js';

export function parseDotenv(text) {
  const out = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out[m[1]] = v;
  }
  return out;
}
/** Переменные, которые файл mcfly/.env перекрывает всегда: они задаются именно для прогонов команды. */
export const OVERRIDE_KEYS = new Set(['CLAUDE_CODE_OAUTH_TOKEN']);
/** Загружает <project>/mcfly/.env в env; заданные переменные окружения важнее файла, кроме непустых OVERRIDE_KEYS. */
export function loadEnv(projectDir, env = process.env) {
  const vars = parseDotenv(readText(path.join(projectDir, 'mcfly', '.env'), ''));
  // Пустая строка из шаблона (CLAUDE_CODE_OAUTH_TOKEN=) не должна затирать токен, заданный в окружении.
  for (const [k, v] of Object.entries(vars)) if (env[k] === undefined || (OVERRIDE_KEYS.has(k) && v !== '')) env[k] = v;
  return vars;
}
