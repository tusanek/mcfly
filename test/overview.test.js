import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { viewOf, commandText, parseGoals, statusView, goalsView, statsView, lastView, helpView, nextSlot, BOT_COMMANDS, MAIN_KEYBOARD, MENU_REV } from '../src/overview.js';
import { parseMessage } from '../src/answers.js';
import { createTelegram } from '../src/telegram.js';
import { pullAnswers, pollAnswers } from '../src/pull.js';
import { paths } from '../src/state.js';
import { loadQuestions, addQuestion, saveQuestions } from '../src/questions.js';
import { requestApproval, setApproval, listChanges } from '../src/approvals.js';
import { readText } from '../src/util.js';
import { cfg, bareProject, addChange } from './helpers.js';

const tgCfg = { ...cfg, telegram: { chat_id: '42', token_env: 'MCFLY_TEST_OVERVIEW' } };
process.env.MCFLY_TEST_OVERVIEW = 'T';
const msg = (id, text) => ({ update_id: id, message: { message_id: id, chat: { id: 42 }, text, date: 1700000000 } });
function fakeFetch(updates = []) {
  const calls = [];
  const f = async (url, init) => {
    const method = url.split('/').pop(); const body = JSON.parse(init.body); calls.push({ method, body });
    const result = method === 'getUpdates' ? updates.filter((u) => u.update_id >= (body.offset || 0)) : method === 'sendMessage' ? { message_id: 1 } : true;
    return { status: 200, json: async () => ({ ok: true, result }) };
  };
  f.calls = calls; f.sent = () => calls.filter((c) => c.method === 'sendMessage').map((c) => c.body);
  return f;
}
const plainLen = (html) => html.replace(/<[^>]+>/g, '').length;
const metric = (dir, rec) => fs.appendFileSync(path.join(dir, 'mcfly', 'metrics.jsonl'), JSON.stringify(rec) + '\n');
function report(dir, id, body) { fs.mkdirSync(path.join(dir, 'mcfly', 'runs', id), { recursive: true }); fs.writeFileSync(path.join(dir, 'mcfly', 'runs', id, 'summary.md'), body); }
const REPORT = `# Прогон 20261022-1450
## Простыми словами
Доделали страницу «На проверку» <без> кода.
## Сделано
- review-tail: 7 из 7 задач
- \`ReviewTargets\` вынесен
## Нужно от человека
- Выкатить jar с \`main\`
- Одобрить demo-pending
`;

test('0.5.12: команды обзора — текстом, /командой, кнопкой внизу чата; «статус по X» остаётся заметкой', () => {
  for (const [t, v] of [['где мы', 'status'], ['📍 Где мы', 'status'], ['📍 Статус', 'status'], ['Где мы?', 'status'], ['/status', 'status'], ['/status@mcfly_bot', 'status'], ['Статус', 'status'],
    ['🎯 Цели', 'goals'], ['/goals', 'goals'], ['📊 Статистика', 'stats'], ['/stats', 'stats'], ['последний прогон', 'last'], ['/last', 'last'],
    ['помощь', 'help'], ['/help', 'help'], ['/start', 'help']]) assert.equal(viewOf(t), v, t);
  for (const t of ['статус по задаче ORB-1', 'где мы будем завтра?', 'цели на неделю такие', '']) assert.equal(viewOf(t), null, t);
  assert.equal(commandText('  📍  Где   мы?! '), 'где мы');
  assert.deepEqual(parseMessage('🎯 Цели'), { type: 'view', view: 'goals' });
  assert.deepEqual(parseMessage('Q3: где мы'), { type: 'answer', id: 'Q3', text: 'где мы' });
  assert.equal(parseMessage('▶️ Запусти').type, 'run');
  assert.equal(parseMessage('/run').type, 'run');
  assert.equal(parseMessage('/run@mcfly_bot').type, 'run');
});

test('0.5.12: меню команд и клавиатура — латиница для setMyCommands, кнопки из задания', () => {
  for (const c of BOT_COMMANDS) { assert.match(c.command, /^[a-z]+$/); assert.ok(c.description.length <= 256); }
  assert.deepEqual(MAIN_KEYBOARD.flat().map((b) => b.text), ['📍 Статус', '🎯 Цели', '📊 Статистика', '▶️ Запусти']);
  for (const b of MAIN_KEYBOARD.flat()) assert.ok(viewOf(b.text) || parseMessage(b.text).type === 'run', b.text);
  const status = BOT_COMMANDS.find((c) => c.command === 'status').description;
  assert.match(status, /Статус: прогон, изменения, вопросы/); assert.doesNotMatch(status, /квот/i); // 0.9.0: о квоте бот говорит только предупреждением
});

test('0.5.12: parseGoals — цель, веха, чек-лист по группам; комментарии пропускаются', () => {
  const g = parseGoals(`# Цели\n<!-- служебное\n- [x] не пункт -->\n## Цель\nСайт документации.\n## Ближайшая веха\n- Показ в декабре\n## До MVP\n- [x] карта\n- [X] сервер\n### Потом\n- [ ] показ\n`);
  assert.deepEqual(g.goal, ['Сайт документации.']);
  assert.deepEqual(g.milestone, ['Показ в декабре']);
  assert.deepEqual(g.items.map((x) => [x.done, x.text, x.group]), [[true, 'карта', 'До MVP'], [true, 'сервер', 'До MVP'], [false, 'показ', 'Потом']]);
  assert.equal(parseGoals(''), null);
});

test('0.5.12: «цели» — счёт «сделано N из M»; нет файла — подсказка, как его создать', () => {
  const dir = bareProject(); const p = paths(dir);
  const hint = goalsView(p, cfg).join('\n');
  assert.match(hint, /Цели проекта не заданы/); assert.match(hint, /mcfly\/goals\.md/); assert.match(hint, /- \[x\]/);
  fs.writeFileSync(path.join(dir, 'mcfly', 'goals.md'), '## Цель\nДокументация <Орбитума>\n## Ближайшая веха\nДекабрь\n## До MVP\n- [x] один\n- [ ] два `код`\n- [ ] три\n');
  const html = goalsView(p, cfg).join('\n');
  assert.match(html, /<b>Цель:<\/b> Документация &lt;Орбитума&gt;/);
  assert.match(html, /<b>Ближайшая веха:<\/b> Декабрь/);
  assert.match(html, /Сделано 1 из 3/);
  assert.match(html, /✅ один\n⬜ два <code>код<\/code>\n⬜ три/);
});

