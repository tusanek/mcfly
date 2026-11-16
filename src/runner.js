import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import { paths } from './state.js';
import { loadConfig, autoDefault } from './config.js';
import { loadEnv } from './env.js';
import { matchSlot, parseSlot } from './window.js';
import { buildClaudeArgs, runProcess, parseResult, cleanEnv, summarizeEvent, maskSecrets, permissionDenial, apiRetryWatch, rateLimitInfo } from './claude.js';
import { chainDecision } from './chain.js';
import { buildContext } from './context.js';
import { buildLeadPrompt, MCFLY_ROOT } from './prompt.js';
import { appendMetric, runStats, readMetrics } from './metrics.js';
import { activeDayHandoff, latestShift, renderAutoHandoff, writeShift, shiftFileName } from './shift-files.js';
import { loadQuestions, saveQuestions, expireQuestions, openQuestions } from './questions.js';
import { listChanges, expireApprovals, approvedWithWork, pendingApprovals, proposalExcerpt, approvalDeadline, isAutoApprovable, isPaused } from './approvals.js';
import { pullAnswers, errorLine, spawnDayRun } from './pull.js';
import { createTelegram } from './telegram.js';
import { ensureVpn } from './vpn.js';
import { STATUS_RU, plainWords, reportSections, humanItems, approvalCovered, isNone, nextRunText, progressWords, summaryKeyboard, changeTitle, planLabels } from './summary.js';
import { ideasBrief, loadIdeas, saveIdeas, syncDoneIdeas } from './ideas.js';
import { enqueueNotice } from './notices.js';
import { tickGoals } from './goals.js';
import { pendingFindings } from './findings.js';
import { ideasView, ideasKeyboard } from './overview.js';
import { dirtyFiles, teamWorktrees, branchProgress, changedTrackedFiles } from './git.js';
import { ensureDir, writeJson, appendText, readJson, readText, runId as makeRunId, fmtLocal, fmtShort, fmtDuration, pad2, truncate } from './util.js';

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
  // pull_lock: этот прогон читает Telegram под блокировкой опроса (0.5.4) — задание answers может опрашивать и во время него.
  writeJson(p.lock, { pid: process.pid, at: new Date().toISOString(), ...(id ? { id } : {}), pull_lock: true });
  return true;
}
/**
 * Идущий прогон: id (из лока, у старых локов — самый новый каталог runs), время старта, последняя строка events.log
 * и pullLock — читает ли он Telegram под блокировкой опроса (прогоны до 0.5.4 — нет); null — прогона нет.
 */
export function currentRun(p) {
  const lock = readJson(p.lock, null);
  if (!lock?.pid || !lockHeld(lock, Infinity)) return null;
  let id = lock.id;
  if (!id) { try { id = fs.readdirSync(p.runs).filter((d) => /^\d{8}-\d{4}$/.test(d)).sort().at(-1) || null; } catch { id = null; } }
  const lastEvent = id ? readText(path.join(p.runs, id, 'events.log'), '').trim().split('\n').filter(Boolean).at(-1) || '' : '';
  return { id, since: new Date(lock.at), lastEvent, pullLock: lock.pull_lock === true };
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
const STATE_PATHS = ['mcfly/progress.md', 'mcfly/metrics.jsonl', 'mcfly/questions.yaml', 'mcfly/answers.md', 'mcfly/ideas.yaml', 'mcfly/findings.yaml', 'mcfly/runs', 'mcfly/shifts'];
const RAW_LOG = ':(exclude)mcfly/runs/*/stdout.log'; // сырой вывод claude не коммитится, даже если в .gitignore нет строки
/** Метаданные одобрения изменений (.openspec.yaml), изменённые runner'ом (авто-одобрение по сроку, ответы из Telegram) или человеком. */
const approvalMeta = (projectDir) => changedTrackedFiles(projectDir).filter((f) => /^openspec\/changes\/[^/]+\/\.openspec\.yaml$/.test(f));

/**
 * Коммитит служебные файлы прогона, чтобы рабочее дерево оставалось чистым для следующего прогона.
 * Только эти пути (commit -- <пути>): работа агентов, оставшаяся в индексе после обрыва, в коммит прогона не попадает.
 */
/** Конец прогона (0.7.0): спланированные пункты, чьё изменение заархивировано, — сделаны. */
export function finishIdeas(p, cfg, info = {}) {
  if (!cfg.ideas?.enabled) return [];
  try {
    const d = loadIdeas(p); if (d.error) return [];
    const done = syncDoneIdeas(d, p.openspecChanges);
    // 0.11.0: сделанный пункт бэклога владельца отмечается в mcfly/goals.md (info.goals — тексты отмеченных пунктов)
    info.goals = tickGoals(p, d.ideas.filter((x) => x.status === 'done' && x.source === 'owner-backlog' && !x.goal_checked));
    if (done.length || info.goals.length) saveIdeas(p, d);
    return done;
  } catch { return []; } // список — не повод терять коммит и итог прогона
}

export function commitRunState(projectDir, id, log = console.log, extra = []) {
  const inRepo = spawnSync('git', ['rev-parse', '--is-inside-work-tree'], { cwd: projectDir, encoding: 'utf8' });
  if (inRepo.status !== 0) return false;
  // 0.11.0: путь, в котором git ничего не видит (пустой каталог mcfly/shifts нового проекта), ронял `git add` целиком
  const known = (f) => String(spawnSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '--', f], { cwd: projectDir, encoding: 'utf8' }).stdout || '').trim() !== '';
  const existing = [...new Set([...[...STATE_PATHS, ...extra].filter((f) => fs.existsSync(path.join(projectDir, f)) && known(f)), ...approvalMeta(projectDir)])];
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

