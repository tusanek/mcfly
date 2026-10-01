import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import { paths } from './state.js';
import { loadConfig } from './config.js';
import { loadEnv } from './env.js';
import { matchSlot } from './window.js';
import { buildClaudeArgs, runProcess, parseResult, cleanEnv, summarizeEvent, maskSecrets } from './claude.js';
import { buildContext } from './context.js';
import { buildLeadPrompt, MCFLY_ROOT } from './prompt.js';
import { appendMetric, runStats, readMetrics } from './metrics.js';
import { activeDayHandoff, latestShift, renderAutoHandoff, writeShift, shiftFileName } from './shift-files.js';
import { loadQuestions, saveQuestions, expireQuestions } from './questions.js';
import { listChanges, expireApprovals } from './approvals.js';
import { pullAnswers } from './pull.js';
import { createTelegram } from './telegram.js';
import { ensureVpn } from './vpn.js';
import { STATUS_RU } from './summary.js';
import { dirtyFiles, teamWorktrees, branchProgress, changedTrackedFiles } from './git.js';
import { ensureDir, writeJson, appendText, readJson, readText, runId as makeRunId, fmtLocal, fmtDuration, pad2 } from './util.js';

/** Команда процесса по pid (ps) или null, если узнать не удалось. */
function processCommand(pid) {
  const r = spawnSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : null;
}
/**
 * Держит ли лок живой прогон. Прогон mcfly держит лок, сколько бы ни шёл: Mac мог спать посреди прогона, и время по часам
 * больше лимита. Если pid после сбоя питания достался постороннему процессу — лок брошен. Без ps судим по возрасту (maxAgeMs).
 */
function lockHeld({ pid, at }, maxAgeMs) {
  if (pid === process.pid) return true;
  try { process.kill(pid, 0); } catch { return false; } // процесса нет
  const command = processCommand(pid);
  if (command !== null) return /\bmcfly\b.*\brun\b/.test(command);
  return Date.now() - new Date(at || 0).getTime() < maxAgeMs;
}
export function acquireLock(p, { maxAgeMs = Infinity, id = null } = {}) {
  const existing = readJson(p.lock, null);
  if (existing?.pid && lockHeld(existing, maxAgeMs)) return false;
  writeJson(p.lock, { pid: process.pid, at: new Date().toISOString(), ...(id ? { id } : {}) });
  return true;
}
/** Идущий прогон: id (из лока, у старых локов — самый новый каталог runs), время старта и последняя строка events.log; null — прогона нет. */
export function currentRun(p) {
  const lock = readJson(p.lock, null);
  if (!lock?.pid || !lockHeld(lock, Infinity)) return null;
  let id = lock.id;
  if (!id) { try { id = fs.readdirSync(p.runs).filter((d) => /^\d{8}-\d{4}$/.test(d)).sort().at(-1) || null; } catch { id = null; } }
  const lastEvent = id ? readText(path.join(p.runs, id, 'events.log'), '').trim().split('\n').filter(Boolean).at(-1) || '' : '';
  return { id, since: new Date(lock.at), lastEvent };
}
/** Снимает только свой лок: прогон, наткнувшийся на чужой, лок идущего прогона не трогает. */
export function releaseLock(p) { if (readJson(p.lock, null)?.pid === process.pid) { try { fs.unlinkSync(p.lock); } catch {} } }

/**
 * Окружение claude -p для прогона. Фоновые задачи отключены: в -p CLI ждёт фоновых субагентов после последнего хода лида
 * не дольше CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS (10 минут простоя) и убивает их (прогон 20260929-0400), поэтому субагенты
 * только синхронные. Потолок снят на случай, если фон всё же появится: прогон ограничивает таймаут runner.
 */
export function runEnv(baseEnv, { id, projectDir, hide = [] }) {
  const env = {
    ...cleanEnv(baseEnv), MCFLY_RUN_ID: id, MCFLY_PROJECT_DIR: projectDir, PATH: `${path.join(MCFLY_ROOT, 'bin')}:${baseEnv.PATH || ''}`,
    CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '1', CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS: '0',
  };
  for (const k of hide) delete env[k]; // секреты runner'а (токен Telegram) агентам не нужны: их Bash видит всё окружение
  return env;
}