test('0.5.12: «цели» с длинным чек-листом — одно сообщение, открытые пункты целиком', () => {
  const dir = bareProject(); const p = paths(dir);
  const items = [...Array(80)].map((_, i) => `- [x] сделанный пункт номер ${i} с длинным пояснением, чтобы список не влез в одно сообщение`).join('\n');
  fs.writeFileSync(path.join(dir, 'mcfly', 'goals.md'), `## До MVP\n${items}\n- [ ] последний открытый\n`);
  const parts = goalsView(p, cfg);
  assert.equal(parts.length, 1); assert.ok(parts[0].length <= 4096);
  assert.match(parts[0], /Сделано 80 из 81/); assert.match(parts[0], /⬜ последний открытый/); assert.match(parts[0], /и ещё 80 сделанных/);
});

test('0.5.12/0.9.0: «где мы» — прогон, изменения с названием и прогрессом словами, вопросы, «Нужно от вас», следующий слот; о лимите молчит', () => {
  const dir = bareProject(); const p = paths(dir); const now = new Date(2026, 9, 22, 15, 0);
  addChange(dir, 'demo-work', { tasks: '- [x] a\n- [ ] b\n- [ ] c\n', proposal: '# Proposal\n\n## Why\nСтраница «На проверку» для редакторов. Вторая фраза не нужна.\n' });
  addChange(dir, 'demo-pending', { proposal: '# Proposal\n\nПоказ демо заказчику.\n' });
  const [pending, work] = listChanges(p.openspecChanges).sort((a, b) => (a.name === 'demo-pending' ? -1 : 1));
  requestApproval(pending, { now }); setApproval(work, 'approved', 'human', '', now);
  const qd = loadQuestions(p); addQuestion(qd, { category: 'spec', text: 'Порог <150>?', defaultAnswer: '150', now }, cfg); saveQuestions(p, qd);
  report(dir, '20261022-1450', REPORT);
  metric(dir, { type: 'run', id: '20261022-1450', status: 'ok', started_at: new Date(2026, 9, 22, 14, 50).toISOString(), ended_at: new Date(2026, 9, 22, 15, 14).toISOString(), duration_ms: 1444795, cost_usd: 3.58, usage: { five_hour: 0.52, seven_day: 0.14 } });
  const html = statusView(p, { ...cfg, schedule: { ...cfg.schedule, slots: ['02:00', '06:00'] } }, { now }).join('\n');
  assert.match(html, /Прогон сейчас не идёт\. Последний: 22\.10 14:50 — прошёл успешно, 24 мин\n/);
  assert.match(html, /🔧 <b>«Страница «На проверку» для редакторов»<\/b> — одобрено, сделано 1 из 3 шагов\n/);
  assert.match(html, /⏳ <b>«Показ демо заказчику»<\/b> — ждёт одобрения/);
  // 0.9.0: без стоимости, слота, служебных имён изменений и «задач 1/3»
  for (const re of [/\$/, /слот/, /demo-work/, /demo-pending/, /Вторая фраза/, /задач \d/, /\d\/\d/, /дальше:/]) assert.doesNotMatch(html, re);
  assert.match(html, /<b>Q1<\/b>: Порог &lt;150&gt;\?/);
  assert.match(html, /1\. Выкатить jar с <code>main<\/code>/);
  assert.doesNotMatch(html, /Одобрить demo-pending/); // одобрение уже видно в списке изменений
  assert.match(html, /Следующий прогон:<\/b> 23\.10 02:00 по расписанию — команда продолжит «Страница «На проверку» для редакторов» \(сделано 1 из 3 шагов\)/);
  // 0.9.0: занято 52 % и 14 % — меньше порога, о лимите подписки ни строки
  for (const re of [/Лимит подписки/, /занято/, /осталось/, /замер/, /квот/i, /52 %|48 %|14 %|86 %/]) assert.doesNotMatch(html, re);
});

const usageStatus = (five, seven) => {
  const dir = bareProject(); const p = paths(dir);
  metric(dir, { type: 'run', id: '20261022-1450', status: 'ok', started_at: new Date(2026, 9, 22, 14, 50).toISOString(), ended_at: new Date(2026, 9, 22, 15, 14).toISOString(), duration_ms: 1444795, usage: { five_hour: five, seven_day: seven } });
  return statusView(p, cfg, { now: new Date(2026, 9, 22, 15, 30) }).join('\n');
};
test('0.9.0: «статус» — занято 79 % лимита подписки: строки о лимите нет', () => {
  for (const html of [usageStatus(0.79, 0.14), usageStatus(0.14, 0.79), usageStatus(0.79, 0.79)]) {
    for (const re of [/Лимит подписки/, /⚠️/, /осталось/, /занято/, /замер/, /79 %|21 %/]) assert.doesNotMatch(html, re);
  }
});
test('0.9.0: «статус» — от 80 % лимита подписки предупреждение словами с верным остатком', () => {
  const five = usageStatus(0.8, 0.14); // ровно порог, неделя в норме — о неделе не говорим
  assert.match(five, /⚠️ <b>Лимит подписки почти исчерпан:<\/b> на ближайшие 5 часов осталось 20 %\. Прогон может остановиться раньше времени <i>\(замер 22\.10 15:14\)<\/i>/);
  assert.doesNotMatch(five, /на неделю/); assert.doesNotMatch(five, /86 %|14 %/);
  const week = usageStatus(0.52, 0.85);
  assert.match(week, /Лимит подписки почти исчерпан:<\/b> на неделю осталось 15 %\./); assert.doesNotMatch(week, /5 часов/);
  const both = usageStatus(0.93, 0.8);
  assert.match(both, /Лимит подписки почти исчерпан:<\/b> на ближайшие 5 часов осталось 7 %, на неделю осталось 20 %\./);
  assert.match(usageStatus(1.04, 0.14), /на ближайшие 5 часов осталось 0 %/, 'остаток не уходит в минус');
  for (const html of [five, week, both]) for (const re of [/занято/, /квот/i, /\$/]) assert.doesNotMatch(html, re);
});

