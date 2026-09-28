import path from 'node:path';
import fs from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { paths } from './state.js';
import { loadConfig } from './config.js';
import { loadEnv } from './env.js';
import { matchSlot } from './window.js';
import { buildClaudeArgs, runProcess, parseResult, cleanEnv, summarizeEvent } from './claude.js';
import { buildContext } from './context.js';
import { buildLeadPrompt, MCFLY_ROOT } from './prompt.js';
import { appendMetric } from './metrics.js';
import { loadQuestions, saveQuestions, expireQuestions } from './questions.js';
import { listChanges, expireApprovals } from './approvals.js';
import { pullAnswers } from './pull.js';
import { ensureDir, writeJson, appendText, readJson, runId as makeRunId, fmtLocal } from './util.js';

export function acquireLock(p) {
  const existing = readJson(p.lock, null);
  if (existing?.pid) { try { process.kill(existing.pid, 0); return false; } catch { /* процесса нет — лок устарел */ } }
  writeJson(p.lock, { pid: process.pid, at: new Date().toISOString() });
  return true;
}
export function releaseLock(p) { try { fs.unlinkSync(p.lock); } catch {} }

export function recordRun(p, record) {
  ensureDir(path.join(p.runs, record.id));
  writeJson(path.join(p.runs, record.id, 'result.json'), record);
  appendMetric(p, { type: 'run', ...record });
  const cost = record.cost_usd != null ? `, ~$${Number(record.cost_usd).toFixed(2)}` : '';
  const turns = record.turns != null ? `, ${record.turns} ходов` : '';
  appendText(p.progress, `- ${fmtLocal(new Date(record.started_at))} прогон ${record.id} (${record.mode}${record.slot ? ', слот ' + record.slot : ''}): ${record.status}${turns}${cost}${record.note ? ' — ' + record.note : ''}\n`);
}

export function runOpenspecValidate(projectDir) {
  const r = spawnSync('openspec', ['validate', '--all', '--strict', '--json'], { cwd: projectDir, encoding: 'utf8' });
  if (r.error) return { available: false, ok: null, output: String(r.error) };
  return { available: true, ok: r.status === 0, output: String(r.stdout || r.stderr || '').slice(0, 20000) };
}

/** Прогон команды. mode: night (с проверкой окна слота) | day. */
export async function run({ projectDir, mode = 'day', dryRun = false, now = new Date(), log = console.log }) {
  const p = paths(projectDir);
  loadEnv(projectDir);
  const cfg = loadConfig(p.config);
  ensureDir(p.runs); ensureDir(p.logs);
  const id = makeRunId(now);
  let slot = null;
  if (mode === 'night') {
    slot = matchSlot(now, cfg.schedule.slots, cfg.schedule.tolerance_minutes);
    if (!slot) {
      recordRun(p, { id, mode, slot: null, started_at: now.toISOString(), ended_at: now.toISOString(), status: 'missed', note: `вне окна запуска (слоты ${cfg.schedule.slots.join(', ')} +${cfg.schedule.tolerance_minutes} мин): Mac был выключен или спал` });
      log(`Прогон ${id}: вне окна, записан как пропущенный.`);
      return { status: 'missed', id };
    }
  }
  if (!acquireLock(p)) { log('Другой прогон уже идёт (mcfly/.lock).'); return { status: 'locked', id }; }
  try {
    if (!dryRun) {
      try { await pullAnswers({ projectDir, cfg, p, log, now }); } catch (e) { log(`Telegram недоступен: ${e.message}`); }
      const qdata = loadQuestions(p);
      const defaulted = expireQuestions(qdata, cfg, now); saveQuestions(p, qdata);
      for (const q of defaulted) appendText(p.answers, `\n## ${fmtLocal(now)} — ${q.id} закрыт по умолчанию (срок истёк)\n${q.default || '(ответа по умолчанию нет)'}\n`);
      for (const c of expireApprovals(listChanges(p.openspecChanges), cfg, now)) appendText(p.answers, `\n## ${fmtLocal(now)} — ${c.name} одобрено автоматически (срок истёк)\n`);
    }
    const deadline = new Date(now.getTime() + cfg.run.max_minutes * 60_000);
    const prompt = buildLeadPrompt({ cfg, p, runId: id, mode, deadline, context: buildContext(p, cfg) });
    const runDir = ensureDir(path.join(p.runs, id));
    fs.writeFileSync(path.join(runDir, 'prompt.md'), prompt);
    const args = buildClaudeArgs({ prompt, cfg, pluginDir: MCFLY_ROOT });
    if (dryRun) { log(`[dry-run] ${cfg.run.claude_bin} ${args.slice(0, -1).join(' ')} "<промпт ${prompt.length} символов, сохранён в ${path.relative(projectDir, runDir)}/prompt.md>"`); return { status: 'dry-run', id, prompt }; }
    if (process.platform === 'darwin') { try { spawn('caffeinate', ['-i', '-w', String(process.pid)], { stdio: 'ignore', detached: true }).unref(); } catch {} }
    const env = { ...cleanEnv(process.env), MCFLY_RUN_ID: id, MCFLY_PROJECT_DIR: projectDir, PATH: `${path.join(MCFLY_ROOT, 'bin')}:${process.env.PATH || ''}` };
    const logStream = fs.createWriteStream(path.join(runDir, 'stdout.log'));
    const eventsStream = fs.createWriteStream(path.join(runDir, 'events.log'));
    let pending = '';
    const onLine = (line) => { const s = summarizeEvent(line); if (s) eventsStream.write(`${fmtLocal(new Date())} ${s}\n`); };
    const onStdout = (chunk) => { logStream.write(chunk); pending += chunk; const lines = pending.split('\n'); pending = lines.pop(); for (const l of lines) if (l.trim()) onLine(l); };
    const started = new Date();
    log(`Прогон ${id} (${mode}${slot ? ', слот ' + slot : ''}) запущен, лимит ${cfg.run.max_minutes} мин.`);
    const result = await runProcess({ bin: cfg.run.claude_bin, args, cwd: projectDir, env, timeoutMs: cfg.run.max_minutes * 60_000, onStdout, onStderr: (s) => logStream.write(s) });
    if (pending.trim()) onLine(pending);
    logStream.end(); eventsStream.end();
    const parsed = parseResult(result);
    const validate = runOpenspecValidate(projectDir);
    fs.writeFileSync(path.join(runDir, 'validate.json'), JSON.stringify(validate, null, 2));
    const git = spawnSync('git', ['status', '--porcelain'], { cwd: projectDir, encoding: 'utf8' });
    const dirty = String(git.stdout || '').trim().split('\n').filter(Boolean).length;
    const record = {
      id, mode, slot, started_at: started.toISOString(), ended_at: new Date().toISOString(), status: parsed.status, duration_ms: result.durationMs, exit_code: result.exitCode,
      cost_usd: parsed.costUsd, turns: parsed.turns, session_id: parsed.sessionId, validate_ok: validate.ok, dirty_files: dirty, error: parsed.errorText,
      note: [parsed.status !== 'ok' ? parsed.errorText.split('\n')[0] : '', validate.available && validate.ok === false ? 'openspec validate: есть ошибки' : '', dirty ? `незакоммиченных файлов: ${dirty}` : ''].filter(Boolean).join('; '),
    };
    recordRun(p, record);
    log(`Прогон ${id} завершён: ${record.status} (${fmtLocal(new Date())}).`);
    return { status: record.status, id };
  } finally { releaseLock(p); }
}