/**
 * Сообщения «💡 Предложения» вслед итогу прогона (0.11.0): только если работы и планов нет, владелец ещё ничего не взял,
 * а за этот прогон в списке появились новые пункты. Иначе — пусто: список остаётся по кнопке.
 */
export function freshIdeasMessages(p, cfg, since) {
  try {
    const brief = ideasBrief(p, cfg);
    if (!brief || !brief.proposed || brief.taken.length) return [];
    const changes = listChanges(p.openspecChanges);
    if (approvedWithWork(changes).length || pendingApprovals(changes).length) return [];
    if (!loadIdeas(p).ideas.some((x) => x.status === 'proposed' && new Date(x.created_at) >= since)) return [];
    const parts = ideasView(p, cfg).map((text) => ({ text, keyboard: null }));
    const rows = ideasKeyboard(p, cfg);
    return rows.length ? [...parts, { text: 'Выберите, что команде взять в работу:', keyboard: rows }] : parts;
  } catch { return []; } // список — не повод терять конец прогона
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

/** Итог проверки планов (0.14.1): отложенные владельцем изменения ошибкой не считаются; failed — имена того, что не прошло. Вывод не разобрать — решает код выхода. */
export function validateVerdict(stdout, status, paused = []) {
  let items;
  try { items = JSON.parse(stdout).items; } catch { /* не JSON — ниже по коду выхода */ }
  if (!Array.isArray(items)) return { ok: status === 0, failed: [], skipped: [] };
  const bad = items.filter((i) => i && i.valid === false);
  const isSkipped = (i) => i.type !== 'spec' && paused.includes(i.id);
  const failed = bad.filter((i) => !isSkipped(i)).map((i) => (i.type === 'spec' ? `спецификация ${i.id}` : String(i.id)));
  return { ok: failed.length === 0, failed, skipped: bad.filter(isSkipped).map((i) => String(i.id)) };
}

/** Заметка прогона о проверке планов: пусто, если ошибок нет или openspec не запускается. */
export function validateNote(v) {
  if (!v.available || v.ok !== false) return '';
  return v.failed?.length ? `openspec validate: ошибки в ${truncate(v.failed.join(', '), 160)}` : 'openspec validate: есть ошибки';
}

export function runOpenspecValidate(projectDir, { paused = [] } = {}) {
  const r = spawnSync('openspec', ['validate', '--all', '--strict', '--json'], { cwd: projectDir, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (r.error) return { available: false, ok: null, output: String(r.error) };
  return { available: true, ...validateVerdict(String(r.stdout || ''), r.status, paused), output: String(r.stdout || r.stderr || '').slice(0, 20000) };
}

/** Имена отложенных изменений; битые метаданные не должны срывать запись прогона. */
function pausedNames(p) {
  try { return listChanges(p.openspecChanges).filter((c) => isPaused(c)).map((c) => c.name); } catch { return []; }
}

const realSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Сообщение в Telegram сразу, не дожидаясь утренней сводки; keyboard — кнопки под ним. Без токена или chat_id — молча ничего. */
export function telegramNotifier(cfg) {
  return async (text, keyboard = null, { html = false } = {}) => {
    const token = process.env[cfg.telegram.token_env];
    if (!token || !cfg.telegram.chat_id) return;
    await createTelegram({ token }).sendMessage(cfg.telegram.chat_id, text, { keyboard, html });
  };
}

const FINISH_ICON = { ok: '✅', quota: '⏸', timeout: '⏱' };
const runWhen = (record) => { const start = new Date(record.started_at); return record.slot || `${pad2(start.getHours())}:${pad2(start.getMinutes())}`; };
/**
 * Первая строка итога для владельца (0.9.0): статус словами и длительность, без ходов, стоимости и субагентов — они остаются
 * в журнале mcfly/progress.md и metrics.jsonl; при network и error — тревога.
 */
export function finishText(cfg, record) {
  if (['network', 'error'].includes(record.status)) return alertText(cfg, record);
  const head = `${FINISH_ICON[record.status] || 'ℹ️'} mcfly ${cfg.project}: прогон ${runWhen(record)}`;
  const took = fmtDuration(record.duration_ms || 0);
  if (record.status === 'ok') return `${head} прошёл успешно, ${took}.`;
  if (record.status === 'quota') return `${head} остановлен через ${took}: кончился лимит подписки. Команда продолжит с того же места, когда лимит обновится.`;
  if (record.status === 'timeout') return `${head} остановлен через ${took}: не уложился в отведённое время. Незаконченное подхватит следующий прогон.`;
  return `${head} завершён: ${STATUS_RU[record.status] || record.status}, ${took}.`;
}

const QUESTION_MAX = 400; const EXCERPT_MAX = 200;
/**
 * Открытые вопросы и ждущие одобрения изменения — текстом, к кнопкам под сообщением: без него кнопка «Q4: по умолчанию»
 * не говорила, о чём вопрос и что значит «по умолчанию» (18.10).
 */
function decisionLines(cfg, p, changes) {
  const out = [];
  for (const q of openQuestions(loadQuestions(p))) {
    out.push(`❓ ${q.id}: ${truncate(String(q.text || '').replace(/\s+/g, ' ').trim(), QUESTION_MAX)}`);
    out.push(autoDefault(cfg, q.category) && q.default
      ? `   По умолчанию: ${truncate(String(q.default).replace(/\s+/g, ' ').trim(), QUESTION_MAX)} (примется ${fmtShort(new Date(q.deadline_at))})`
      : '   Ответа по умолчанию нет — команда ждёт вас');
  }
  const labels = planLabels(changes);
  for (const c of pendingApprovals(changes)) {
    out.push(`📋 Одобрить ${c.mcfly.idea ? `${changeTitle(p, c)}: ` : `${labels.get(c.name)}: `}${proposalExcerpt(c, EXCERPT_MAX)}${isAutoApprovable(c, cfg) ? ` (авто-одобрение ${fmtShort(approvalDeadline(c, cfg))})` : ''}`);
  }
  const found = pendingFindings(p, cfg);
  if (found) out.push(`📮 Находки для доработки mcfly: ${found} — передать их или нет, решите по кнопке «Находки»`);
  // 0.11.0: подсказка про свой ответ — только при открытом вопросе и с его настоящим номером (раньше «Q4» стоял всегда)
  const open = openQuestions(loadQuestions(p));
  if (out.length) out.push(open.length ? `Кнопки ниже; свой ответ — текстом: «${open[0].id}: …»` : 'Кнопки ниже');
  return out;
}
const NEED_MAX = 5; const ITEM_MAX = 220; const MESSAGE_MAX = 3800; const PLAIN_MIN = 300;
/** Пункты списком «• …»: не больше n, каждый урезан; не влезшие — одной строкой со ссылкой на «Последний прогон». */
function bullets(items, n) {
  const out = items.slice(0, n).map((l) => `• ${truncate(String(l).replace(/`/g, ''), ITEM_MAX)}`);
  if (items.length > n) out.push(`• … ещё ${items.length - n} — кнопка «последний прогон»`);
  return out;
}
/**
 * Итог прогона для Telegram: первая строка статуса, пересказ «Простыми словами» целиком и «Нужно от вас» из отчёта репортёра,
 * что будет дальше и кнопки одобрений и ответов по умолчанию. Без этого человек видел только «прогон завершён: ок» и не понимал,
 * сделала ли команда что-нибудь (18.10). 0.9.0: без списка «Сделано», путей к файлам и чисел для разработчиков.
 */
export function finishMessage(cfg, record, p) {
  if (['network', 'error'].includes(record.status)) return { text: alertText(cfg, record), keyboard: [] };
  const sec = reportSections(readText(path.join(p.runs, record.id, 'summary.md'), '')) || {};
  const changes = listChanges(p.openspecChanges);
  const need = humanItems(sec).filter((l) => !approvalCovered(l, changes));
  const decide = decisionLines(cfg, p, changes);
  const label = (c) => changeTitle(p, c, undefined, { short: true });
  const next = `Дальше: ${record.chain && record.chain.startsWith('следующий') ? `${record.chain}` : nextRunText(approvedWithWork(changes), pendingApprovals(changes), (c) => progressWords(p.projectDir, c), undefined, ideasBrief(p, cfg), label)}${record.chain && !record.chain.startsWith('следующий') ? ` (${record.chain})` : ''}`;
  // Решения — главное: если не влезает, урезается пересказ, а не вопросы.
  const assemble = (plainMax) => {
    const lines = [finishText(cfg, record)];
    const plain = plainWords(sec, plainMax);
    if (plain) lines.push('', plain);
    if (record.goals_checked?.length) lines.push('', `🎯 Отмечено в целях: ${record.goals_checked.map((t) => truncate(t, 120)).join('; ')}`);
    if (need.length) lines.push('', 'Нужно от вас:', ...bullets(need, NEED_MAX));
    if (decide.length) lines.push('', 'Решить:', ...decide);
    lines.push('', next);
    return lines.join('\n');
  };
  let text = assemble(1500);
  for (let k = 1200; text.length > MESSAGE_MAX && k >= PLAIN_MIN; k -= 300) text = assemble(k);
  return { text: truncate(text, MESSAGE_MAX), keyboard: summaryKeyboard(p, cfg) };
}

/**
 * Текст тревоги о прогоне, который не выполнил работу и требует внимания человека. 0.9.0: причина словами, без текста ошибки,
 * номера прогона и пути к журналу — они в mcfly/runs/<id>/ и в mcfly/progress.md.
 */
export function alertText(cfg, record) {
  const when = `прогон ${runWhen(record)}`;
  if (record.status === 'network') {
    const vpn = (record.note || '').split('; ').filter((n) => n.startsWith('VPN «')).join('; ');
    return `⚠️ mcfly ${cfg.project}: ${when} не состоялся — не было связи с Claude, ${record.attempts} попыт${record.attempts === 1 ? 'ка' : record.attempts < 5 ? 'ки' : 'ок'}.${vpn ? ` ${vpn}.` : ''} Проверьте VPN и интернет; следующий прогон — по расписанию.`;
  }
  return `⚠️ mcfly ${cfg.project}: ${when} сорвался из-за сбоя. Следующий прогон попробует снова; если сбой повторится, разберите его в сессии Claude — подробности сохранены в файлах прогона.`;
}

/** Ночь закончилась без ночной передачи (репортёр не написал, прогон пропущен) — собрать её по фактам. Ссылки — прогоны после дневной передачи. */
export function ensureNightHandoff(p, now = new Date()) {
  const night = latestShift(p, 'night'); const day = latestShift(p, 'day');
  if (night && (!day || night.at >= day.at)) return null;
  const since = day ? day.at : '';
  const runs = readMetrics(p).filter((r) => r.type === 'run' && r.mode === 'night' && r.status !== 'missed' && r.id >= since).map((r) => r.id);
  return writeShift(p, 'night', renderAutoHandoff(p, 'night', now, { runs }), now);
}
/** Сейчас позже последнего слота ночи (в пределах 12 часов после него). */
export function afterLastSlot(now, slots) {
  const last = parseSlot([...slots].sort().at(-1));
  const min = now.getHours() * 60 + now.getMinutes();
  return min >= last && min < last + 12 * 60;
}

/** Прогон команды. mode: night (с проверкой окна слота) | day. */
export async function run({ projectDir, mode = 'day', dryRun = false, now = new Date(), log = console.log, sleep = realSleep, notify = null, beforeAttempt = null, apiWatch = {}, startRun = spawnDayRun, chained = process.env.MCFLY_CHAINED === '1' }) {
  const p = paths(projectDir);
  loadEnv(projectDir);
  const cfg = loadConfig(p.config);
  ensureDir(p.runs); ensureDir(p.logs);
  const id = makeRunId(now);
  let slot = null;
  if (mode === 'night') {
    slot = matchSlot(now, cfg.schedule.slots, cfg.schedule.tolerance_minutes);
    if (!slot) {
      if (afterLastSlot(now, cfg.schedule.slots)) ensureNightHandoff(p, now); // последний слот проспали — утру всё равно нужна передача
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
  let outcome;
  try {
    if (!dryRun) {
      // Задание answers держит блокировку опроса на длинный опрос (до 25 с) и отпускает её между опросами — ждём её с запасом.
      // Не дождались — ответы применяет само задание, сразу по приходу.
      try { await pullAnswers({ projectDir, cfg, p, log, now, lockWaitMs: 45_000, sleep }); } catch (e) { log(`Telegram недоступен: ${errorLine(e)}`); }
      const qdata = loadQuestions(p);
      const defaulted = expireQuestions(qdata, cfg, now); saveQuestions(p, qdata);
      for (const q of defaulted) appendText(p.answers, `\n## ${fmtLocal(now)} — ${q.id} закрыт по умолчанию (срок истёк)\n${q.default || '(ответа по умолчанию нет)'}\n`);
      for (const c of expireApprovals(listChanges(p.openspecChanges), cfg, now)) appendText(p.answers, `\n## ${fmtLocal(now)} — ${c.name} одобрено автоматически (срок истёк)\n`);
      // Ночь без сданной смены — авто-передача по фактам (день работал, но смену не сдал).
      if (mode === 'night' && !activeDayHandoff(p)) writeShift(p, 'day', renderAutoHandoff(p, 'day', now), now);
    }
    const deadline = new Date(now.getTime() + cfg.run.max_minutes * 60_000);
    const lastSlot = mode === 'night' && slot === [...cfg.schedule.slots].sort().at(-1); // последний по времени, а не по порядку в конфигурации
    const nightFile = lastSlot ? `mcfly/shifts/${shiftFileName('night', now)}` : '';
    const nightHandoff = lastSlot ? `Это последний прогон ночи: репортёр также готовит текст ${nightFile}, а ты записываешь его в этот файл — передачу «ночь → день» по формату скилла mcfly-process (раздел «Передача смены»), со ссылками на прогоны ночи.` : '';
    const prompt = buildLeadPrompt({ cfg, p, runId: id, mode, deadline, context: buildContext(p, cfg, { handoff: true }), nightHandoff });
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
    let denials = 0; // отказы разрешений субагентам и лиду: иначе о них узнаём только из отчёта
    let watch = null; // сторож зависания на повторах API — свой на каждую попытку
    let usage = null; // доли лимитов подписки из последнего rate_limit_event
    const stdoutLines = lineSplitter((line) => { watch?.line(line); const rl = rateLimitInfo(line); if (rl) usage = rl; if (permissionDenial(line)) denials += 1; const s = summarizeEvent(line); if (s) event(s); });
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
      watch = apiRetryWatch({ stallMs: cfg.run.api_stall_minutes * 60_000, spanMs: cfg.run.api_retry_span_minutes * 60_000, ...apiWatch });
      result = await runProcess({ bin: cfg.run.claude_bin, args, cwd: projectDir, env, timeoutMs: Math.max(60_000, runDeadline - Date.now()),
        onStdout: (chunk) => { logStream.write(chunk); stdoutLines.push(chunk); }, onStderr: (chunk) => { logStream.write(chunk); stderrLines.push(chunk); },
        watchdog: { check: watch.check, intervalMs: apiWatch.intervalMs ?? 30_000 } });
      stdoutLines.flush(); stderrLines.flush();
      if (result.aborted) event(`⛔ прерван: ${result.aborted}`);
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
    const validate = runOpenspecValidate(projectDir, { paused: pausedNames(p) });
    fs.writeFileSync(path.join(runDir, 'validate.json'), JSON.stringify(validate, null, 2));
    // Служебные файлы (журнал, метрики, каталоги прогонов, метаданные одобрений) runner коммитит сам — это не забытая работа.
    const committedByRunner = new Set(approvalMeta(projectDir));
    const dirty = dirtyFiles(projectDir, { exclude: STATE_PATHS }).filter((f) => !committedByRunner.has(f)).length;
    const unfinished = unfinishedWork(projectDir);
    const record = {
      id, mode, slot, started_at: started.toISOString(), ended_at: new Date().toISOString(), status: parsed.status, attempts, duration_ms: Date.now() - started.getTime(), exit_code: result.exitCode,
      cost_usd: costUsd, turns, usage, ...(chained ? { chained: true } : {}), permission_denials: denials, subagents: parsed.subagents, session_id: parsed.sessionId, validate_ok: validate.ok, dirty_files: dirty, error: parsed.errorText,
      note: [parsed.status !== 'ok' ? parsed.errorText.split('\n')[0] : '', ...new Set(vpnNotes), denials ? `отказов разрешений: ${denials}` : '', fallback ? 'репортёр не написал отчёт, записана авто-сводка' : '', validateNote(validate),
        dirty ? `незакоммиченных файлов: ${dirty}` : '', unfinished.length ? `незакоммиченная работа в worktree: ${unfinished.map(describeWorktree).join(', ')}` : ''].filter(Boolean).join('; '),
    };
    // Цепочка: решение до записи — причина попадает в журнал и итог прогона.
    const chain = chainDecision({ cfg, p, record, projectDir, started });
    if (chain.reason) record.chain = chain.chain ? 'следующий прогон запущен сразу' : `прогон подряд не запущен: ${chain.reason}`;
    // До записи прогона: отмеченные в целях пункты попадают в запись и в итог.
    const ideaInfo = {}; finishIdeas(p, cfg, ideaInfo);
    if (ideaInfo.goals?.length) record.goals_checked = ideaInfo.goals;
    recordRun(p, record);
    // Последний слот ночи: репортёр не оставил ночную передачу — собрать по фактам.
    if (lastSlot) ensureNightHandoff(p, now);
    commitRunState(projectDir, id, log, ideaInfo.goals?.length ? ['mcfly/goals.md'] : []);
    // Итог любого прогона — сразу в Telegram: прогон по «запусти» иначе молчит до утренней сводки.
    // Не ушло (нет связи) — в очередь: задание answers дошлёт его, когда Telegram ответит.
    const message = finishMessage(cfg, record, p);
    try { await (notify || telegramNotifier(cfg))(message.text, message.keyboard); }
    catch (e) { log(`Сообщение в Telegram не отправлено: ${e.message}; поставлено в очередь.`); enqueueNotice(p, message); }
    // 0.11.0: прогон только пополнил список (первый прогон переносит бэклог) — сам список с кнопками «Берём» сразу следом,
    // чтобы владельцу не нужно было идти за ним в «💡 Предложения».
    for (const m of freshIdeasMessages(p, cfg, started)) {
      try { await (notify || telegramNotifier(cfg))(m.text, m.keyboard, { html: true }); } catch { enqueueNotice(p, { ...m, html: true }); }
    }
    log(`Прогон ${id} завершён: ${record.status} (${fmtLocal(new Date())}).`);
    outcome = { status: record.status, id, chained: chain.chain };
  } finally { releaseLock(p); }
  // Следующий прогон цепочки — после снятия лока, отдельным процессом.
  if (outcome.chained) { log('Цепочка: запускаю следующий прогон.'); startRun(projectDir, { chained: true }); }
  return outcome;
}