test('0.9.0: «статус» при идущем прогоне — с какого времени и сколько идёт; без номера прогона и «Последнее действие»', () => {
  const dir = bareProject(); const p = paths(dir); const now = new Date(2026, 9, 22, 2, 24);
  fs.mkdirSync(path.join(p.runs, '20261022-0200'), { recursive: true });
  fs.writeFileSync(path.join(p.runs, '20261022-0200', 'events.log'), '02:20 Bash: npm test\n02:23 Edit src/ReviewTargets.java\n');
  fs.writeFileSync(p.lock, JSON.stringify({ pid: process.pid, at: new Date(2026, 9, 22, 2, 0).toISOString(), id: '20261022-0200' }));
  metric(dir, { type: 'run', id: '20261021-1450', status: 'ok', started_at: new Date(2026, 9, 21, 14, 50).toISOString(), duration_ms: 60_000 * 24 });
  const c = { ...cfg, actions: { deploy: { title: '🚀 Выкатить', run: 'true' } } };
  const html = statusView(p, c, { now }).join('\n');
  assert.match(html, /▶️ <b>Идёт прогон<\/b> с 22\.10 02:00, уже 24 мин — итог придёт сообщением\n/);
  for (const re of [/20261022-0200/, /20261022/, /Последнее действие/, /npm test/, /ReviewTargets/, /Edit/, /Прогон сейчас не идёт/, /Последний:/]) assert.doesNotMatch(html, re);
  // действия не подтверждены владельцем — о выключенных кнопках бот говорит, но словами
  assert.match(html, /⚠️ Кнопки действий выключены: их настройки изменились\. Чтобы включить, наберите в терминале/);
  for (const re of [/config\.yaml/, /Раздел actions/, /не подтверждён/]) assert.doesNotMatch(html, re);
  fs.unlinkSync(p.lock);
  assert.match(statusView(p, cfg, { now }).join('\n'), /Прогон сейчас не идёт\. Последний: 21\.10 14:50 — прошёл успешно, 24 мин/);
});

test('0.5.12: «где мы» в пустом проекте и nextSlot', () => {
  const dir = bareProject(); const p = paths(dir);
  const html = statusView(p, cfg, { now: new Date(2026, 9, 22, 23, 0) }).join('\n');
  assert.match(html, /Прогонов ещё не было/); assert.match(html, /Открытых изменений нет/); assert.match(html, /Открытых вопросов нет/);
  for (const re of [/замер/, /Лимит подписки/, /квот/i]) assert.doesNotMatch(html, re); // 0.9.0: замеров нет — о лимите молчим
  assert.deepEqual(nextSlot(['02:00', '06:00'], new Date(2026, 9, 22, 3, 0)), new Date(2026, 9, 22, 6, 0));
  assert.deepEqual(nextSlot(['02:00', '06:00'], new Date(2026, 9, 22, 6, 0)), new Date(2026, 9, 23, 2, 0));
});

