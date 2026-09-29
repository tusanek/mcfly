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

/** Коммитит служебные файлы прогона (журнал, метрики, каталог прогона), чтобы рабочее дерево оставалось чистым для следующего прогона. */
export function commitRunState(projectDir, id, log = console.log) {
  const inRepo = spawnSync('git', ['rev-parse', '--is-inside-work-tree'], { cwd: projectDir, encoding: 'utf8' });
  if (inRepo.status !== 0) return false;
  const candidates = ['mcfly/progress.md', 'mcfly/metrics.jsonl', 'mcfly/questions.yaml', 'mcfly/answers.md', ...['result.json', 'summary.md', 'prompt.md', 'validate.json', 'events.log'].map((f) => `mcfly/runs/${id}/${f}`)];
  const existing = candidates.filter((f) => fs.existsSync(path.join(projectDir, f)));
  if (!existing.length) return false;
  spawnSync('git', ['add', '--', ...existing], { cwd: projectDir, encoding: 'utf8' });
  const staged = spawnSync('git', ['diff', '--cached', '--quiet'], { cwd: projectDir });
  if (staged.status === 0) return false;
  const r = spawnSync('git', ['commit', '-q', '-m', `chore(mcfly): результат прогона ${id}`], { cwd: projectDir, encoding: 'utf8' });
  if (r.status !== 0) log(`Не удалось закоммитить файлы прогона: ${String(r.stderr || r.stdout).trim().slice(0, 200)}`);
  return r.status === 0;
}

/** Страховочная сводка, если репортёр не написал summary.md: коммиты прогона, ветки change/*, последнее сообщение лида. */
export function writeFallbackSummary({ projectDir, runDir, id, started, resultText }) {
  const file = path.join(runDir, 'summary.md');
  if (fs.existsSync(file)) return false;
  const git = (args) => String(spawnSync('git', args, { cwd: projectDir, encoding: 'utf8' }).stdout || '').trim();
  const commits = git(['log', '--all', '--oneline', `--since=${started.toISOString()}`]) || '(нет коммитов)';
  const branches = git(['branch', '--list', 'change/*', '--format=%(refname:short)']).split('\n').filter(Boolean);
  const branchLines = branches.map((b) => {
    const tasks = git(['show', `${b}:openspec/changes/${b.replace(/^change\//, '')}/tasks.md`]);
    const done = (tasks.match(/^\s*- \[x\]/gim) || []).length; const open = (tasks.match(/^\s*- \[ \]/gim) || []).length;
    return `- ${b}: ${done} сделано / ${open} открыто`;
  });
  const text = [`# Прогон ${id} — авто-сводка (репортёр не отработал)`, '', '## Коммиты за прогон', commits, '', '## Ветки изменений', branchLines.join('\n') || '(нет)', '', '## Последнее сообщение лида', String(resultText || '').slice(0, 600) || '(пусто)', ''].join('\n');
  fs.writeFileSync(file, text);
  return true;
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
      commitRunState(projectDir, id, log);
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
    const args = buildClaudeArgs({ prompt, cfg, pluginDir: MCFLY_ROOT });
    if (dryRun) {
      // Сухой прогон не оставляет следов в mcfly/runs: промпт кладём в logs (вне git).
      const dryPath = path.join(p.logs, `dry-run-${id}.prompt.md`);
      fs.writeFileSync(dryPath, prompt);
      log(`[dry-run] ${cfg.run.claude_bin} ${args.slice(0, -1).join(' ')} "<промпт ${prompt.length} символов, сохранён в ${path.relative(projectDir, dryPath)}>"`);
      return { status: 'dry-run', id, prompt, promptPath: dryPath };
    }
    const runDir = ensureDir(path.join(p.runs, id));
    fs.writeFileSync(path.join(runDir, 'prompt.md'), prompt);
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
    const fallback = writeFallbackSummary({ projectDir, runDir, id, started, resultText: parsed.resultText || parsed.errorText });
    const validate = runOpenspecValidate(projectDir);
    fs.writeFileSync(path.join(runDir, 'validate.json'), JSON.stringify(validate, null, 2));
    const git = spawnSync('git', ['status', '--porcelain'], { cwd: projectDir, encoding: 'utf8' });
    const dirty = String(git.stdout || '').trim().split('\n').filter(Boolean).length;
    const record = {
      id, mode, slot, started_at: started.toISOString(), ended_at: new Date().toISOString(), status: parsed.status, duration_ms: result.durationMs, exit_code: result.exitCode,
      cost_usd: parsed.costUsd, turns: parsed.turns, session_id: parsed.sessionId, validate_ok: validate.ok, dirty_files: dirty, error: parsed.errorText,
      note: [parsed.status !== 'ok' ? parsed.errorText.split('\n')[0] : '', fallback ? 'репортёр не написал отчёт, записана авто-сводка' : '', validate.available && validate.ok === false ? 'openspec validate: есть ошибки' : '', dirty ? `незакоммиченных файлов: ${dirty}` : ''].filter(Boolean).join('; '),
    };
    recordRun(p, record);
    commitRunState(projectDir, id, log);
    log(`Прогон ${id} завершён: ${record.status} (${fmtLocal(new Date())}).`);
    return { status: record.status, id };
  } finally { releaseLock(p); }
}
