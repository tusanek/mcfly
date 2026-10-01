import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { paths } from './state.js';
import { loadConfig } from './config.js';
import { loadEnv } from './env.js';
import { exists } from './util.js';
import { MCFLY_ROOT } from './prompt.js';
import { cleanEnv } from './claude.js';
import { vpnStatus } from './vpn.js';

function ver(bin, args = ['--version']) { const r = spawnSync(bin, args, { encoding: 'utf8' }); return r.status === 0 ? String(r.stdout || r.stderr).trim().split('\n')[0] : null; }

export function doctor({ projectDir, probe = false, log = console.log }) {
  const p = paths(projectDir); loadEnv(projectDir);
  const checks = [];
  const add = (ok, label, hint = '') => checks.push({ ok: !!ok, label, hint });
  add(exists(p.config), 'mcfly/config.yaml', 'выполните mcfly init');
  let cfg = null;
  try { cfg = loadConfig(p.config); add(true, 'конфигурация валидна'); } catch (e) { add(false, 'конфигурация валидна', e.message); }
  const node = ver('node', ['-v']); add(node, `node ${node || ''}`);
  // Проверяем тот claude и того лида, с которыми пойдёт прогон (run.claude_bin, run.lead_agent), а не значения по умолчанию.
  const bin = cfg?.run.claude_bin || 'claude'; const agent = cfg?.run.lead_agent || 'mcfly:lead';
  const claude = ver(bin); add(claude, `claude ${claude || ''}`, 'установите Claude Code CLI');
  if (claude) {
    const r = spawnSync(bin, ['auth', 'status'], { env: cleanEnv(process.env), encoding: 'utf8' });
    let loggedIn = false; try { loggedIn = !!JSON.parse(r.stdout || '{}').loggedIn; } catch {}
    add(loggedIn, 'claude CLI авторизован для прогонов', 'войдите: claude (затем /login) или claude setup-token → CLAUDE_CODE_OAUTH_TOKEN в mcfly/.env');
    const tok = process.env.CLAUDE_CODE_OAUTH_TOKEN || '';
    add(true, `· CLAUDE_CODE_OAUTH_TOKEN: ${tok ? `задан, ${tok.length} символов, префикс ${tok.slice(0, 11)}…` : 'не задан (используется вход CLI из связки ключей)'}`);
    add(true, `· ANTHROPIC_BASE_URL в окружении: ${process.env.ANTHROPIC_BASE_URL ? 'есть (прогон его уберёт)' : 'нет'}; вложенная сессия Claude: ${process.env.CLAUDECODE === '1' ? 'да' : 'нет'}`);
    if (probe) {
      const pr = spawnSync(bin, ['-p', '--output-format', 'json', '--plugin-dir', MCFLY_ROOT, '--agent', agent, 'Проверка. Ответь одним словом: ок'], { env: cleanEnv(process.env), encoding: 'utf8', timeout: 180_000 });
      let res = null; try { res = JSON.parse(String(pr.stdout || '').trim().split('\n').pop() || '{}'); } catch {}
      add(pr.status === 0 && res && !res.is_error, `пробный запуск claude -p с агентом ${agent}${res?.result ? ': ' + String(res.result).slice(0, 60).replace(/\n/g, ' ') : ''}`, String(res?.result || pr.stderr || '').slice(0, 200).replace(/\n/g, ' ') + ' — при 401 повторите вход (claude /login или claude setup-token)');
    }
  }
  const openspec = ver('openspec'); add(openspec, `openspec ${openspec || ''}`, 'npm install -g @fission-ai/openspec@latest');
  add(ver('git'), 'git');
  add(process.platform !== 'darwin' || exists('/usr/bin/caffeinate'), 'caffeinate (macOS)');
  add(exists(path.join(MCFLY_ROOT, '.claude-plugin', 'plugin.json')), `плагин mcfly (${MCFLY_ROOT})`);
  if (cfg) {
    add(process.env[cfg.telegram.token_env], `токен Telegram (${cfg.telegram.token_env})`, 'задайте в mcfly/.env');
    add(cfg.telegram.chat_id, 'Telegram chat_id', 'выполните mcfly telegram pair');
    if (cfg.run.vpn_service) { const st = vpnStatus(cfg.run.vpn_service, { scutil: cfg.run.scutil_bin }); add(st, `VPN «${cfg.run.vpn_service}»: ${st || 'не найден'}`, 'имя сервиса — как в scutil --nc list'); }
  }
  add(exists(path.join(projectDir, 'openspec', 'config.yaml')), 'openspec/ инициализирован', 'openspec init --tools claude');
  add(exists(path.join(projectDir, '.git')), 'git-репозиторий проекта', 'git init');
  for (const c of checks) log(c.label.startsWith('·') ? `  ${c.label}` : `${c.ok ? '✓' : '✗'} ${c.label}${c.ok || !c.hint ? '' : ' — ' + c.hint}`);
  return checks;
}