test('0.5.12/0.9.0: «статистика» — за 7 дней и всего: прогоны по статусам словами, задачи, доведённые изменения, вопросы; без расхода, возвратов и падений тестов', () => {
  const dir = bareProject(); const p = paths(dir); const now = new Date(2026, 9, 22, 15, 0);
  const day = (n) => new Date(now.getTime() - n * 24 * 3600_000).toISOString();
  metric(dir, { type: 'run', id: 'old', status: 'quota', started_at: day(20), cost_usd: 10 });
  metric(dir, { type: 'event', at: day(20), key: 'tasks_done', value: 5 });
  metric(dir, { type: 'run', id: 'new', status: 'ok', started_at: day(1), cost_usd: 2.5 });
  metric(dir, { type: 'event', at: day(1), key: 'tasks_done', value: 3 });
  metric(dir, { type: 'event', at: day(1), key: 'changes_archived', value: 1 });
  metric(dir, { type: 'event', at: day(1), key: 'review_rejections', value: 2 });
  metric(dir, { type: 'event', at: day(1), key: 'test_failures', value: 4 });
  metric(dir, { type: 'event', at: day(1), key: 'changes_proposed', value: 2 });
  metric(dir, { type: 'event', at: day(1), key: 'escalations', value: 1 });
  metric(dir, { type: 'event', at: day(20), key: 'escalations', value: 6 });
  const html = statsView(p, cfg, { now }).join('\n');
  const [week, all] = html.split('<b>Всего');
  assert.match(week, /<b>За 7 дней<\/b>\n🌙 прогонов 1 \(успешных 1\)\n✅ задач сделано: 3\n🏁 изменений доведено до конца: 1 \(предложено 2\)\n❓ вопросов к вам: 1\n/);
  assert.match(all, /прогонов 2 \(успешных 1, остановлено по лимиту подписки 1\)\n✅ задач сделано: 8\n🏁 изменений доведено до конца: 1 \(предложено 2\)\n❓ вопросов к вам: 7$/);
  // 0.9.0: без расхода в долларах, возвратов с ревью, падений тестов, жаргона статусов и курсивной приписки
  for (const re of [/\$/, /2\.5|12\.5/, /возврат/, /ревью/, /тест/, /падени/, /квота/, /\(ок /, /<i>/, /влито/, /архив/]) assert.doesNotMatch(html, re);
});

test('0.5.12/0.9.0: «последний прогон» — простыми словами и нужно от вас, без списка «Сделано»; длинный отчёт — одно сообщение', () => {
  const dir = bareProject(); const p = paths(dir);
  assert.match(lastView(p, cfg).join('\n'), /Отчётов прогонов пока нет/);
  report(dir, '20261022-1450', REPORT);
  report(dir, '20261022-1600', '# Прогон 20261022-1600 (авто-сводка runner)\n');
  metric(dir, { type: 'run', id: '20261022-1450', status: 'ok', started_at: new Date(2026, 9, 22, 14, 50).toISOString(), duration_ms: 60_000 * 24 });
  metric(dir, { type: 'run', id: '20261022-1600', status: 'quota', started_at: new Date(2026, 9, 22, 16, 0).toISOString() });
  const html = lastView(p, cfg).join('\n');
  assert.match(html, /22\.10 14:50 — прошёл успешно, 24 мин\n/);
  assert.match(html, /После него ещё прогонов без отчёта: 1, последний 22\.10 16:00 — остановлен: кончился лимит подписки<\/i>/);
  assert.match(html, /\n\nДоделали страницу «На проверку» &lt;без&gt; кода\.\n\n<b>🙋 Нужно от вас<\/b>\n1\. Выкатить jar с <code>main<\/code>\n2\. Одобрить demo-pending/); // отчёт старого формата читается как есть
  // 0.9.0: список «Сделано» и пути к файлам отчёта бот не показывает
  for (const re of [/Сделано/, /ReviewTargets/, /review-tail/, /7 из 7/, /mcfly\/runs/, /summary\.md/, /квот/, /\$/]) assert.doesNotMatch(html, re);
  const long = `# Прогон\n## Сделано\n${[...Array(60)].map((_, i) => `- пункт ${i} ${'х'.repeat(150)}`).join('\n')}\n## Нужно от человека\n- важное дело\n`;
  report(dir, '20261022-1700', long);
  const parts = lastView(p, cfg);
  assert.equal(parts.length, 1); assert.ok(parts[0].length <= 4096);
  assert.match(parts[0], /1\. важное дело/);
  // пересказа нет — бот говорит об этом словами, а длинное «Сделано» не показывает ни целиком, ни хвостом со ссылкой на файл
  assert.match(parts[0], /\n\nКоманда не оставила пересказа этого прогона простыми словами\.\n\n<b>🙋 Нужно от вас<\/b>/);
  for (const re of [/Сделано/, /пункт \d/, /ххх/, /… ещё \d+/, /mcfly\/runs/, /summary\.md/]) assert.doesNotMatch(parts[0], re);
  assert.ok(parts[0].length < 400, 'без «Сделано» сообщение короткое');
  // длинный пересказ урезается до 1500 символов — сообщение одно, «Нужно от вас» на месте
  report(dir, '20261022-1800', `# Прогон\n## Простыми словами\nЧто сделано: ${'слово '.repeat(600)}конец пересказа.\n## Нужно от человека\n- важное дело\n`);
  const cut = lastView(p, cfg);
  assert.equal(cut.length, 1);
  const plain = /\n\n(<b>Что сделано:<\/b> [^\n]*)\n\n/.exec(cut[0])[1];
  assert.ok(plainLen(plain) <= 1500 && plainLen(plain) > 1400, `пересказ ${plainLen(plain)} символов`);
  assert.match(plain, /…$/); assert.doesNotMatch(cut[0], /конец пересказа/); assert.match(cut[0], /1\. важное дело/);
});

test('0.9.0: «последний прогон» с отчётом нового формата — три абзаца с жирными началами, без «Сделано» и путей', () => {
  const dir = bareProject(); const p = paths(dir);
  report(dir, '20261115-0200', `# Прогон 20261115-0200
## Простыми словами
Что сделано: страница «На проверку» теперь показывает, <кто> проверяет.
Продолжение первого абзаца с \`кодом\`.

Зачем: редакторы быстрее находят свои задачи: это двигает показ в декабре.
Что дальше: команда займётся поиском.
## Сделано
- review-tail: 7 из 7 задач
- \`ReviewTargets\` вынесен в mcfly/runs/20261115-0200/notes.md
## В работе
- search-box: 1/4
## Метрики прогона
- ходов 120, ~$3.58, субагентов 4
## Нужно от человека
- Посмотреть страницу и сказать, всё ли понятно
`);
  metric(dir, { type: 'run', id: '20261115-0200', status: 'ok', started_at: new Date(2026, 10, 15, 2, 0).toISOString(), duration_ms: 60_000 * 55, cost_usd: 3.58, num_turns: 120 });
  const html = lastView(p, cfg).join('\n');
  assert.match(html, /^📰 <b>Последний прогон · demo<\/b>\n15\.11 02:00 — прошёл успешно, 55 мин\n\n/);
  assert.match(html, /\n\n<b>Что сделано:<\/b> страница «На проверку» теперь показывает, &lt;кто&gt; проверяет\. Продолжение первого абзаца с кодом\.\n<b>Зачем:<\/b> редакторы быстрее находят свои задачи: это двигает показ в декабре\.\n<b>Что дальше:<\/b> команда займётся поиском\.\n\n/);
  assert.equal((html.match(/<b>(Что сделано|Зачем|Что дальше):<\/b>/g) || []).length, 3);
  assert.match(html, /<b>🙋 Нужно от вас<\/b>\n1\. Посмотреть страницу и сказать, всё ли понятно$/);
  for (const re of [/Сделано/, /В работе/, /Метрики/, /mcfly\/runs/, /summary\.md/, /20261115-0200/, /ReviewTargets/, /review-tail/, /search-box/, /\$/, /ходов/, /субагент/, /`/]) assert.doesNotMatch(html, re);
  // «нет» в пересказе — как отсутствие пересказа; просьб нет — так и сказано
  report(dir, '20261115-0600', '# Прогон\n## Простыми словами\nнет\n## Сделано\n- что-то\n## Нужно от человека\nнет\n');
  const none = lastView(p, cfg).join('\n');
  assert.match(none, /Команда не оставила пересказа этого прогона простыми словами\.\n\n🙋 От вас ничего не нужно$/);
  assert.doesNotMatch(none, /что-то|Сделано/);
});

test('0.5.12: «помощь» — все команды с примерами', () => {
  const html = helpView(paths(bareProject()), cfg).join('\n');
  for (const re of [/где мы/, /цели/, /статистика/, /последний прогон/, /«запусти»/, /«запусти всё равно»/, /«одобряю /, /«отклоняю /, /«Q12: ответ»/, /свайпом/, /заметка/]) assert.match(html, re);
  const off = helpView(paths(bareProject()), { ...cfg, run: { ...cfg.run, telegram_start: false } }).join('\n');
  assert.match(off, /запуск из Telegram выключен в настройках проекта/);
  // 0.9.0: описания обзоров простыми словами, без имён настроек конфигурации, квоты и расхода
  assert.match(html, /«статус» или \/status \(по-старому «где мы»\) — ссылки проекта, идёт ли прогон, изменения и сколько по ним сделано, вопросы, что нужно от вас, следующий прогон\n/);
  assert.match(html, /«статистика» или \/stats — прогоны, задачи, изменения и вопросы к вам за 7 дней и всего\n/);
  assert.match(html, /«последний прогон» или \/last — пересказ простыми словами: что сделано, зачем, что дальше и что нужно от вас\n/);
  for (const h of [html, off]) for (const re of [/telegram_start/, /run\./, /ideas\.enabled/, /config\.yaml/, /квот/i, /расход/, /\$/, /возврат/]) assert.doesNotMatch(h, re);
});

test('0.5.12: бот отвечает на «где мы», «цели», «статистика», «последний прогон», «помощь» сразу и ничего не меняет', async () => {
  const dir = bareProject(); const p = paths(dir);
  addChange(dir, 'demo-pending'); requestApproval(listChanges(p.openspecChanges)[0], { now: new Date() });
  const qd = loadQuestions(p); addQuestion(qd, { category: 'spec', text: 'Порог?', defaultAnswer: '150', now: new Date() }, cfg); saveQuestions(p, qd);
  report(dir, '20261022-1450', REPORT);
  fs.writeFileSync(path.join(dir, 'mcfly', 'goals.md'), '## Цель\nДокументация\n## До MVP\n- [x] один\n- [ ] два\n');
  const before = { answers: readText(p.answers), questions: readText(p.questions), meta: readText(path.join(p.openspecChanges, 'demo-pending', '.openspec.yaml')) };
  const f = fakeFetch(['где мы', '🎯 Цели', 'статистика', '/last', 'помощь'].map((t, i) => msg(100 + i, t)));
  const started = [];
  await pullAnswers({ projectDir: dir, cfg: tgCfg, p, telegram: createTelegram({ token: 'T', fetchImpl: f }), log: () => {}, startRun: (d) => started.push(d) });
  const all = f.sent();
  assert.equal(all.length, 6); // только ответы на команды, без «📝 Записал как заметку»; у «статуса» — ещё сообщение с кнопками решений
  assert.match(all[1].text, /Ждут вашего решения/);
  const sent = all.filter((_, i) => i !== 1);
  assert.match(sent[0].text, /📍 <b>Статус/); assert.match(sent[1].text, /Сделано 1 из 2/); assert.match(sent[2].text, /📊 <b>Статистика/);
  assert.match(sent[3].text, /📰 <b>Последний прогон/); assert.match(sent[4].text, /Что умеет бот/);
  for (const s of sent) {
    assert.equal(s.parse_mode, 'HTML'); assert.ok(s.text.length <= 4096 && plainLen(s.text) <= 4096);
    assert.deepEqual(s.reply_markup, { keyboard: mainKeyboard(tgCfg), resize_keyboard: true, is_persistent: true });
  }
  assert.deepEqual(started, []);
  assert.deepEqual({ answers: readText(p.answers), questions: readText(p.questions), meta: readText(path.join(p.openspecChanges, 'demo-pending', '.openspec.yaml')) }, before);
});

test('0.5.12: одобрение и «где мы» в одной пачке — ответ уже видит одобрение', async () => {
  const dir = bareProject(); const p = paths(dir);
  addChange(dir, 'demo-x'); requestApproval(listChanges(p.openspecChanges)[0], { now: new Date() });
  const f = fakeFetch([msg(1, 'одобряю demo-x'), msg(2, 'где мы')]);
  await pullAnswers({ projectDir: dir, cfg: tgCfg, p, telegram: createTelegram({ token: 'T', fetchImpl: f }), log: () => {}, startRun: () => {} });
  const sent = f.sent();
  assert.match(sent[0].text, /✅ одобрено: demo-x/);
  assert.match(sent[1].text, /🔧 <b>«Зачем: тест»<\/b> — одобрено, сделано 1 из 2 шагов/); // 0.9.0: название — первая фраза описания
  assert.doesNotMatch(sent[1].text, /demo-x/); assert.doesNotMatch(sent[1].text, /ждёт одобрения/);
});

test('0.6.3: «статус» присылает кнопки одобрения и отклонения изменений и ответов по умолчанию; без них — без лишнего сообщения', async () => {
  const dir = bareProject(); const p = paths(dir);
  addChange(dir, 'demo-a'); addChange(dir, 'demo-b');
  for (const c of listChanges(p.openspecChanges)) requestApproval(c, { now: new Date() });
  const qd = loadQuestions(p); addQuestion(qd, { category: 'spec', text: 'Порог?', defaultAnswer: '150', now: new Date() }, cfg); saveQuestions(p, qd);
  const f = fakeFetch([msg(1, '📍 Статус')]);
  await pullAnswers({ projectDir: dir, cfg: tgCfg, p, telegram: createTelegram({ token: 'T', fetchImpl: f }), log: () => {}, startRun: () => {} });
  const sent = f.sent();
  assert.equal(sent.length, 2);
  assert.match(sent[0].text, /📍 <b>Статус/);
  assert.match(sent[1].text, /Ждут вашего решения/);
  const data = sent[1].reply_markup.inline_keyboard.flat().map((b) => b.callback_data);
  assert.deepEqual(data.sort(), ['ap:demo-a', 'ap:demo-b', 'qd:Q1', 'qu:1', 'rj:demo-a', 'rj:demo-b']);

  setApproval(listChanges(p.openspecChanges).find((c) => c.name === 'demo-a'), 'approved', 'test');
  setApproval(listChanges(p.openspecChanges).find((c) => c.name === 'demo-b'), 'rejected', 'test');
  const q2 = loadQuestions(p); q2.questions[0].status = 'answered'; saveQuestions(p, q2);
  const f2 = fakeFetch([msg(2, 'статус')]);
  await pullAnswers({ projectDir: dir, cfg: tgCfg, p, telegram: createTelegram({ token: 'T', fetchImpl: f2 }), log: () => {}, startRun: () => {} });
  assert.equal(f2.sent().length, 1, 'решать нечего — только статус');
});

test('0.5.12: задание answers один раз ставит меню команд и присылает клавиатуру', async () => {
  const dir = bareProject(); const p = paths(dir);
  let t = Date.UTC(2026, 9, 22, 10, 0); const clock = () => t; const sleep = async (ms) => { t += ms; };
  const f = fakeFetch();
  const tg = createTelegram({ token: 'T', fetchImpl: async (url, init) => { if (url.endsWith('/getUpdates')) t += 5_000; return f(url, init); } });
  for (let i = 0; i < 2; i++) await pollAnswers({ projectDir: dir, cfg: tgCfg, p, telegram: tg, log: () => {}, durationMs: 20_000, clock, sleep, startRun: () => {} });
  const menus = f.calls.filter((c) => c.method === 'setMyCommands');
  assert.equal(menus.length, 1); assert.deepEqual(menus[0].body.commands, BOT_COMMANDS);
  const announce = f.sent().filter((s) => /команды обзора/.test(s.text));
  assert.equal(announce.length, 1); assert.deepEqual(announce[0].reply_markup.keyboard, mainKeyboard(tgCfg));
  assert.equal(readText(path.join(p.logs, '.bot-menu')).trim(), MENU_REV);
});

test('0.5.12: сбой setMyCommands — меню повторится в следующем цикле, опрос идёт', async () => {
  const dir = bareProject(); const p = paths(dir);
  let t = Date.UTC(2026, 9, 22, 10, 0); const clock = () => t; const sleep = async (ms) => { t += ms; };
  const logs = [];
  const tg = { async setMyCommands() { throw new Error('fetch failed'); }, async sendMessage() { return []; }, async getUpdates() { t += 5_000; return []; } };
  const stats = await pollAnswers({ projectDir: dir, cfg: tgCfg, p, telegram: tg, log: (l) => logs.push(l), durationMs: 10_000, clock, sleep, startRun: () => {} });
  assert.ok(stats.polls >= 1);
  assert.ok(logs.some((l) => /Меню команд бота не обновлено: fetch failed/.test(l)));
  assert.equal(readText(path.join(p.logs, '.bot-menu')), '');
});

test('0.6.1: «статус» — ссылки проекта из links под заголовком; неверный адрес — ошибка конфигурации', async () => {
  const { parseConfig } = await import('../src/config.js');
  const dir = bareProject(); const p = paths(dir);
  const c = { ...cfg, links: { 'Сайт': 'http://10.0.0.1:8080/latest/', 'На проверку': 'http://10.0.0.1:8080/latest/review/' } };
  const html = statusView(p, c).join('\n');
  assert.match(html, /📍 <b>Статус · demo<\/b>/);
  assert.match(html, /🔗 <a href="http:\/\/10\.0\.0\.1:8080\/latest\/">Сайт<\/a> · <a href="http:\/\/10\.0\.0\.1:8080\/latest\/review\/">На проверку<\/a>/);
  assert.doesNotMatch(statusView(p, cfg).join('\n'), /🔗/);
  assert.throws(() => parseConfig('project: x\nlinks:\n  Сайт: javascript:alert(1)\n'), /links\.Сайт: адрес/);
  assert.throws(() => parseConfig('project: x\nlinks:\n  Сайт: \'http://a"b\'\n'), /links\.Сайт: адрес/, 'кавычка в адресе сломала бы href');
});

import { ideasView, ideasKeyboard, mainKeyboard } from '../src/overview.js';
import { loadIdeas, saveIdeas, addIdea, transitionIdea } from '../src/ideas.js';
import { parseConfig } from '../src/config.js';
const seed = (p, list) => { const d = loadIdeas(p); for (const o of list) addIdea(d, { benefit: `польза ${o.title}`, source: 'team', size: 'S', ...o }); saveIdeas(p, d); return d; };

test('0.7.0: «Предложения» — ваши первыми, взятые сверху, кнопки Берём/Не сейчас и Ещё', () => {
  const p = paths(bareProject());
  const d = seed(p, [
    { title: 'Автозапуск релизов', source: 'owner-backlog', ref: 'SHARED-UNDERSTANDING §4.1 п. 7', size: 'M' },
    { title: 'Копия в GitLab', source: 'owner-note', needsOwner: 'адрес репозитория' },
    ...Array.from({ length: 7 }, (_, i) => ({ title: `Идея команды ${i + 1}` })),
  ]);
  transitionIdea(d, 'I9', 'taken', { actor: 'bot' }); saveIdeas(p, d);
  const html = ideasView(p, cfg).join('\n');
  assert.match(html, /⏳ I9 — ждёт прогона/);
  assert.match(html, /💡 I1 · ваш · средняя работа\n<b>Автозапуск релизов<\/b>\nЧто даст: польза Автозапуск релизов\nОткуда: SHARED-UNDERSTANDING §4\.1 п\. 7/);
  assert.match(html, /💡 I2 · ваш · небольшая работа\n/); assert.match(html, /💡 I3 · команда · небольшая работа\n/);
  assert.doesNotMatch(html, / · [SML]\n/); // 0.9.0: размер словами, не буквой
  assert.match(html, /🙋 От вас понадобится: адрес репозитория/);
  assert.ok(html.indexOf('I1 · ваш') < html.indexOf('I2 · ваш') && html.indexOf('I2 · ваш') < html.indexOf('I3 · команда'));
  const rows = ideasKeyboard(p, cfg);
  assert.deepEqual(rows[0], [{ text: '✅ Берём I1', callback_data: 'ib:I1' }, { text: '⏸ Не сейчас', callback_data: 'ix:I1' }]);
  assert.equal(rows.length, 8);
  assert.deepEqual(rows.at(-1), [{ text: 'Ещё ▸', callback_data: 'il:2' }]);
  const page2 = ideasKeyboard(p, cfg, { page: 2 });
  assert.deepEqual(page2.map((r) => r[0].callback_data), ['ib:I8']);
  assert.match(ideasView(p, cfg, { page: 2 }).join('\n'), /💡 I8 · команда · небольшая работа\n/);
  const sized = paths(bareProject());
  seed(sized, [{ title: 'Большая', size: 'L' }]);
  assert.match(ideasView(sized, cfg).join('\n'), /💡 I1 · команда · большая работа\n<b>Большая<\/b>/);
});

test('0.7.0: «Предложения» — пусто, выключено, испорченный файл, отложенные', () => {
  const p = paths(bareProject());
  assert.match(ideasView(p, cfg).join('\n'), /Предложений пока нет: команда добавит их в следующем прогоне, или напишите «идея: …»/);
  const off = { ...cfg, ideas: { ...cfg.ideas, enabled: false } };
  assert.match(ideasView(p, off).join('\n'), /Список предложений выключен в настройках проекта$/);
  assert.doesNotMatch(ideasView(p, off).join('\n'), /ideas\.enabled|false|config/); // 0.9.0: без имени настройки
  assert.deepEqual(ideasKeyboard(p, off), []);
  const d = seed(p, [{ title: 'Одна' }]); transitionIdea(d, 'I1', 'discuss', { actor: 'bot' }); saveIdeas(p, d);
  assert.match(ideasView(p, cfg).join('\n'), /🗣 Обсудить в сессии: 1/);
  fs.writeFileSync(p.ideas, 'ideas: [oops\n');
  assert.match(ideasView(p, cfg).join('\n'), /⚠️ mcfly\/ideas\.yaml/);
  assert.deepEqual(ideasKeyboard(p, cfg), []);
});

test('0.7.0: клавиатура — третий ряд «Предложения» и «Действия»; кнопка не превращается в идею', () => {
  assert.deepEqual(mainKeyboard(cfg).map((r) => r.map((b) => b.text)), [['📍 Статус', '🎯 Цели'], ['📊 Статистика', '▶️ Запусти'], ['💡 Предложения']]);
  assert.equal(mainKeyboard({ ...cfg, ideas: { ...cfg.ideas, enabled: false } }).length, 2);
  const withActions = parseConfig('project: x\nactions:\n  st:\n    title: "🩺 Состояние"\n    run: "true"\n');
  assert.deepEqual(mainKeyboard(withActions)[2].map((b) => b.text), ['💡 Предложения', '🛠 Действия']);
  for (const t of ['💡 Предложения', 'предложения', 'идеи', '/ideas']) assert.equal(viewOf(t), 'ideas', t);
  assert.deepEqual(parseMessage('💡 Предложения'), { type: 'view', view: 'ideas' });
  assert.deepEqual(parseMessage('предложения 2'), { type: 'view', view: 'ideas', page: 2 });
  assert.equal(MENU_REV, '0.8.0');
});

test('0.7.0: «Статус» — план по пункту само не одобрится; без работы — подсказка выбрать предложение', () => {
  const dir = bareProject(); const p = paths(dir);
  addChange(dir, 'auto-release', { meta: { schema: 'spec-driven', mcfly: { approval: 'pending', category: 'spec', requested_at: new Date().toISOString(), idea: 'I1' } } });
  const html = statusView(p, cfg).join('\n');
  assert.match(html, /⏳ <b>I1<\/b> — ждёт вашего решения, само не одобрится\n\n/);
  assert.doesNotMatch(html, /auto-release/); assert.doesNotMatch(html, /<i>/); // 0.9.0: служебного имени курсивом нет
  const dir2 = bareProject(); const p2 = paths(dir2);
  seed(p2, [{ title: 'Ваша', source: 'owner-note' }, { title: 'Команды' }]);
  assert.match(statusView(p2, cfg).join('\n'), /работы нет — 💡 предложений 2 \(ваших 1\): выберите в «Предложениях»/);
  const d = loadIdeas(p2); transitionIdea(d, 'I2', 'taken', { actor: 'bot' }); saveIdeas(p2, d);
  assert.match(statusView(p2, cfg).join('\n'), /Следующий прогон:<\/b>.* — план по I2/);
});
test('0.7.0: «Предложения» — спланированный пункт показывает состояние плана', () => {
  const dir = bareProject(); const p = paths(dir);
  const d = seed(p, [{ title: 'A' }, { title: 'B' }]);
  for (const [id, ch] of [['I1', 'ch-a'], ['I2', 'ch-b']]) { transitionIdea(d, id, 'taken', { actor: 'bot' }); transitionIdea(d, id, 'planned', { actor: 'team', change: ch }); }
  saveIdeas(p, d);
  addChange(dir, 'ch-a', { meta: { mcfly: { approval: 'pending', idea: 'I1' } } });
  addChange(dir, 'ch-b', { meta: { mcfly: { approval: 'approved', idea: 'I2' } } });
  const html = ideasView(p, cfg).join('\n');
  assert.match(html, /📝 I1 — план готов, ждёт вашего решения в «Статусе»: A\n/);
  assert.match(html, /🔧 I2 — план одобрен, команда делает: B$/);
  for (const re of [/ch-a/, /ch-b/, /→/, /изменение/]) assert.doesNotMatch(html, re); // 0.9.0: без служебных имён изменений
});

test('0.7.1/0.9.0: «Предложения» — «Что даст» целиком, строки «Как» нет, длинный список режется на сообщения до 4000', () => {
  const p = paths(bareProject());
  const benefit = `Начало пользы. ${'польза '.repeat(80)}Конец пользы.`;
  const how = `Начало как. ${'шаг '.repeat(60)}Конец как.`;
  seed(p, Array.from({ length: 7 }, (_, i) => ({ title: `Длинная ${i + 1}`, benefit, how })));
  const parts = ideasView(p, cfg);
  const html = parts.join('\n');
  assert.match(html, /Что даст: Начало пользы\.[^\n]*Конец пользы\./);
  for (const re of [/Как:/, /Начало как/, /Конец как/, /шаг шаг/]) assert.doesNotMatch(html, re); // 0.9.0: «Как» — техника, остаётся в файле списка
  assert.equal((html.match(/Что даст: /g) || []).length, 7, 'все пункты страницы показаны');
  assert.doesNotMatch(html, /…\n/);
  assert.ok(parts.length > 1, 'длинный список — несколько сообщений');
  for (const part of parts) assert.ok(part.length <= 4000, `кусок ${part.length}`);
});

test('0.7.2: «помощь» — какие действия с подтверждением, какие сразу', () => {
  const c = parseConfig('project: x\nactions:\n  deploy:\n    title: "🚀 Выкатить"\n    run: "true"\n  backup:\n    title: "📦 Копия данных"\n    run: "true"\n    confirm: false\n');
  const html = helpView(paths(bareProject()), c).join('\n');
  assert.match(html, /с подтверждением «✅ Да, выполнить»: 🚀 Выкатить; сразу, без подтверждения: 📦 Копия данных; итог приходит сообщением/);
});

test('0.7.4/0.9.0: «Статус» — у изменения номер и название пункта или первая фраза описания; без служебного имени и следующей задачи', () => {
  const dir = bareProject(); const p = paths(dir);
  seed(p, [{ title: '«Как проверять»: убрать фразу' }]);
  const tasks = '- [x] 1.1 Поменять текст\n- [ ] 2.1 Поправить тест текста\n- [ ] 2.2 Ещё\n';
  addChange(dir, 'review-guide-reason-phrase', { tasks, meta: { mcfly: { approval: 'approved', idea: 'I1' } } });
  addChange(dir, 'plain-change', { tasks, proposal: '# Proposal\n\n## Why\nУбрать `лишнюю` <фразу> со страницы. Потом ещё одно.\n', meta: { mcfly: { approval: 'approved' } } });
  addChange(dir, 'x-one-step', { tasks: '- [ ] 1.1 Единственная\n', proposal: '', meta: { mcfly: { approval: 'approved', idea: 'I7' } } });
  addChange(dir, 'by-idea-pending', { meta: { mcfly: { approval: 'pending', idea: 'I1', requested_at: new Date().toISOString() } } });
  const html = statusView(p, cfg).join('\n');
  assert.match(html, /🔧 <b>I1 ««Как проверять»: убрать фразу»<\/b> — одобрено, сделано 1 из 3 шагов\n(?! )/);
  assert.match(html, /🔧 <b>«Убрать лишнюю &lt;фразу&gt; со страницы»<\/b> — одобрено, сделано 1 из 3 шагов\n(?! )/);
  assert.match(html, /⏳ <b>I1 ««Как проверять»: убрать фразу»<\/b> — ждёт вашего решения, само не одобрится\n(?! )/);
  assert.match(html, /🔧 <b>I7<\/b> — одобрено, сделано 0 из 1 шага\n/); // пункта I7 в списке нет — только номер; «из 1 шага»
  assert.match(html, /Следующий прогон:<\/b>.* — команда продолжит «Убрать лишнюю &lt;фразу&gt; со страницы» \(сделано 1 из 3 шагов\), I1 \(сделано 1 из 3 шагов\), I7 \(сделано 0 из 1 шага\)/);
  // 0.9.0: служебные имена, «задач 1/3» и текст следующей задачи — только в терминале
  for (const re of [/review-guide-reason-phrase/, /plain-change/, /by-idea-pending/, /x-one-step/, /дальше:/, /Поправить тест/, /Единственная/, /задач \d/, /\d\/\d/, /<i>/, /Потом ещё/]) assert.doesNotMatch(html, re);
});

import { setPause as sp } from '../src/approvals.js';
test('0.7.6: «Статус» — отложенное изменение «⏸ … отложено до», в следующий прогон не идёт', () => {
  const dir = bareProject(); const p = paths(dir);
  addChange(dir, 'zen', { tasks: '- [ ] 1.1\n', meta: { schema: 'spec-driven', mcfly: { approval: 'approved', idea: 'I52' } } });
  sp(listChanges(p.openspecChanges)[0], '2027-02-01', '', new Date(2026, 9, 28));
  const html = statusView(p, cfg, { now: new Date(2026, 9, 28, 10, 0) }).join('\n');
  assert.match(html, /⏸ <b>I52<\/b> — отложено до 01\.02\.2027, сделано 0 из 1 шага\n/);
  assert.doesNotMatch(html, /zen/); assert.doesNotMatch(html, /задач \d/);
  assert.doesNotMatch(html, /продолжит I52/);
});

test('0.7.10: «Статус» и «Последний прогон» фильтруют «Нужно от вас» так же, как сводка: нажатый выкат, решённые пункты списка, повторы', () => {
  const dir = bareProject(); const p = paths(dir);
  const c = { ...cfg, actions: { deploy: { title: '🚀 Выкатить', run: 'true' } } };
  report(dir, '20261029-2038', '# Прогон\n## Сделано\n- I80: план\n## Нужно от человека\n- Нажать «🚀 Выкатить» вечером (I72, I74), затем раздать «На проверку»\n- Решить по предложениям I81, I82\n- Включить дайджест: добавить бота в группу\n- Включить дайджест — добавить бота в группу\n');
  metric(dir, { type: 'run', id: '20261029-2038', status: 'ok', started_at: new Date(2026, 9, 29, 20, 38).toISOString(), ended_at: new Date(2026, 9, 29, 22, 25).toISOString(), duration_ms: 6420_000 });
  fs.writeFileSync(path.join(dir, 'mcfly', 'ideas.yaml'), 'ideas:\n  - id: I81\n    title: a\n    status: proposed\n  - id: I82\n    title: b\n    status: taken\n');
  const view = (now) => statusView(p, c, { now }).join('\n');
  // до выката — просьба нажать остаётся
  assert.match(view(new Date(2026, 9, 29, 23, 0)), /Нажать «🚀 Выкатить»/);
  metric(dir, { type: 'action', id: 'deploy', status: 'ok', exit_code: 0, started_at: new Date(2026, 9, 29, 23, 36).toISOString(), ended_at: new Date(2026, 9, 29, 23, 44).toISOString(), duration_ms: 480_000 });
  for (const html of [view(new Date(2026, 9, 29, 23, 45)), lastView(p, c).join('\n')]) {
    assert.doesNotMatch(html, /Выкатить/);
    assert.doesNotMatch(html, /Решить по предложениям I81/);
    assert.equal((html.match(/Включить дайджест/g) || []).length, 1);
  }
});
