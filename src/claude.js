import { spawn } from 'node:child_process';

export function buildClaudeArgs({ prompt, cfg, pluginDir }) {
  const args = ['-p', '--output-format', 'stream-json', '--verbose', '--permission-mode', cfg.run.permission_mode];
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

const LIMIT_RE = /usage limit|session limit|weekly limit|rate limit|limit reached|hit your [^.]*limit|too many requests|\b429\b|quota/i;

const isResultEvent = (obj) => obj && typeof obj === 'object' && (obj.type === 'result' || 'result' in obj || 'is_error' in obj);

/** Статистика субагентов из события result: сколько запущено, сколько стартовало фоном, упало и убито. */
function subagentsOf(stats) {
  if (!stats || typeof stats !== 'object') return null;
  const killed = Object.values(stats.killed || {}).reduce((sum, n) => sum + Number(n || 0), 0);
  return { spawned: stats.spawned ?? 0, background: stats.started_in_background ?? 0, failed: stats.failed ?? 0, killed };
}

export function parseResult({ exitCode, stdout, stderr, timedOut }) {
  // stream-json: по объекту на строку; событий result столько, сколько ходов сделал лид (CLI будит его по готовности фоновых задач),
  // статус и стоимость — по последнему, ходы — сумма. json: один объект (возможно многострочный).
  const results = [];
  for (const line of String(stdout || '').split('\n')) {
    if (!line.trim()) continue;
    try { const obj = JSON.parse(line); if (isResultEvent(obj)) results.push(obj); } catch {}
  }
  let json = results.at(-1) ?? null;
  if (!json) { try { const whole = JSON.parse(String(stdout || '').trim()); if (whole && typeof whole === 'object') { json = whole; results.push(whole); } } catch {} }
  const turnCounts = results.map((r) => r.num_turns).filter((n) => typeof n === 'number');
  const text = `${json?.result || ''}\n${stderr || ''}`;
  const failed = exitCode !== 0 || json?.is_error === true;
  let status = 'ok';
  if (timedOut) status = 'timeout';
  else if (failed && LIMIT_RE.test(text)) status = 'quota';
  else if (failed) status = 'error';
  return {
    status, json, costUsd: json?.total_cost_usd ?? null, turns: turnCounts.length ? turnCounts.reduce((a, b) => a + b, 0) : null,
    subagents: subagentsOf(json?.subagent_stats), sessionId: json?.session_id ?? null, resultText: json?.result ?? '',
    errorText: status === 'ok' ? '' : String(json?.result || stderr || `exit ${exitCode}`).slice(0, 2000),
  };
}

/** Краткая человекочитаемая строка по событию stream-json (или null, если событие неинтересно). */
export function summarizeEvent(line) {
  let ev; try { ev = JSON.parse(line); } catch { return null; }
  const short = (t) => String(t || '').replace(/\s+/g, ' ').trim().slice(0, 160);
  if (ev.type === 'assistant') {
    const parts = ev.message?.content || [];
    const out = [];
    for (const c of parts) {
      if (c.type === 'tool_use') {
        const inp = c.input || {};
        const arg = inp.command || inp.description || inp.file_path || inp.prompt || inp.pattern || '';
        out.push(`→ ${c.name}${arg ? ': ' + short(arg) : ''}`);
      } else if (c.type === 'text' && c.text?.trim()) out.push(`💬 ${short(c.text)}`);
    }
    return out.length ? out.join('\n') : null;
  }
  if (ev.type === 'result') return `■ результат: ${ev.is_error ? 'ошибка' : 'ок'}, ходов ${ev.num_turns ?? '?'}, ~$${ev.total_cost_usd ?? '?'}`;
  return null;
}
