import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { loadIdeas, saveIdeas, addIdea, findIdea, transitionIdea, closeIdeaByChange, markFirst, isArchived, IDEA_STATUS_RU } from './ideas.js';
import YAML from 'yaml';
import { paths, loadState, saveState } from './state.js';
import { loadConfig, autoDefault, isCategory, MAX_RUN_CHANGES } from './config.js';
import { loadEnv } from './env.js';
import { run, currentRun } from './runner.js';
import { composeSummary, sendSummary, htmlToPlain, techTail } from './summary.js';
import { pullAnswers, pollAnswers } from './pull.js';
import { buildContext, isMcflyProject, hasProduct } from './context.js';
import { loadQuestions, saveQuestions, addQuestion, expireQuestions, openQuestions } from './questions.js';
import { branchProgress, commitPaths } from './git.js';
import { listChanges, requestApproval, setApproval, pendingApprovals, setPause, clearPause, moveFirst, firstPriority, fastTrackBlock, isFastApproved, holdApproval, approveFast, fastPlanIntact, followupBlock, fastKind, writeCategory, priorityOf } from './approvals.js';
import { appendMetric, readMetrics, aggregate, formatEvents } from './metrics.js';
import { createTelegram, extractMessages } from './telegram.js';
import * as schedule from './schedule.js';
import { init } from './init.js';
import { doctor } from './doctor.js';
import { MCFLY_ROOT } from './prompt.js';
import { exists, fmtShort, fmtLocal, readText, writeText, appendText, pad2 } from './util.js';

const HELP = `mcfly — комплект ИИ-команды разработки на Claude Code

Команды:
  init [--name <проект>] [--with-tracker]        создать mcfly/ в проекте, настроить .claude и OpenSpec
  doctor [--probe]                                проверить окружение (--probe: реальный пробный запуск claude -p)
  run [--mode night|day] [--changes <n>] [--dry-run]   запустить прогон команды (night проверяет окно слота; --changes — сколько изменений взять)
  summary [--weekly [--list]] [--send]            собрать (и отправить в Telegram) утреннюю сводку; --weekly — недельную (итоги семи дней);
                                                  --weekly --list — только полный список недели (виджет Telegram)
  answers [--once]                                забирать ответы из Telegram сразу по приходу ~answers_every_minutes мин (задание launchd); --once — один раз
  context                                         контекст состояния для агентов
  status                                          состояние проекта
  question add --category <c> --text <t> --default <d> [--hours <n>]   (--default обязателен, кроме prod)
  ideas list [--status <статус>]                  список предложений (0.7.0)
  ideas add --title <t> --benefit <t> --source <owner-backlog|owner-note|team|research> --size <S|M|L>
            [--how <t>] [--ref <t>] [--needs-owner <t>] [--new-arguments <t>]   добавить предложение
  ideas set <Iн> proposed|taken|rejected|done [--note <t>]   решение владельца в сессии (в прогоне запрещено)
  ideas done <Iн> --change <имя>                  закрыть взятый пункт по изменению из архива (можно в прогоне)
  ideas first <Iн>                                взятый пункт — первым в очереди на план (в прогоне запрещено)
  question list | question expire
  approval request <изменение> [--category <c>] [--priority <n>] [--idea <Iн,…>] [--followup <родитель>]
                                                  --idea — план по взятым пунктам; --followup — доделка к завершённому изменению (одобряется сразу или отказ)
  approval set <изменение> approved|rejected [--note <t>] [--priority <n>]   (меньше = раньше; по умолчанию 100)
  approval pause <изменение> --until <ГГГГ-ММ-ДД> [--note <t>] | approval resume <изменение>
                                                  отложить одобренное изменение до даты (команда не берёт) / вернуть в работу
  approval first <изменение>                      изменение — первым в очереди (в прогоне запрещено)
  approval hold <изменение> [--note <t>]          вернуть на одобрение владельца план, одобренный быстрым путём (можно в прогоне)
  approval check <изменение>                      одобрено ли изменение и не менялся ли план после быстрого одобрения (перед слиянием)
  approval list
  shift start <изменение> | shift merge           дневная работа в ветке shift/<изменение>-… и её слияние в change/<изменение>
  shift write [--file <путь>] | shift auto [--kind day|night]   записать передачу смены / показать авто-передачу
  metric add --key <k> [--value <n>] [--change <имя>] | metric
  telegram pair                                   привязать чат (отправьте боту любое сообщение)
  schedule install|remove|status [--dry-run]      задания launchd: ночные прогоны и сводка
  action list | trust | run <id> [--yes]          действия владельца из раздела actions: список, подтверждение раздела
                                                  (только в терминале), запуск из терминала (итог и в Telegram)
  action prepare|exec <id> --ticket <t>           служебные: их запускает бот после нажатия кнопки
  worktree link                                 в своём worktree: ссылки на общие папки основного каталога (worktree.shared, например node_modules)
  finding add --text <t> [--evidence <t>]        находка для доработки самого mcfly (не проекта); владелец решает в боте, передавать ли
  finding list | finding send <Fн> | finding drop <Fн>   список; передать в общий ящик или убрать (только владелец в терминале)
  video setup | video build [--weekly] [--director off|on|review] [--send]   ролик-сводка с голосом (video.enabled): установить сборщик и озвучку (около 2 ГБ);
                                                  собрать ролик из текущей сводки (--send — отправить в Telegram)
  remind list | remind rm <Rн>                    напоминания владельцу (ставятся в боте: «напомни 19:00 текст»)
Общие флаги: --project <dir> (по умолчанию текущий каталог или MCFLY_PROJECT_DIR)`;