/** Режет поток на строки: push(кусок) вызывает onLine для каждой полной непустой строки, flush() — для хвоста. */
function lineSplitter(onLine) {
  let pending = '';
  return {
    push(chunk) { pending += chunk; const lines = pending.split('\n'); pending = lines.pop(); for (const l of lines) if (l.trim()) onLine(l); },
    flush() { if (pending.trim()) onLine(pending); pending = ''; },
  };
}

export function recordRun(p, record) {
  ensureDir(path.join(p.runs, record.id));
  writeJson(path.join(p.runs, record.id, 'result.json'), record);
  appendMetric(p, { type: 'run', ...record });
  appendText(p.progress, `- ${fmtLocal(new Date(record.started_at))} прогон ${record.id} (${record.mode}${record.slot ? ', слот ' + record.slot : ''}): ${record.status}${runStats(record)}${record.note ? ' — ' + record.note : ''}\n`);
}

/** Служебные файлы команды, которые runner коммитит сам после прогона: журнал, метрики, вопросы, ответы и каталоги прогонов. */
const STATE_PATHS = ['mcfly/progress.md', 'mcfly/metrics.jsonl', 'mcfly/questions.yaml', 'mcfly/answers.md', 'mcfly/runs', 'mcfly/shifts'];
const RAW_LOG = ':(exclude)mcfly/runs/*/stdout.log'; // сырой вывод claude не коммитится, даже если в .gitignore нет строки
/** Метаданные одобрения изменений (.openspec.yaml), изменённые runner'ом (авто-одобрение по сроку, ответы из Telegram) или человеком. */
const approvalMeta = (projectDir) => changedTrackedFiles(projectDir).filter((f) => /^openspec\/changes\/[^/]+\/\.openspec\.yaml$/.test(f));

/**
 * Коммитит служебные файлы прогона, чтобы рабочее дерево оставалось чистым для следующего прогона.
 * Только эти пути (commit -- <пути>): работа агентов, оставшаяся в индексе после обрыва, в коммит прогона не попадает.
 */
export function commitRunState(projectDir, id, log = console.log) {
  const inRepo = spawnSync('git', ['rev-parse', '--is-inside-work-tree'], { cwd: projectDir, encoding: 'utf8' });
  if (inRepo.status !== 0) return false;
  const existing = [...STATE_PATHS.filter((f) => fs.existsSync(path.join(projectDir, f))), ...approvalMeta(projectDir)];
  if (!existing.length) return false;
  const pathspec = ['--', ...existing, RAW_LOG];
  const add = spawnSync('git', ['add', ...pathspec], { cwd: projectDir, encoding: 'utf8' });
  if (add.status !== 0) { log(`Не удалось закоммитить файлы прогона: ${String(add.stderr || add.stdout).trim().slice(0, 200)}`); return false; }
  const staged = spawnSync('git', ['diff', '--cached', '--quiet', ...pathspec], { cwd: projectDir });
  if (staged.status === 0) return false;
  const r = spawnSync('git', ['commit', '-q', '-m', `chore(mcfly): результат прогона ${id}`, ...pathspec], { cwd: projectDir, encoding: 'utf8' });
  if (r.status !== 0) log(`Не удалось закоммитить файлы прогона: ${String(r.stderr || r.stdout).trim().slice(0, 200)}`);
  return r.status === 0;
}

/** Worktree команды с незакоммиченной работой: её теряет обрыв прогона, а следующему прогону её нужно подхватить. */
export function unfinishedWork(projectDir) { return teamWorktrees(projectDir).filter((w) => w.team && w.dirty > 0); }
const homeShort = (p) => (p.startsWith(`${os.homedir()}/`) ? `~${p.slice(os.homedir().length)}` : p);
export const describeWorktree = (w) => `${homeShort(w.path)} (${w.branch}, ${w.dirty})`;

