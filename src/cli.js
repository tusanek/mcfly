import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { loadIdeas, saveIdeas, addIdea, findIdea, transitionIdea, IDEA_STATUS_RU } from './ideas.js';
import YAML from 'yaml';
import { paths, loadState, saveState } from './state.js';
import { loadConfig, autoDefault, isCategory } from './config.js';
import { loadEnv } from './env.js';
import { run, currentRun } from './runner.js';
import { composeSummary, sendSummary, htmlToPlain } from './summary.js';
import { pullAnswers, pollAnswers } from './pull.js';
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
  answers [--once]                                забирать ответы из Telegram сразу по приходу ~answers_every_minutes мин (задание launchd); --once — один раз
  context                                         контекст состояния для агентов
  status                                          состояние проекта
  question add --category <c> --text <t> --default <d> [--hours <n>]   (--default обязателен, кроме prod)
  ideas list [--status <статус>]                  список предложений (0.7.0)
  ideas add --title <t> --benefit <t> --source <owner-backlog|owner-note|team|research> --size <S|M|L>
            [--how <t>] [--ref <t>] [--needs-owner <t>] [--new-arguments <t>]   добавить предложение
  ideas set <Iн> proposed|taken|rejected [--note <t>]   решение владельца в сессии (в прогоне запрещено)
  question list | question expire
  approval request <изменение> [--category <c>] [--priority <n>]
  approval set <изменение> approved|rejected [--note <t>] [--priority <n>]   (меньше = раньше; по умолчанию 100)
  approval list
  shift start <изменение> | shift merge           дневная работа в ветке shift/<изменение>-… и её слияние в change/<изменение>
  shift write [--file <путь>] | shift auto [--kind day|night]   записать передачу смены / показать авто-передачу
  metric add --key <k> [--value <n>] [--change <имя>] | metric
  telegram pair                                   привязать чат (отправьте боту любое сообщение)
  schedule install|remove|status [--dry-run]      задания launchd: ночные прогоны и сводка
  action list | trust | run <id> [--yes]          действия владельца из раздела actions: список, подтверждение раздела
                                                  (только в терминале), запуск из терминала (итог и в Telegram)
  action prepare|exec <id> --ticket <t>           служебные: их запускает бот после нажатия кнопки