export async function main(argv) {
  const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, strict: false, options: {
    project: { type: 'string' }, mode: { type: 'string' }, changes: { type: 'string' }, 'dry-run': { type: 'boolean' }, send: { type: 'boolean' }, weekly: { type: 'boolean' }, director: { type: 'string' }, list: { type: 'boolean' }, name: { type: 'string' }, 'with-tracker': { type: 'boolean' },
    category: { type: 'string' }, text: { type: 'string' }, default: { type: 'string' }, hours: { type: 'string' }, note: { type: 'string' }, key: { type: 'string' }, value: { type: 'string' },
    change: { type: 'string' }, file: { type: 'string' }, kind: { type: 'string' }, quiet: { type: 'boolean' }, probe: { type: 'boolean' }, once: { type: 'boolean' }, priority: { type: 'string' }, until: { type: 'string' }, yes: { type: 'boolean' }, idea: { type: 'string' }, title: { type: 'string' }, benefit: { type: 'string' }, how: { type: 'string' }, source: { type: 'string' }, ref: { type: 'string' }, size: { type: 'string' }, 'needs-owner': { type: 'string' }, 'new-arguments': { type: 'string' }, status: { type: 'string' }, evidence: { type: 'string' }, followup: { type: 'string' }, ticket: { type: 'string' }, help: { type: 'boolean', short: 'h' } } });
  const [cmd, sub, ...rest] = positionals;
  const givenDir = path.resolve(values.project || process.env.MCFLY_PROJECT_DIR || process.cwd());
  // init — в указанном каталоге, shift — сам различает сессию и основное дерево; остальные — в основном дереве проекта
  let projectDir = givenDir;
  if (cmd && cmd !== 'init' && cmd !== 'shift') {
    const { projectRoot } = await import('./shift-git.js');
    projectDir = projectRoot(givenDir);
    if (projectDir !== givenDir && cmd !== 'worktree') console.error(`mcfly: ${givenDir} — worktree сессии, работаю с основным деревом проекта ${projectDir}`);
  }
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
    case 'run': {
      let changes = null;
      if (values.changes != null) {
        changes = Number(values.changes);
        if (!(Number.isInteger(changes) && changes >= 1 && changes <= MAX_RUN_CHANGES)) { console.error(`--changes: целое число от 1 до ${MAX_RUN_CHANGES}`); return 1; }
      }
      const r = await run({ projectDir, mode: values.mode || 'day', dryRun: !!values['dry-run'], now, log, changes }); return ['ok', 'dry-run', 'missed'].includes(r.status) ? 0 : 1; }
    case 'summary': {
      if (values.weekly && values.list) {
        // Только полный список недели: без --send — файл виджета для просмотра в браузере и его размер, с --send — отправить
        const { weeklyData, sendWeeklyList } = await import('./weekly.js'); const { weeklyWidget, weeklyListHtml, packedSize } = await import('./widget.js');
        const data = weeklyData(p, cfg, { now });
        if (values.send) {
          const token = process.env[cfg.telegram.token_env];
          if (!token || !cfg.telegram.chat_id) { console.error('Telegram не настроен: нет токена или chat_id.'); return 1; }
          const { createTelegram } = await import('./telegram.js');
          return (await sendWeeklyList(cfg, { data, tg: createTelegram({ token }), log })) ? 0 : 1;
        }
        const w = weeklyWidget(data, cfg);
        if (!w) { log(htmlToPlain(weeklyListHtml(data, cfg)) || 'За неделю завершённых изменений нет.'); return 0; }
        // В своей папке владельца, а не в общей временной: там файл с предсказуемым именем могли бы подменить ссылкой
        const dir = path.join(os.homedir(), '.mcfly', 'widget'); fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
        const file = path.join(dir, `weekly-${cfg.project.replace(/[^\p{L}\p{N}_-]+/gu, '-') || 'project'}.html`);
        fs.writeFileSync(file, w.html, { mode: 0o600 });
        log(`${w.caption}\nВиджет: ${file} (${Buffer.byteLength(w.html)} байт, после сжатия ${packedSize(w.html)} из 4096)`); return 0;
      }
      if (values.weekly) { const { sendWeekly, composeWeekly } = await import('./weekly.js'); if (values.send) await sendWeekly(p, cfg, { now, log }); else log(htmlToPlain(composeWeekly(p, cfg, { now }))); return 0; }
      if (values.send) await sendSummary(p, cfg, { now, log }); else { const since = new Date(now.getTime() - 24 * 3600_000); log(htmlToPlain(composeSummary(p, cfg, { now, since }))); log(`\n${techTail(p, cfg, { since })}`); } return 0; }
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
        const to = rest[1]; if (!['proposed', 'taken', 'rejected', 'done'].includes(to)) { console.error('Статус: proposed | taken | rejected | done'); return 1; }
        const r = transitionIdea(data, rest[0], to, { actor: 'session', note: values.note || '', now });
        if (!r.idea || r.error) { console.error(`${rest[0] || '(номер не указан)'}: ${r.error}`); return 1; }
        saveIdeas(p, data); log(`${r.idea.id}: ${IDEA_STATUS_RU[to]}`); return 0;
      }
      if (sub === 'done') {
        // 0.15.5: закрыть взятый пункт по изменению из архива — можно и команде в прогоне: доказательство — само изменение
        if (!values.change) { console.error('Нужно завершённое изменение: mcfly ideas done <Iн> --change <имя>'); return 1; }
        const r = closeIdeaByChange(data, rest[0], values.change, p.openspecChanges, now);
        if (!r.idea || r.error) { console.error(`${rest[0] || '(номер не указан)'}: ${r.error}`); return 1; }
        saveIdeas(p, data); log(`${r.idea.id}: сделано (${r.idea.change})`); return 0;
      }
      if (sub === 'first') {
        // 0.16.0: порядок очереди — решение владельца, в прогоне команды запрещено
        if (runIdEnv) { console.error('Порядок очереди задаёт владелец: в прогоне команды ideas first запрещён'); return 1; }
        const r = markFirst(data, rest[0], now);
        if (!r.idea || r.error) { console.error(`${rest[0] || '(номер не указан)'}: ${r.error}`); return 1; }
        saveIdeas(p, data); log(`${r.idea.id}: первым в очереди на план`); return 0;
      }
      console.error('mcfly ideas list | add | set | done | first'); return 1;
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
        // 0.11.0: при описании продукта владелец одобряет план по образцам — без раздела с образцами (или строки «Снаружи ничего
        // не меняется») план не принимается: 15.11 дизайнера не вызвали ни разу, в том числе для ответа бота с кнопкой
        if (hasProduct(p) && !/^##\s+Как это будет выглядеть\s*$/im.test(c.proposal || '')) {
          console.error(`В плане ${c.name} нет раздела «## Как это будет выглядеть». Если изменение меняет то, что человек видит или нажимает (сообщения и кнопки бота — тоже), лид вызывает mcfly:designer, и тот добавляет образцы; если нет — добавьте в proposal.md этот раздел с одной строкой «Снаружи ничего не меняется». Потом запросите одобрение снова.`); return 1;
        }
        if (values.followup != null) {
          // 0.17.0: доделка к завершённому изменению — без «Берём»: либо одобряется сразу по признакам плана, либо отказ
          // (тогда это обычное предложение в список). Одобрение молчанием для неё не запрашивается.
          if (values.idea) { console.error('--followup и --idea вместе не указывают: доделка — не пункт списка'); return 1; }
          const parent = String(values.followup || '').trim();
          const used = runIdEnv ? readMetrics(p).filter((m) => m.type === 'event' && m.key === 'changes_followup' && m.run_id === runIdEnv).length : 0;
          const block = followupBlock(c, cfg, { parentArchived: /^[a-z0-9][a-z0-9-]*$/.test(parent) && isArchived(p.openspecChanges, parent), used, category });
          if (block) { console.error(`Доделка ${c.name} не принята: ${block}. Удалите черновик изменения и оформите предложением — mcfly ideas add --source team …: владелец решит кнопкой «Берём».`); return 1; }
          writeCategory(c, category);
          approveFast(c, `доделка к ${parent}${fastKind(c) === 'edit' ? ', правка существующего' : ', снаружи ничего не меняется'}`, now, { by: 'followup', followupOf: parent });
          appendMetric(p, { type: 'event', at: now.toISOString(), run_id: runIdEnv, key: 'changes_followup', value: 1, change: c.name });
          appendText(p.answers, `\n## ${fmtLocal(now)} — ${c.name} одобрено сразу как доделка к ${parent}\n`);
          log(`Одобрено сразу: ${c.name} (доделка к ${parent}). Реализуйте её в этом же прогоне после задач владельца.`); return 0;
        }
        let idea = null; let ideas = []; let items = [];
        if (values.idea) {
          // План по пунктам списка (0.7.0): только по взятым владельцем пунктам; пункты становятся спланированными.
          // 0.15.5: пунктов может быть несколько (через запятую) — иначе второй пункт общего плана навсегда оставался «взято».
          const idata = loadIdeas(p); if (idata.error) { console.error(idata.error); return 1; }
          const ids = [...new Set(String(values.idea).split(',').map((x) => x.trim().toUpperCase()).filter(Boolean))];
          const found = ids.map((id) => [id, findIdea(idata, id)]);
          const bad = found.find(([, it]) => !it || it.status !== 'taken');
          if (!ids.length || bad) { console.error(`${bad ? bad[0] : '(номер не указан)'} не взят владельцем (статус: ${bad?.[1] ? IDEA_STATUS_RU[bad[1].status] || bad[1].status : 'нет такого'})`); return 1; }
          for (const [, it] of found) transitionIdea(idata, it.id, 'planned', { actor: 'team', change: c.name, now });
          saveIdeas(p, idata); items = found.map(([, it]) => it); ideas = items.map((it) => it.id); idea = ideas[0];
        }
        // 0.16.0: пункт, который владелец поднял «вперёд», — его план первым в очереди, если приоритет не задан явно
        const priority = values.priority ?? (items.some((it) => it.first_at) ? firstPriority(changes, c) : undefined);
        requestApproval(c, { category, priority, now, idea, ideas }); appendMetric(p, { type: 'event', at: now.toISOString(), run_id: runIdEnv, key: 'changes_proposed', value: 1, change: c.name });
        // 0.16.0, быстрый путь: небольшой взятый пункт без видимых изменений одобряется сразу — по признакам плана, а не по слову команды
        const block = items.length ? fastTrackBlock(c, items, cfg, category) : 'план не по взятому пункту';
        if (!block) {
          approveFast(c, `быстрый путь: ${ideas.join(', ')} — ${[...new Set(items.map((it) => it.size))].join('/')}, ${items.every((it) => it.revert_of) ? 'возврат по кнопке владельца' : fastKind(c) === 'edit' ? 'правка существующего' : 'снаружи ничего не меняется'}`, now);
          appendMetric(p, { type: 'event', at: now.toISOString(), run_id: runIdEnv, key: 'changes_fast', value: 1, change: c.name });
          appendText(p.answers, `\n## ${fmtLocal(now)} — ${c.name} одобрено сразу после «Берём» (быстрый путь, ${ideas.join(', ')})\n`);
          log(`Одобрено сразу: ${c.name} (быстрый путь). Реализуйте его в этом же прогоне, если лимит изменений не исчерпан.`); return 0;
        }
        log(`Одобрение запрошено: ${c.name}. Человек увидит его в утренней сводке.${items.length && cfg.ideas.fast_sizes.length ? ` Ждёт кнопки владельца: ${block}.` : ''}`); return 0; }
      // Решение человека сразу в истории; во время прогона HEAD под агентами не двигаем — метаданные закоммитит прогон.
      const commitMeta = (message) => {
        if (exists(p.lock)) { log('Не закоммичено: идёт прогон, метаданные одобрения закоммитит он.'); return 0; }
        const committed = commitPaths(projectDir, [path.relative(projectDir, path.join(c.dir, '.openspec.yaml'))], message);
        log(!committed.ok ? `Не закоммичено (закоммитит ближайший прогон): ${committed.error}` : committed.committed ? 'Закоммичено.' : 'Изменений нет, коммит не нужен.'); return 0;
      };
      if (sub === 'set') {
        // Одобрение — решение человека: в прогоне команды (MCFLY_RUN_ID задаёт runner) агенты только запрашивают его.
        if (runIdEnv) { console.error('Одобрение ставит только человек: в прогоне команды approval set запрещён, используйте mcfly approval request.'); return 1; }
        const st = rest[1]; if (!['approved', 'rejected'].includes(st)) { console.error('Статус: approved | rejected'); return 1; } setApproval(c, st, 'human-cli', values.note || '', now, { priority: values.priority }); log(`${c.name}: ${st}${values.priority ? ', приоритет ' + values.priority : ''}`);
        return commitMeta(`chore(${c.name}): одобрение человека — ${st}`); }
      if (sub === 'first') {
        // 0.16.0: порядок очереди — решение человека
        if (runIdEnv) { console.error('Порядок очереди задаёт владелец: в прогоне команды approval first запрещён.'); return 1; }
        const r = moveFirst(changes, c.name); if (r.error) { console.error(`${c.name}: ${r.error}`); return 1; }
        log(`${c.name}: первым в очереди (приоритет ${priorityOf(c)})`); return commitMeta(`chore(${c.name}): первым в очереди`);
      }
      if (sub === 'check') {
        // 0.16.2: перед реализацией и перед слиянием — одобрено ли изменение и не менялся ли план после быстрого одобрения
        if (isFastApproved(c) && !fastPlanIntact(c)) {
          holdApproval(c, 'план изменился после быстрого одобрения', now);
          appendText(p.answers, `\n## ${fmtLocal(now)} — ${c.name} возвращено на одобрение владельца\nплан изменился после быстрого одобрения\n`);
          console.error(`${c.name}: план изменился после быстрого одобрения — возвращено на одобрение владельца. Не реализуйте и не сливайте его.`); return 1;
        }
        if (c.mcfly.approval !== 'approved') { console.error(`${c.name}: не одобрено (${c.mcfly.approval || 'не запрошено'}) — не реализуйте и не сливайте его.`); return 1; }
        log(`${c.name}: одобрено, план не менялся.`); return 0;
      }
      if (sub === 'hold') {
        // 0.16.0: страховка быстрого пути — команда может только ужесточить: вернуть план на одобрение владельца
        if (!isFastApproved(c)) { console.error(`${c.name}: вернуть на одобрение можно только план, одобренный без владельца (быстрый путь или доделка)`); return 1; }
        holdApproval(c, values.note || '', now);
        appendText(p.answers, `\n## ${fmtLocal(now)} — ${c.name} возвращено на одобрение владельца\n${values.note || '(без причины)'}\n`);
        log(`${c.name}: ждёт одобрения владельца. Не реализуйте и не сливайте его до одобрения.`); return commitMeta(`chore(${c.name}): возвращено на одобрение`);
      }
      if (sub === 'pause' || sub === 'resume') {
        // 0.7.6: отложить одобренное изменение до даты — тоже решение человека; агенты пишут о стоп-условии в отчёте.
        if (runIdEnv) { console.error(`Откладывает только человек: в прогоне команды approval ${sub} запрещён — напишите о стоп-условии в отчёте.`); return 1; }
        if (sub === 'resume') { clearPause(c); log(`${c.name}: снова в работе`); return commitMeta(`chore(${c.name}): возвращено в работу`); }
        const until = String(values.until || ''); const d = new Date(`${until}T00:00:00`);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(until) || Number.isNaN(d.getTime())) { console.error('Нужна дата: --until ГГГГ-ММ-ДД'); return 1; }
        if (d <= now) { console.error(`Дата ${until} уже прошла: отложить можно только на будущее`); return 1; }
        if (c.mcfly.approval !== 'approved') { console.error(`${c.name} не одобрено: откладывать нечего`); return 1; }
        setPause(c, until, values.note || '', now); log(`${c.name}: отложено до ${until.split('-').reverse().join('.')}`);
        return commitMeta(`chore(${c.name}): отложено до ${until}`);
      }
      break;
    }
    case 'metric': {
      if (sub === 'add') {
        if (!values.key) { console.error('Нужен --key'); return 1; }
        // 0.7.6: «--key "tasks_done 7"» давал битое событие — ключ только из латиницы и «_», число отдельно в --value
        if (!/^[a-z_]+$/.test(values.key)) { console.error(`Ключ — латиница и «_»; число — в --value: mcfly metric add --key ${String(values.key).split(/\s+/)[0]} --value <n>`); return 1; }
        if (values.value != null && !Number.isFinite(Number(values.value))) { console.error('--value — число'); return 1; }
        appendMetric(p, { type: 'event', at: now.toISOString(), run_id: runIdEnv, key: values.key, value: values.value ? Number(values.value) : 1, change: values.change || '' }); log(`метрика ${values.key} записана`); return 0;
      }
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
      const { listActions, getAction, prepareAction, execAction, isTrusted, trustActions, actionFiles, actionCommandLines } = await import('./actions.js');
      const tty = !!(process.stdin.isTTY && process.stdout.isTTY);
      // Действия — решение владельца (прод, общая квота): в прогоне команды (MCFLY_RUN_ID задаёт runner) запуск запрещён.
      if (runIdEnv) { console.error('Действия запускает только владелец кнопкой в боте или из терминала: в прогоне команды mcfly action запрещён.'); return 1; }
      if (sub === 'list' || !sub) {
        const list = listActions(cfg);
        if (!list.length) log('Действий нет: раздел actions в mcfly/config.yaml.');
        else log(isTrusted(p, cfg) ? 'Раздел actions подтверждён владельцем.' : '⚠ Раздел actions не подтверждён — кнопки выключены. Проверьте команды ниже и выполните: mcfly action trust');
        for (const a of list) log(`${a.id}: ${a.title}${a.describe ? ` — ${a.describe}` : ''}${a.confirm ? '' : ' (без подтверждения)'}\n${actionCommandLines(a, cfg)}`);
        return 0;
      }
      if (sub === 'trust') {
        // Только живой терминал: агент (без TTY) не может подтвердить команды, которые сам же поправил.
        if (!tty) { console.error('mcfly action trust — только в терминале владельца (нужен интерактивный ввод).'); return 1; }
        const list = listActions(cfg);
        if (!list.length) { log('Действий нет: раздел actions в mcfly/config.yaml.'); return 1; }
        log('Команды, которые бот сможет запускать по кнопке (prepare и offer — без подтверждения):');
        for (const a of list) log(`\n${a.id} — ${a.title}${a.confirm ? '' : ' (без подтверждения)'}\n${actionCommandLines(a, cfg)}`);
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
    case 'worktree': {
      if (sub !== 'link') { console.error('mcfly worktree link'); return 1; }
      const { linkShared } = await import('./worktree.js');
      const shared = cfg.worktree.shared;
      if (!shared.length) { log('Общих папок нет (worktree.shared пуст) — подключать нечего.'); return 0; }
      // 0.18.1: «где я» — --project или текущий каталог, но не MCFLY_PROJECT_DIR: runner кладёт туда основной каталог,
      // и из worktree агента команда отвечала «это основной каталог». --project с основным каталогом из worktree — тоже текущий.
      const { projectRoot } = await import('./shift-git.js');
      const cwd = fs.realpathSync(process.cwd());
      let top = fs.realpathSync(values.project ? path.resolve(values.project) : cwd);
      let mainDir = fs.realpathSync(projectRoot(top));
      if (top === mainDir && cwd !== mainDir && fs.realpathSync(projectRoot(cwd)) === mainDir) top = cwd;
      if (top === mainDir) { log('Это основной каталог проекта: общие папки здесь свои, ссылки не нужны. В worktree запускай из его каталога или с --project <каталог worktree>.'); return 0; }
      const r = linkShared({ worktreeDir: top, mainDir, shared });
      if (r.linked.length) log(`Подключено: ${r.linked.join(', ')}`);
      if (r.present.length) log(`Уже есть: ${r.present.join(', ')}`);
      if (r.missing.length) { console.error(`Нет в основном каталоге ${mainDir}: ${r.missing.join(', ')} — зависимости ставит лид или devops в основном каталоге; сообщи лиду.`); return 1; }
      return 0;
    }
    case 'finding': {
      // Находки для доработки самого mcfly (0.11.0): регистрируют агенты прогона и сессии, решает владелец
      const { loadFindings, saveFindings, addFinding, decideFinding, inboxPath, FINDING_STATUS_RU } = await import('./findings.js');
      if (cfg.findings.enabled === false) { console.error('Сбор находок выключен: findings.enabled в mcfly/config.yaml'); return 1; }
      const data = loadFindings(p); if (data.error) { console.error(data.error); return 1; }
      if (sub === 'list' || !sub) {
        if (!data.findings.length) log('Находок нет. Добавить: mcfly finding add --text "что не так в самом mcfly"');
        for (const x of data.findings) log(`${x.id} [${FINDING_STATUS_RU[x.status] || x.status}] ${x.text}${x.evidence ? ` — что видели: ${x.evidence}` : ''}`);
        return 0;
      }
      if (sub === 'add') {
        try {
          const it = addFinding(data, { text: values.text, evidence: values.evidence || '', source: runIdEnv ? 'run' : 'session', now, runId: runIdEnv });
          saveFindings(p, data); log(`${it.id} записана. Передавать ли её в доработку mcfly, решит владелец кнопкой в боте («находки»).`); return 0;
        } catch (e) { console.error(e.message); return 1; }
      }
      if (sub === 'send' || sub === 'drop') {
        // Передача — решение владельца: агент (в прогоне или сессии, без живого терминала) сам себе её не одобряет
        if (runIdEnv || !(process.stdin.isTTY && process.stdout.isTTY)) { console.error(`mcfly finding ${sub} — только владелец в терминале; в боте — кнопками в «находки».`); return 1; }
        const r = decideFinding(data, cfg, rest[0], sub, { now });
        if (!r.item || r.error) { console.error(`${rest[0] || '(номер не указан)'}: ${r.error}`); return 1; }
        saveFindings(p, data); log(sub === 'send' ? `${r.item.id} передана в ${inboxPath(cfg)}` : `${r.item.id} убрана`); return 0;
      }
      console.error('mcfly finding add | list | send | drop'); return 1;
    }
    case 'remind': {
      // Ставятся сообщением боту («напомни 19:00 …»); здесь — посмотреть и отменить.
      const { pendingReminders, cancelReminder, whenText } = await import('./reminders.js');
      if (sub === 'list' || !sub) {
        const list = pendingReminders(p);
        if (!list.length) log('Напоминаний нет. Поставить — в боте: «напомни 19:00 текст».');
        for (const r of list) log(`${r.id} — ${whenText(new Date(r.at), now)} (${fmtShort(new Date(r.at))}): ${r.text}`);
        return 0;
      }
      if (sub === 'rm') {
        if (runIdEnv) { console.error('Напоминания владельца отменяет только он: в прогоне команды mcfly remind rm запрещён.'); return 1; }
        const id = String(rest[0] || '').toUpperCase();
        if (!/^R\d+$/.test(id)) { console.error('Укажите номер: mcfly remind rm R3 (список — mcfly remind list)'); return 1; }
        const line = cancelReminder(p, id, now); log(line); return line.startsWith('✖️') ? 0 : 1;
      }
      break;
    }
    case 'video': {
      const { setupVideo, makeSummaryVideo, sendSummaryVideo, SOURCE_RU } = await import('./video.js');
      const { summaryData } = await import('./summary.js');
      if (sub === 'setup') { try { await setupVideo(cfg, { log }); return 0; } catch (e) { console.error(`Установка не удалась: ${e.message}`); return 1; } }
      if (sub === 'build') {
        const weekly = !!values.weekly;
        const mode = values.director ?? cfg.video.director;
        if (!['off', 'on', 'review'].includes(mode)) { console.error('--director: off (сцены из кода), on (режиссёр) или review (режиссёр и зритель)'); return 1; }
        const data = weekly ? (await import('./weekly.js')).weeklyData(p, cfg, { now }) : summaryData(p, cfg, { now, since: new Date(now.getTime() - 24 * 3600_000) });
        if (values.send) {
          const token = process.env[cfg.telegram.token_env];
          if (!token || !cfg.telegram.chat_id) { console.error('Telegram не настроен: нет токена или chat_id.'); return 1; }
          const { createTelegram } = await import('./telegram.js');
          return (await sendSummaryVideo(p, cfg, { data, tg: createTelegram({ token }), now, log, weekly, mode })).sent ? 0 : 1;
        }
        const r0 = await (async () => {
          try { return await makeSummaryVideo(p, cfg, { data, now, weekly, name: weekly ? 'preview-weekly' : 'preview', mode, log }); } catch (e) { console.error(`Ролик не собран: ${e.message}`); return null; }
        })();
        if (!r0) return 1;
        log(`Ролик: ${r0.file} (${r0.seconds} с, ${(r0.bytes / 1048576).toFixed(1)} МБ) · сцены: ${SOURCE_RU[r0.source]}${r0.workDir ? ` · рабочая папка режиссёра: ${r0.workDir}` : ''}`);
        return 0;
      }
      break;
    }
    case 'schedule': {
      const mcflyBin = path.join(MCFLY_ROOT, 'bin', 'mcfly');
      if (sub === 'install') {
        const { failed } = schedule.install(cfg, { projectDir, mcflyBin, logsDir: p.logs, dryRun: !!values['dry-run'], log });
        if (failed.length) console.error(`Не работают задания: ${failed.join(', ')}. Выполните mcfly schedule install ещё раз; проверка — mcfly schedule status.`);
        return failed.length ? 1 : 0;
      }
      if (sub === 'remove') { schedule.remove(cfg, { log }); return 0; }
      if (sub === 'status') { return schedule.status(cfg, { projectDir, mcflyBin, logsDir: p.logs, log }) ? 1 : 0; }
      break;
    }
  }
  console.error(`Неизвестная команда: ${[cmd, sub].filter(Boolean).join(' ')}\n`); log(HELP); return 1;
}
