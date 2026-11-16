import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { paths } from './state.js';
import { loadConfig } from './config.js';
import { loadEnv } from './env.js';
import { exists } from './util.js';
import { MCFLY_ROOT } from './prompt.js';
import { cleanEnv } from './claude.js';
import { vpnStatus } from './vpn.js';
import { isTrusted, hasActions } from './actions.js';
import { mainBranchIssue } from './init.js';
import { labelFor, runLaunchctl } from './schedule.js';
import { readPower, powerChecks } from './power.js';
import { videoProblems } from './video.js';

function ver(bin, args = ['--version']) { const r = spawnSync(bin, args, { encoding: 'utf8' }); return r.status === 0 ? String(r.stdout || r.stderr).trim().split('\n')[0] : null; }

export function doctor({ projectDir, probe = false, log = console.log, launchctl = runLaunchctl, power = process.platform === 'darwin' ? readPower : null, video = videoProblems }) {
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
  // 0.11.3: спящий Mac launchd не будит — прогоны по расписанию и опрос бота молча пропускаются
  if (power) for (const c of powerChecks(power())) add(c.ok, c.label, c.hint);
  add(exists(path.join(MCFLY_ROOT, '.claude-plugin', 'plugin.json')), `плагин mcfly (${MCFLY_ROOT})`);
  if (cfg && hasActions(cfg)) {
    add(isTrusted(p, cfg), `действия в боте (${Object.keys(cfg.actions).join(', ')}) подтверждены владельцем`, 'проверьте команды раздела actions и выполните в терминале: mcfly action trust');
  }
  if (cfg) {
    add(process.env[cfg.telegram.token_env], `токен Telegram (${cfg.telegram.token_env})`, 'задайте в mcfly/.env');
    add(cfg.telegram.chat_id, 'Telegram chat_id', 'выполните mcfly telegram pair');
    // 0.11.0: нажатия кнопок и сообщения забирает только задание answers — без него бот молчит, и непонятно почему
    if (process.platform === 'darwin' && process.env[cfg.telegram.token_env] && cfg.telegram.chat_id && cfg.schedule.answers_every_minutes > 0) {
      const label = labelFor(cfg.project, 'answers');
      let loaded = false; try { loaded = launchctl(['print', `gui/${process.getuid()}/${label}`]).status === 0; } catch {}
      add(loaded, loaded ? 'бот отвечает на кнопки и сообщения (задание answers работает)' : 'бот не будет отвечать на кнопки и сообщения — нет задания answers', 'выполните mcfly schedule install');
    }
    if (cfg.run.vpn_service) { const st = vpnStatus(cfg.run.vpn_service, { scutil: cfg.run.scutil_bin }); add(st, `VPN «${cfg.run.vpn_service}»: ${st || 'не найден'}`, 'имя сервиса — как в scutil --nc list'); }
  }
  if (cfg?.video?.enabled) {
    // 0.12.0: ролик-сводка включён — проверяем сборщик, окружение озвучки и модель голоса
    const missing = video(cfg);
    if (missing.length) for (const m of missing) add(false, `ролик-сводка: ${m.label}`, m.hint);
    else add(true, `ролик-сводка: сборщик и озвучка на месте (голос ${cfg.video.voice})`);
  }
  for (const name of cfg?.design?.skills || []) {
    // Навык из дополнения («дополнение:навык») по папкам не проверить — только предупреждаем
    if (name.includes(':')) { add(true, `· навык дизайна ${name}: из дополнения, наличие не проверяю`); continue; }
    const at = [path.join(projectDir, '.claude', 'skills', name), path.join(os.homedir(), '.claude', 'skills', name)].find((d) => exists(path.join(d, 'SKILL.md')));
    add(at, `навык дизайна ${name}${at ? ` (${at.startsWith(projectDir) ? 'в проекте' : 'в общих настройках'})` : ''}`, 'установите навык в .claude/skills проекта или в ~/.claude/skills, либо уберите его из design.skills');
  }
  add(exists(path.join(projectDir, 'openspec', 'config.yaml')), 'openspec/ инициализирован', 'openspec init --tools claude');
  add(exists(path.join(projectDir, '.git')), 'git-репозиторий проекта', 'git init');
  const branch = mainBranchIssue(projectDir);
  if (exists(path.join(projectDir, '.git'))) add(!branch, 'ветка main в проекте', branch.replace(/^В проекте нет ветки main — /, ''));
  for (const c of checks) log(c.label.startsWith('·') ? `  ${c.label}` : `${c.ok ? '✓' : '✗'} ${c.label}${c.ok || !c.hint ? '' : ' — ' + c.hint}`);
  return checks;
}
