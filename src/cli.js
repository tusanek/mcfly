import path from 'node:path';
import { parseArgs } from 'node:util';
import YAML from 'yaml';
import { paths, loadState, saveState } from './state.js';
import { loadConfig, autoDefault, isCategory } from './config.js';
import { loadEnv } from './env.js';
import { run, currentRun } from './runner.js';
import { composeSummary, sendSummary } from './summary.js';
import { pullAnswers } from './pull.js';
import { buildContext, isMcflyProject } from './context.js';
import { loadQuestions, saveQuestions, addQuestion, expireQuestions, openQuestions } from './questions.js';
import { branchProgress, commitPaths } from './git.js';
import { listChanges, requestApproval, setApproval, pendingApprovals } from './approvals.js';
import { appendMetric, readMetrics, aggregate, formatEvents } from './metrics.js';
import { createTelegram, extractMessages } from './telegram.js';
import * as schedule from './schedule.js';
import { init } from './init.js';
import { doctor } from './doctor.js';
import { MCFLY_ROOT } from './prompt.js';
import { exists, fmtShort, readText, writeText, pad2 } from './util.js';

const HELP = `mcfly — комплект ИИ-команды разработки на Claude Code

Команды:
  init [--name <проект>] [--with-tracker]        создать mcfly/ в проекте, настроить .claude и OpenSpec
  doctor [--probe]                                проверить окружение (--probe: реальный пробный запуск claude -p)
  run [--mode night|day] [--dry-run]              запустить прогон команды (night проверяет окно слота)
  summary [--send]                                собрать (и отправить в Telegram) утреннюю сводку
  answers                                         забрать ответы из Telegram
  context                                         контекст состояния для агентов
  status                                          состояние проекта
  question add --category <c> --text <t> --default <d> [--hours <n>]   (--default обязателен, кроме prod)
  question list | question expire
  approval request <изменение> [--category <c>] [--priority <n>]
  approval set <изменение> approved|rejected [--note <t>] [--priority <n>]   (меньше = раньше; по умолчанию 100)
  approval list
  metric add --key <k> [--value <n>] [--change <имя>] | metric
  telegram pair                                   привязать чат (отправьте боту любое сообщение)
  schedule install|remove|status [--dry-run]      задания launchd: ночные прогоны и сводка
Общие флаги: --project <dir> (по умолчанию текущий каталог или MCFLY_PROJECT_DIR)`;

