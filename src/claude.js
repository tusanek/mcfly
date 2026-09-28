import { spawn } from 'node:child_process';

export function buildClaudeArgs({ prompt, cfg, pluginDir }) {
  const args = ['-p', '--output-format', 'json', '--permission-mode', cfg.run.permission_mode];
  if (pluginDir) args.push('--plugin-dir', pluginDir);
  if (cfg.run.lead_agent) args.push('--agent', cfg.run.lead_agent);
  if (cfg.run.model) args.push('--model', cfg.run.model);
  if (cfg.run.max_budget_usd > 0) args.push('--max-budget-usd', String(cfg.run.max_budget_usd));
  args.push(...(cfg.run.extra_args || []));
  args.push(prompt);
  return args;
}

/** Запуск дочернего процесса без оболочки (массив аргументов), с таймаутом. */
export function runProcess({ bin, args, cwd, env, timeoutMs, onStdout, onStderr }) {
  return new Promise((resolve) => {
    const started = Date.now();
    let stdout = '', stderr = '', timedOut = false;
    const child = spawn(bin, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGTERM'); setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, 30_000).unref(); }, timeoutMs);
    child.stdout.on('data', (d) => { const s = d.toString(); stdout += s; onStdout?.(s); });
    child.stderr.on('data', (d) => { const s = d.toString(); stderr += s; onStderr?.(s); });
    const done = (exitCode, extra = '') => { clearTimeout(timer); resolve({ exitCode, stdout, stderr: stderr + extra, timedOut, durationMs: Date.now() - started, pid: child.pid }); };
    child.on('error', (err) => done(-1, String(err)));
    child.on('close', (code) => done(code));
  });
}

/** Убирает переменные, которые Claude Code подставляет во вложенные процессы своей сессии: с ними отдельный claude -p не проходит авторизацию. */
const KEEP = new Set(['CLAUDE_CODE_PLUGIN_DIRS', 'CLAUDE_CODE_OAUTH_TOKEN']);
export function cleanEnv(env) {
  const nested = env.CLAUDECODE === '1' || env.CLAUDE_CODE_CHILD_SESSION === '1';
  const ownToken = !!env.CLAUDE_CODE_OAUTH_TOKEN;
  const out = {};
  for (const [k, v] of Object.entries(env)) {
    if (k === 'CLAUDECODE' || k === 'CLAUDE_PID' || k === 'CLAUDE_EFFORT' || k === 'CLAUDE_AGENT_SDK_VERSION' || k === 'CLAUDE_PREVIEW_CLASSIFIER_FLOOR') continue;
    if (k.startsWith('CLAUDE_CODE_') && !KEEP.has(k)) continue;
    // Внутри сессии Claude Code или при собственном токене прогонов — только стандартный эндпоинт и токен из .env.
    if ((nested || ownToken) && (k === 'ANTHROPIC_BASE_URL' || k === 'ANTHROPIC_AUTH_TOKEN' || k === 'ANTHROPIC_API_KEY')) continue;
    out[k] = v;
  }
  return out;
}

const LIMIT_RE = /usage limit|rate limit|limit reached|too many requests|\b429\b|quota/i;

export function parseResult({ exitCode, stdout, stderr, timedOut }) {
  const trimmed = String(stdout || '').trim();
  const start = trimmed.lastIndexOf('\n{');
  const candidate = trimmed.startsWith('{') ? trimmed : (start >= 0 ? trimmed.slice(start + 1) : '');
  let json = null;
  try { json = candidate ? JSON.parse(candidate) : null; } catch { json = null; }
  const text = `${json?.result || ''}\n${stderr || ''}`;
  const failed = exitCode !== 0 || json?.is_error === true;
  let status = 'ok';
  if (timedOut) status = 'timeout';
  else if (failed && LIMIT_RE.test(text)) status = 'quota';
  else if (failed) status = 'error';
  return { status, json, costUsd: json?.total_cost_usd ?? null, turns: json?.num_turns ?? null, sessionId: json?.session_id ?? null, resultText: json?.result ?? '', errorText: status === 'ok' ? '' : String(json?.result || stderr || `exit ${exitCode}`).slice(0, 2000) };
}
