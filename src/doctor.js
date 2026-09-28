import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { paths } from './state.js';
import { loadConfig } from './config.js';
import { loadEnv } from './env.js';
import { exists } from './util.js';
import { MCFLY_ROOT } from './prompt.js';

function ver(bin, args = ['--version']) { const r = spawnSync(bin, args, { encoding: 'utf8' }); return r.status === 0 ? String(r.stdout || r.stderr).trim().split('\n')[0] : null; }

export function doctor({ projectDir, log = console.log }) {
  const p = paths(projectDir); loadEnv(projectDir);
  const checks = [];
  const add = (ok, label, hint = '') => checks.push({ ok: !!ok, label, hint });
  add(exists(p.config), 'mcfly/config.yaml', 'выполните mcfly init');
  let cfg = null;
  try { cfg = loadConfig(p.config); add(true, 'конфигурация валидна'); } catch (e) { add(false, 'конфигурация валидна', e.message); }
  const node = ver('node', ['-v']); add(node, `node ${node || ''}`);
  const claude = ver('claude'); add(claude, `claude ${claude || ''}`, 'установите Claude Code CLI');
  const openspec = ver('openspec'); add(openspec, `openspec ${openspec || ''}`, 'npm install -g @fission-ai/openspec@latest');
  add(ver('git'), 'git');
  add(process.platform !== 'darwin' || exists('/usr/bin/caffeinate'), 'caffeinate (macOS)');
  add(exists(path.join(MCFLY_ROOT, '.claude-plugin', 'plugin.json')), `плагин mcfly (${MCFLY_ROOT})`);
  if (cfg) {
    add(process.env[cfg.telegram.token_env], `токен Telegram (${cfg.telegram.token_env})`, 'задайте в mcfly/.env');
    add(cfg.telegram.chat_id, 'Telegram chat_id', 'выполните mcfly telegram pair');
  }
  add(exists(path.join(projectDir, 'openspec', 'config.yaml')), 'openspec/ инициализирован', 'openspec init --tools claude');
  add(exists(path.join(projectDir, '.git')), 'git-репозиторий проекта', 'git init');
  for (const c of checks) log(`${c.ok ? '✓' : '✗'} ${c.label}${c.ok || !c.hint ? '' : ' — ' + c.hint}`);
  return checks;
}