/** Страховочная сводка, если репортёр не написал summary.md: коммиты прогона, ветки change/*, незакоммиченная работа, последнее сообщение лида. */
export function writeFallbackSummary({ projectDir, runDir, id, started, resultText }) {
  const file = path.join(runDir, 'summary.md');
  if (fs.existsSync(file)) return false;
  const git = (args) => String(spawnSync('git', args, { cwd: projectDir, encoding: 'utf8' }).stdout || '').trim();
  const commits = git(['log', '--all', '--oneline', `--since=${started.toISOString()}`]) || '(нет коммитов)';
  const branches = git(['branch', '--list', 'change/*', '--format=%(refname:short)']).split('\n').filter(Boolean);
  const branchLines = branches.map((b) => {
    const tasks = branchProgress(projectDir, b.replace(/^change\//, ''));
    return `- ${b}: ${tasks ? `${tasks.done} сделано / ${tasks.open} открыто` : 'tasks.md нет'}`;
  });
  const unfinished = unfinishedWork(projectDir).map((w) => `- ${describeWorktree(w)}`);
  const text = [`# Прогон ${id} — авто-сводка (репортёр не отработал)`, '', '## Коммиты за прогон', commits, '', '## Ветки изменений', branchLines.join('\n') || '(нет)',
    '', '## Worktree с незакоммиченной работой', unfinished.join('\n') || '(нет)', '', '## Последнее сообщение лида', String(resultText || '').slice(0, 600) || '(пусто)', ''].join('\n');
  fs.writeFileSync(file, text);
  return true;
}

export function runOpenspecValidate(projectDir) {
  const r = spawnSync('openspec', ['validate', '--all', '--strict', '--json'], { cwd: projectDir, encoding: 'utf8' });
  if (r.error) return { available: false, ok: null, output: String(r.error) };
  return { available: true, ok: r.status === 0, output: String(r.stdout || r.stderr || '').slice(0, 20000) };
}

const realSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Тревога в Telegram сразу, не дожидаясь утренней сводки. Без токена или chat_id — молча ничего. */
export function telegramNotifier(cfg) {
  return async (text) => {
    const token = process.env[cfg.telegram.token_env];
    if (!token || !cfg.telegram.chat_id) return;
    await createTelegram({ token }).sendMessage(cfg.telegram.chat_id, text);
  };
}

const FINISH_ICON = { ok: '✅', quota: '⏸', timeout: '⏱' };
/** Прогресс одобренных изменений: «add-x 1/2» — по ветке change/<имя>, если она есть, иначе по main. */
function approvedProgress(projectDir, p) {
  return listChanges(p.openspecChanges).filter((c) => c.mcfly.approval === 'approved').map((c) => {
    const b = branchProgress(projectDir, c.name) || { done: c.tasksDone, open: c.tasksOpen };
    return `${c.name} ${b.done}/${b.done + b.open}`;
  }).join(', ');
}
/** Сообщение в Telegram по окончании прогона: тревога при network и error, иначе короткий итог. */
export function finishText(cfg, record, progress = '') {
  if (['network', 'error'].includes(record.status)) return alertText(cfg, record);
  const start = new Date(record.started_at);
  const when = record.slot || `${pad2(start.getHours())}:${pad2(start.getMinutes())}`;
  return `${FINISH_ICON[record.status] || 'ℹ️'} mcfly ${cfg.project}: прогон ${when} завершён: ${STATUS_RU[record.status] || record.status}${runStats(record)}, ${fmtDuration(record.duration_ms || 0)}.${progress ? ` ${progress}.` : ''}`;
}

/** Текст тревоги о прогоне, который не выполнил работу и требует внимания человека. */
export function alertText(cfg, record) {
  const when = record.slot ? `прогон ${record.slot}` : `прогон ${record.id}`;
  const reason = record.error ? record.error.split('\n')[0].slice(0, 200) : '';
  if (record.status === 'network') {
    const vpn = (record.note || '').split('; ').filter((n) => n.startsWith('VPN «')).join('; ');
    return `⚠️ mcfly ${cfg.project}: ${when} не выполнен — нет доступа к API${reason ? ` (${reason})` : ''}, ${record.attempts} попыт${record.attempts === 1 ? 'ка' : record.attempts < 5 ? 'ки' : 'ок'}.${vpn ? ` ${vpn}.` : ''} Проверь VPN и интернет; следующий прогон — по расписанию.`;
  }
  return `⚠️ mcfly ${cfg.project}: ${when} завершился ошибкой${reason ? `: ${reason}` : ''}. Подробности — mcfly/runs/${record.id}/events.log.`;
}

/** Прогон команды. mode: night (с проверкой окна слота) | day. */
export async function run({ projectDir, mode = 'day', dryRun = false, now = new Date(), log = console.log, sleep = realSleep, notify = null, beforeAttempt = null }) {
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
  // Лок старше лимита прогона с запасом — брошенный: runner убивает claude по таймауту, живой прогон столько не держит лок.
  if (!acquireLock(p, { maxAgeMs: (cfg.run.max_minutes + 30) * 60_000, id })) {
    // Запись без коммита: коммитит идущий прогон. В сводке слот будет «не запущен (шёл другой прогон)», а не «Mac спал».
    if (!dryRun) recordRun(p, { id, mode, slot, started_at: now.toISOString(), ended_at: now.toISOString(), status: 'locked', note: 'шёл другой прогон (mcfly/.lock)' });
    log('Другой прогон уже идёт (mcfly/.lock).'); return { status: 'locked', id };
  }
  try {
    if (!dryRun) {
      try { await pullAnswers({ projectDir, cfg, p, log, now }); } catch (e) { log(`Telegram недоступен: ${e.message}`); }
      const qdata = loadQuestions(p);
      const defaulted = expireQuestions(qdata, cfg, now); saveQuestions(p, qdata);
      for (const q of defaulted) appendText(p.answers, `\n## ${fmtLocal(now)} — ${q.id} закрыт по умолчанию (срок истёк)\n${q.default || '(ответа по умолчанию нет)'}\n`);
      for (const c of expireApprovals(listChanges(p.openspecChanges), cfg, now)) appendText(p.answers, `\n## ${fmtLocal(now)} — ${c.name} одобрено автоматически (срок истёк)\n`);
      // Ночь без сданной смены — авто-передача по фактам (день работал, но смену не сдал).
      if (mode === 'night' && !activeDayHandoff(p)) writeShift(p, 'day', renderAutoHandoff(p, 'day', now), now);
    }
    const deadline = new Date(now.getTime() + cfg.run.max_minutes * 60_000);
    const lastSlot = mode === 'night' && slot === cfg.schedule.slots.at(-1);
    const nightFile = lastSlot ? `mcfly/shifts/${shiftFileName('night', now)}` : '';
    const nightHandoff = lastSlot ? `Это последний прогон ночи: репортёр также пишет ${nightFile} — передачу «ночь → день» по формату скилла mcfly-process (раздел «Передача смены»), со ссылками на прогоны ночи.` : '';
    const prompt = buildLeadPrompt({ cfg, p, runId: id, mode, deadline, context: buildContext(p, cfg), nightHandoff });
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
    const env = runEnv(process.env, { id, projectDir, hide: [cfg.telegram.token_env] });
    const logStream = fs.createWriteStream(path.join(runDir, 'stdout.log'));
    const eventsStream = fs.createWriteStream(path.join(runDir, 'events.log'));
    const event = (s) => eventsStream.write(`${fmtLocal(new Date())} ${s}\n`);
    const stdoutLines = lineSplitter((line) => { const s = summarizeEvent(line); if (s) event(s); });
    const stderrLines = lineSplitter((line) => event(`⚠ ${maskSecrets(line).trim().slice(0, 300)}`));
    const started = new Date();
    log(`Прогон ${id} (${mode}${slot ? ', слот ' + slot : ''}) запущен, лимит ${cfg.run.max_minutes} мин.`);
    // Нет доступа к API (упал VPN или сеть) — claude падает за секунды, работы не сделано: ждём и повторяем в пределах лимита прогона.
    const runDeadline = started.getTime() + cfg.run.max_minutes * 60_000;
    const retryMs = cfg.run.network_retry_minutes * 60_000;
    let result, parsed, attempts = 0, costUsd = null, turns = null;
    const vpnNotes = [];
    const checkVpn = async () => {
      const v = await ensureVpn(cfg.run.vpn_service, { scutil: cfg.run.scutil_bin, sleep });
      if (v.message) { event(`🔌 ${v.message}`); vpnNotes.push(v.message); }
      return v;
    };
    await checkVpn();
    for (;;) {
      attempts += 1;
      beforeAttempt?.(attempts);
      result = await runProcess({ bin: cfg.run.claude_bin, args, cwd: projectDir, env, timeoutMs: Math.max(60_000, runDeadline - Date.now()),
        onStdout: (chunk) => { logStream.write(chunk); stdoutLines.push(chunk); }, onStderr: (chunk) => { logStream.write(chunk); stderrLines.push(chunk); } });
      stdoutLines.flush(); stderrLines.flush();
      parsed = parseResult(result);
      // Стоимость и ходы — сумма по попыткам: прерванная попытка тоже тратила квоту.
      if (parsed.costUsd != null) costUsd = Math.round(((costUsd || 0) + parsed.costUsd) * 1e6) / 1e6;
      if (parsed.turns != null) turns = (turns || 0) + parsed.turns;
      if (parsed.status !== 'network' || attempts > cfg.run.network_retries || Date.now() + retryMs >= runDeadline) break;
      // VPN переподключён — повторяем сразу; иначе ждём, пока вернётся сеть.
      const reconnected = (await checkVpn()).action === 'reconnected';
      event(`↻ нет доступа к API (${parsed.errorText.split('\n')[0].slice(0, 120)}), повтор ${reconnected ? 'сразу' : `через ${cfg.run.network_retry_minutes} мин`} (попытка ${attempts + 1} из ${cfg.run.network_retries + 1})`);
      if (!reconnected) await sleep(retryMs);
    }
    logStream.end(); eventsStream.end();
    const fallback = writeFallbackSummary({ projectDir, runDir, id, started, resultText: parsed.resultText || parsed.errorText });
    const validate = runOpenspecValidate(projectDir);
    fs.writeFileSync(path.join(runDir, 'validate.json'), JSON.stringify(validate, null, 2));
    // Служебные файлы (журнал, метрики, каталоги прогонов, метаданные одобрений) runner коммитит сам — это не забытая работа.
    const committedByRunner = new Set(approvalMeta(projectDir));
    const dirty = dirtyFiles(projectDir, { exclude: STATE_PATHS }).filter((f) => !committedByRunner.has(f)).length;
    const unfinished = unfinishedWork(projectDir);
    const record = {
      id, mode, slot, started_at: started.toISOString(), ended_at: new Date().toISOString(), status: parsed.status, attempts, duration_ms: Date.now() - started.getTime(), exit_code: result.exitCode,
      cost_usd: costUsd, turns, subagents: parsed.subagents, session_id: parsed.sessionId, validate_ok: validate.ok, dirty_files: dirty, error: parsed.errorText,
      note: [parsed.status !== 'ok' ? parsed.errorText.split('\n')[0] : '', ...new Set(vpnNotes), fallback ? 'репортёр не написал отчёт, записана авто-сводка' : '', validate.available && validate.ok === false ? 'openspec validate: есть ошибки' : '',
        dirty ? `незакоммиченных файлов: ${dirty}` : '', unfinished.length ? `незакоммиченная работа в worktree: ${unfinished.map(describeWorktree).join(', ')}` : ''].filter(Boolean).join('; '),
    };
    recordRun(p, record);
    // Последний слот ночи: репортёр не оставил ночную передачу — собрать по фактам.
    if (lastSlot) {
      const night = latestShift(p, 'night'); const day = latestShift(p, 'day');
      if (!night || (day && night.at < day.at)) {
        const since = day ? day.at : '';
        const runs = readMetrics(p).filter((r) => r.type === 'run' && r.mode === 'night' && r.id >= since.replace(/-\d{4}$/, '') ).map((r) => r.id);
        writeShift(p, 'night', renderAutoHandoff(p, 'night', new Date(), { runs }), new Date());
      }
    }
    commitRunState(projectDir, id, log);
    // Итог любого прогона — сразу в Telegram: дневной прогон иначе молчит до утренней сводки.
    try { await (notify || telegramNotifier(cfg))(finishText(cfg, record, approvedProgress(projectDir, p))); } catch (e) { log(`Сообщение в Telegram не отправлено: ${e.message}`); }
    log(`Прогон ${id} завершён: ${record.status} (${fmtLocal(new Date())}).`);
    return { status: record.status, id };
  } finally { releaseLock(p); }
}