export async function main(argv) {
  const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, strict: false, options: {
    project: { type: 'string' }, mode: { type: 'string' }, 'dry-run': { type: 'boolean' }, send: { type: 'boolean' }, name: { type: 'string' }, 'with-tracker': { type: 'boolean' },
    category: { type: 'string' }, text: { type: 'string' }, default: { type: 'string' }, hours: { type: 'string' }, note: { type: 'string' }, key: { type: 'string' }, value: { type: 'string' },
    change: { type: 'string' }, quiet: { type: 'boolean' }, probe: { type: 'boolean' }, priority: { type: 'string' }, help: { type: 'boolean', short: 'h' } } });
  const [cmd, sub, ...rest] = positionals;
  const projectDir = path.resolve(values.project || process.env.MCFLY_PROJECT_DIR || process.cwd());
  const p = paths(projectDir);
  const log = (...a) => console.log(...a);
  if (!cmd || values.help) { log(HELP); return 0; }
  if (cmd === 'init') { init({ projectDir, name: values.name, withTracker: !!values['with-tracker'], log }); return 0; }
  if (cmd === 'context') { if (!isMcflyProject(p)) return 0; loadEnv(projectDir); log(buildContext(p, loadConfig(p.config))); return 0; }
  if (cmd === 'doctor') { doctor({ projectDir, probe: !!values.probe, log }); return 0; }
  if (!isMcflyProject(p)) { console.error(`Это не проект mcfly: нет ${p.config}. Выполните mcfly init.`); return 1; }
  loadEnv(projectDir);
  const cfg = loadConfig(p.config);
  const now = new Date();
  const runIdEnv = process.env.MCFLY_RUN_ID || '';
  switch (cmd) {
    case 'run': { const r = await run({ projectDir, mode: values.mode || 'day', dryRun: !!values['dry-run'], now, log }); return ['ok', 'dry-run', 'missed'].includes(r.status) ? 0 : 1; }
    case 'summary': { if (values.send) await sendSummary(p, cfg, { now, log }); else log(composeSummary(p, cfg, { now, since: new Date(now.getTime() - 24 * 3600_000) })); return 0; }
    case 'answers': { await pullAnswers({ projectDir, cfg, p, log, now }); return 0; }
    case 'status': {
      const changes = listChanges(p.openspecChanges); const q = openQuestions(loadQuestions(p)); const agg = aggregate(readMetrics(p));
      const cur = currentRun(p);
      log(cur ? `Идёт прогон ${cur.id || '?'} с ${pad2(cur.since.getHours())}:${pad2(cur.since.getMinutes())}${cur.lastEvent ? `; последнее: ${cur.lastEvent}` : ''}` : 'Прогон сейчас не идёт.');
      log(`Проект ${cfg.project}. Изменений: ${changes.length}, ожидают одобрения: ${pendingApprovals(changes).length}, открытых вопросов: ${q.length}.`);
      log(`Прогонов: ${agg.runs} (ок ${agg.ok}, пропущено ${agg.missed}, ошибок ${agg.error}, по времени ${agg.timeout}, квота ${agg.quota}${agg.network ? `, нет сети ${agg.network}` : ''}), ~$${agg.cost_usd}. События: ${formatEvents(agg.events)}.`);
      for (const c of changes) {
        const onBranch = branchProgress(projectDir, c.name);
        log(`- ${c.name}: одобрение=${c.mcfly.approval || 'не запрошено'}, задач ${c.tasksDone}/${c.tasksDone + c.tasksOpen}${onBranch ? ` (на ветке change/${c.name}: ${onBranch.done}/${onBranch.done + onBranch.open})` : ''}`);
      }
      for (const x of q) log(`- ${x.id} [${x.category}] ${x.text} (срок ${fmtShort(new Date(x.deadline_at))})`);
      return 0;
    }
    case 'question': {
      const data = loadQuestions(p);
      if (sub === 'add') {
        const q = addQuestion(data, { category: values.category, text: values.text, defaultAnswer: values.default, hours: values.hours ? Number(values.hours) : undefined, now, runId: runIdEnv }, cfg);
        saveQuestions(p, data); appendMetric(p, { type: 'event', at: now.toISOString(), run_id: runIdEnv, key: 'escalations', value: 1 });
        log(`${q.id} зарегистрирован (категория ${q.category}, срок ${fmtShort(new Date(q.deadline_at))}). ${autoDefault(cfg, q.category) ? 'Продолжайте по ответу по умолчанию.' : `Категория ${q.category} без ответа по умолчанию: остановитесь и ждите решения человека.`}`); return 0;
      }
      if (sub === 'list') { for (const x of data.questions) log(`${x.id} [${x.category}] ${x.status}: ${x.text}${x.answer ? ' → ' + x.answer : ''}`); return 0; }
      if (sub === 'expire') { const d = expireQuestions(data, cfg, now); saveQuestions(p, data); log(`Закрыто по умолчанию: ${d.length}`); return 0; }
      break;
    }
    case 'approval': {
      const changes = listChanges(p.openspecChanges);
      if (sub === 'list') { for (const c of changes) log(`${c.name}: ${c.mcfly.approval || 'не запрошено'} (${c.mcfly.category || '-'})`); return 0; }
      const c = changes.find((x) => x.name === rest[0]);
      if (!c) { console.error(`Изменение не найдено: ${rest[0] || '(имя не указано)'}`); return 1; }
      if (sub === 'request') {
        const category = values.category || 'spec';
        if (!isCategory(cfg, category)) { console.error(`Неизвестная категория "${category}". Допустимо: ${Object.keys(cfg.escalation.categories).join(', ')}`); return 1; }
        requestApproval(c, { category, priority: values.priority, now }); appendMetric(p, { type: 'event', at: now.toISOString(), run_id: runIdEnv, key: 'changes_proposed', value: 1, change: c.name }); log(`Одобрение запрошено: ${c.name}. Человек увидит его в утренней сводке.`); return 0; }
      if (sub === 'set') {
        // Одобрение — решение человека: в прогоне команды (MCFLY_RUN_ID задаёт runner) агенты только запрашивают его.
        if (runIdEnv) { console.error('Одобрение ставит только человек: в прогоне команды approval set запрещён, используйте mcfly approval request.'); return 1; }
        const st = rest[1]; if (!['approved', 'rejected'].includes(st)) { console.error('Статус: approved | rejected'); return 1; } setApproval(c, st, 'human-cli', values.note || '', now, { priority: values.priority }); log(`${c.name}: ${st}${values.priority ? ', приоритет ' + values.priority : ''}`);
        // решение человека сразу в истории; во время прогона HEAD под агентами не двигаем — метаданные закоммитит прогон
        if (exists(p.lock)) { log('Не закоммичено: идёт прогон, метаданные одобрения закоммитит он.'); return 0; }
        const committed = commitPaths(projectDir, [path.relative(projectDir, path.join(c.dir, '.openspec.yaml'))], `chore(${c.name}): одобрение человека — ${st}`);
        log(!committed.ok ? `Не закоммичено (закоммитит ближайший прогон): ${committed.error}` : committed.committed ? 'Закоммичено.' : 'Изменений нет, коммит не нужен.'); return 0; }
      break;
    }
    case 'metric': {
      if (sub === 'add') { if (!values.key) { console.error('Нужен --key'); return 1; } appendMetric(p, { type: 'event', at: now.toISOString(), run_id: runIdEnv, key: values.key, value: values.value ? Number(values.value) : 1, change: values.change || '' }); log(`метрика ${values.key} записана`); return 0; }
      log(JSON.stringify(aggregate(readMetrics(p)), null, 2)); return 0;
    }
    case 'telegram': {
      if (sub !== 'pair') break;
      const tg = createTelegram({ token: process.env[cfg.telegram.token_env] });
      log('Отправьте боту любое сообщение в Telegram. Жду до 60 секунд…');
      const state = loadState(p);
      const { messages, nextOffset } = extractMessages(await tg.getUpdates(state.telegram_offset || 0, 60), null);
      if (!messages.length) { console.error('Сообщений не получено. Проверьте токен и повторите.'); return 1; }
      const chatId = String(messages[messages.length - 1].chatId);
      const doc = YAML.parseDocument(readText(p.config, '')); doc.setIn(['telegram', 'chat_id'], chatId); writeText(p.config, doc.toString());
      if (nextOffset) { state.telegram_offset = nextOffset; saveState(p, state); }
      await tg.sendMessage(chatId, `mcfly подключён к проекту ${cfg.project}. Сюда будут приходить сводки, вопросы и запросы одобрения.`);
      log(`chat_id ${chatId} сохранён в mcfly/config.yaml`); return 0;
    }
    case 'schedule': {
      const mcflyBin = path.join(MCFLY_ROOT, 'bin', 'mcfly');
      if (sub === 'install') { schedule.install(cfg, { projectDir, mcflyBin, logsDir: p.logs, dryRun: !!values['dry-run'], log }); return 0; }
      if (sub === 'remove') { schedule.remove(cfg, { log }); return 0; }
      if (sub === 'status') { schedule.status(cfg, { log }); return 0; }
      break;
    }
  }
  console.error(`Неизвестная команда: ${[cmd, sub].filter(Boolean).join(' ')}\n`); log(HELP); return 1;
}