Общие флаги: --project <dir> (по умолчанию текущий каталог или MCFLY_PROJECT_DIR)`;

export async function main(argv) {
  const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, strict: false, options: {
    project: { type: 'string' }, mode: { type: 'string' }, 'dry-run': { type: 'boolean' }, send: { type: 'boolean' }, name: { type: 'string' }, 'with-tracker': { type: 'boolean' },
    category: { type: 'string' }, text: { type: 'string' }, default: { type: 'string' }, hours: { type: 'string' }, note: { type: 'string' }, key: { type: 'string' }, value: { type: 'string' },
    change: { type: 'string' }, file: { type: 'string' }, kind: { type: 'string' }, quiet: { type: 'boolean' }, probe: { type: 'boolean' }, once: { type: 'boolean' }, priority: { type: 'string' }, yes: { type: 'boolean' }, idea: { type: 'string' }, title: { type: 'string' }, benefit: { type: 'string' }, how: { type: 'string' }, source: { type: 'string' }, ref: { type: 'string' }, size: { type: 'string' }, 'needs-owner': { type: 'string' }, 'new-arguments': { type: 'string' }, status: { type: 'string' }, ticket: { type: 'string' }, help: { type: 'boolean', short: 'h' } } });
  const [cmd, sub, ...rest] = positionals;
  const projectDir = path.resolve(values.project || process.env.MCFLY_PROJECT_DIR || process.cwd());
  const p = paths(projectDir);
  const log = (...a) => console.log(...a);
  if (!cmd || values.help) { log(HELP); return 0; }
  if (cmd === 'init') { init({ projectDir, name: values.name, withTracker: !!values['with-tracker'], log }); return 0; }
  if (cmd === 'context') { if (!isMcflyProject(p)) return 0; loadEnv(projectDir); log(buildContext(p, loadConfig(p.config))); return 0; }
  if (cmd === 'doctor') { doctor({ projectDir, probe: !!values.probe, log }); return 0; }
  if (cmd === 'shift') {
    const { shiftStart, shiftMerge, shiftWrite, mainCheckout } = await import('./shift-git.js');
    const { renderAutoHandoff } = await import('./shift-files.js');
    const main = mainCheckout(projectDir); const mp = paths(main);
    if (!isMcflyProject(mp)) { console.error(`Это не проект mcfly: нет ${mp.config}.`); return 1; }
    loadEnv(main); const mcfg = loadConfig(mp.config); const at = new Date();
    const done = (r, text) => { if (!r.ok) { console.error(r.error); return 1; } log(text); for (const w of r.warnings || []) log(`⚠ ${w}`); return 0; };
    if (sub === 'start') { const r = shiftStart({ sessionDir: projectDir, change: rest[0], now: at }); return done(r, r.ok ? `Ветка дневной работы: ${r.branch}` : ''); }
    if (sub === 'merge') { const r = shiftMerge({ sessionDir: projectDir }); return done(r, r.message); }
    if (sub === 'write') {
      if (values.file && !fs.existsSync(values.file)) { console.error(`файл не найден: ${values.file}`); return 1; }
      const text = values.file ? readText(values.file, '') : fs.readFileSync(0, 'utf8');
      const { telegramNotifier } = await import('./runner.js');
      const r = await shiftWrite({ projectDir: main, text, now: at, notify: telegramNotifier(mcfg) });
      return done(r, r.ok ? `Передача записана: ${path.relative(main, r.path)}` : '');
    }
    if (sub === 'auto') { log(renderAutoHandoff(mp, values.kind === 'night' ? 'night' : 'day', at)); return 0; }
    console.error('mcfly shift start <изменение> | merge | write [--file] | auto [--kind]'); return 1;
  }
  if (!isMcflyProject(p)) { console.error(`Это не проект mcfly: нет ${p.config}. Выполните mcfly init.`); return 1; }
  loadEnv(projectDir);
  const cfg = loadConfig(p.config);
  const now = new Date();
  const runIdEnv = process.env.MCFLY_RUN_ID || '';
  switch (cmd) {
    case 'run': { const r = await run({ projectDir, mode: values.mode || 'day', dryRun: !!values['dry-run'], now, log }); return ['ok', 'dry-run', 'missed'].includes(r.status) ? 0 : 1; }
    case 'summary': { if (values.send) await sendSummary(p, cfg, { now, log }); else log(htmlToPlain(composeSummary(p, cfg, { now, since: new Date(now.getTime() - 24 * 3600_000) }))); return 0; }
    case 'answers': {
      // Задание launchd (answers --project …) — длинный опрос почти до следующего запуска: ответ на «запусти» и кнопки за секунды.
      // Чтения одного offset исключает блокировка опроса (pull.js); прогон до 0.5.4 читает без неё — пока он идёт, не читаем.
      const every = cfg.schedule.answers_every_minutes;
      if (!values.once && every > 0) { await pollAnswers({ projectDir, cfg, p, log, durationMs: every * 60 * 1000 }); return 0; }
      const cur = currentRun(p);
      if (cur && !cur.pullLock) { log('Сейчас идёт прогон старой версии mcfly — ответы из Telegram заберу после него.'); return 0; }
      await pullAnswers({ projectDir, cfg, p, log, now, lockWaitMs: 45_000 }); return 0;
    }
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
    case 'ideas': {
      const data = loadIdeas(p); if (data.error) { console.error(data.error); return 1; }
      if (sub === 'list') {
        for (const x of data.ideas.filter((i) => !values.status || i.status === values.status)) {
          log(`${x.id} [${IDEA_STATUS_RU[x.status] || x.status}] ${x.source === 'owner-backlog' || x.source === 'owner-note' ? 'ваш' : 'команда'} · ${x.size} — ${x.title}${x.change ? ` → ${x.change}` : ''}${x.reject_note || x.discuss_note ? ` — причина: ${x.reject_note || x.discuss_note}` : ''}`);
        }
        return 0;
      }
      if (sub === 'add') {
        try {
          const it = addIdea(data, { title: values.title, benefit: values.benefit, how: values.how || '', source: values.source, ref: values.ref || '', size: values.size, needsOwner: values['needs-owner'] || '', newArguments: values['new-arguments'] || '', now, runId: runIdEnv });
          saveIdeas(p, data); log(`${it.id} добавлено в предложения`); return 0;
        } catch (e) { console.error(e.message); return 1; }
      }
      if (sub === 'set') {
        // Решение по предложениям — владельца в сессии: в прогоне команды (MCFLY_RUN_ID задаёт runner) запрещено.
        if (runIdEnv) { console.error('Решение по предложениям принимает владелец в сессии: в прогоне команды ideas set запрещён'); return 1; }
        const to = rest[1]; if (!['proposed', 'taken', 'rejected'].includes(to)) { console.error('Статус: proposed | taken | rejected'); return 1; }
        const r = transitionIdea(data, rest[0], to, { actor: 'session', note: values.note || '', now });
        if (!r.idea || r.error) { console.error(`${rest[0] || '(номер не указан)'}: ${r.error}`); return 1; }
        saveIdeas(p, data); log(`${r.idea.id}: ${IDEA_STATUS_RU[to]}`); return 0;
      }
      console.error('mcfly ideas list | add | set'); return 1;
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
        let idea = null;
        if (values.idea) {
          // План по пункту списка (0.7.0): только по взятому владельцем пункту; пункт становится спланированным.
          const idata = loadIdeas(p); if (idata.error) { console.error(idata.error); return 1; }
          const it = findIdea(idata, values.idea);
          if (!it || it.status !== 'taken') { console.error(`${String(values.idea).toUpperCase()} не взят владельцем (статус: ${it ? IDEA_STATUS_RU[it.status] || it.status : 'нет такого'})`); return 1; }
          transitionIdea(idata, it.id, 'planned', { actor: 'team', change: c.name, now }); saveIdeas(p, idata); idea = it.id;
        }
        requestApproval(c, { category, priority: values.priority, now, idea }); appendMetric(p, { type: 'event', at: now.toISOString(), run_id: runIdEnv, key: 'changes_proposed', value: 1, change: c.name }); log(`Одобрение запрошено: ${c.name}. Человек увидит его в утренней сводке.`); return 0; }
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
    case 'action': {
      const { listActions, getAction, prepareAction, execAction, isTrusted, trustActions, actionFiles } = await import('./actions.js');
      const tty = !!(process.stdin.isTTY && process.stdout.isTTY);
      // Действия — решение владельца (прод, общая квота): в прогоне команды (MCFLY_RUN_ID задаёт runner) запуск запрещён.
      if (runIdEnv) { console.error('Действия запускает только владелец кнопкой в боте или из терминала: в прогоне команды mcfly action запрещён.'); return 1; }
      if (sub === 'list' || !sub) {
        const list = listActions(cfg);
        if (!list.length) log('Действий нет: раздел actions в mcfly/config.yaml.');
        else log(isTrusted(p, cfg) ? 'Раздел actions подтверждён владельцем.' : '⚠ Раздел actions не подтверждён — кнопки выключены. Проверьте команды ниже и выполните: mcfly action trust');
        for (const a of list) log(`${a.id}: ${a.title}${a.describe ? ` — ${a.describe}` : ''}${a.confirm ? '' : ' (без подтверждения)'}\n  run: ${a.run}${a.prepare ? `\n  prepare: ${a.prepare}` : ''}${a.offer ? `\n  offer: ${a.offer}` : ''}`);
        return 0;
      }
      if (sub === 'trust') {
        // Только живой терминал: агент (без TTY) не может подтвердить команды, которые сам же поправил.
        if (!tty) { console.error('mcfly action trust — только в терминале владельца (нужен интерактивный ввод).'); return 1; }
        const list = listActions(cfg);
        if (!list.length) { log('Действий нет: раздел actions в mcfly/config.yaml.'); return 1; }
        log('Команды, которые бот сможет запускать по кнопке (prepare и offer — без подтверждения):');
        for (const a of list) log(`\n${a.id} — ${a.title}${a.confirm ? '' : ' (без подтверждения)'}\n  run: ${a.run}${a.prepare ? `\n  prepare: ${a.prepare}` : ''}${a.offer ? `\n  offer: ${a.offer}` : ''}`);
        const files = actionFiles(cfg, p.projectDir);
        if (files.length) log(`\nПодтверждается и содержимое файлов (правка любого снова выключит кнопки):\n${files.map((f) => `  ${f}`).join('\n')}`);
        const { createInterface } = await import('node:readline/promises');
        const rl = createInterface({ input: process.stdin, output: process.stdout });
        const answer = (await rl.question('\nПодтвердить эти команды? Напишите «да»: ')).trim().toLowerCase(); rl.close();
        if (answer !== 'да') { log('Не подтверждено, кнопки остаются выключенными.'); return 1; }
        trustActions(p, cfg); log('Подтверждено. Любая правка раздела actions снова выключит кнопки до mcfly action trust.'); return 0;
      }
      const a = getAction(cfg, rest[0]);
      if (!a) { console.error(`Действие не найдено: ${rest[0] || '(имя не указано)'}. Список: mcfly action list`); return 1; }
      const token = process.env[cfg.telegram.token_env];
      const tg = token && cfg.telegram.chat_id ? createTelegram({ token }) : null;
      // без Telegram итог печатается: служебные prepare/exec тогда видны хотя бы в журнале launchd
      const send = async (text, keyboard) => { if (tg) await tg.sendMessage(cfg.telegram.chat_id, text, { html: true, keyboard }); else log(htmlToPlain(text)); };
      if (sub === 'prepare') { const r = await prepareAction({ p, cfg, id: a.id, send, ticket: values.ticket }); return r.status === 'ok' ? 0 : 1; }
      if (sub === 'exec') { const r = await execAction({ p, cfg, id: a.id, send, ticket: values.ticket }); return r.status === 'ok' ? 0 : 1; }
      if (sub === 'run') {
        if (!tty) { console.error('mcfly action run — только в терминале владельца; из бота — кнопкой «🛠 Действия».'); return 1; }
        if (a.confirm && !values.yes) { log(`${a.title}${a.describe ? ` — ${a.describe}` : ''}\nКоманда: ${a.run}\nДобавьте --yes, чтобы выполнить.`); return 1; }
        const r = await execAction({ p, cfg, id: a.id, send, interactive: true, echo: (l) => log(l) });
        log(`Итог: ${r.status}${r.code != null ? ` (код ${r.code})` : ''}`);
        return r.status === 'ok' ? 0 : 1;
      }
      break;
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
