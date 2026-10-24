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

test('0.5.12: «где мы» — прогон, изменения с прогрессом, вопросы, «Нужно от вас», следующий слот и квота', () => {
  const dir = bareProject(); const p = paths(dir); const now = new Date(2026, 9, 22, 15, 0);
  addChange(dir, 'demo-work', { tasks: '- [x] a\n- [ ] b\n- [ ] c\n' }); addChange(dir, 'demo-pending');
  const [pending, work] = listChanges(p.openspecChanges).sort((a, b) => (a.name === 'demo-pending' ? -1 : 1));
  requestApproval(pending, { now }); setApproval(work, 'approved', 'human', '', now);
  const qd = loadQuestions(p); addQuestion(qd, { category: 'spec', text: 'Порог <150>?', defaultAnswer: '150', now }, cfg); saveQuestions(p, qd);
  report(dir, '20261022-1450', REPORT);
  metric(dir, { type: 'run', id: '20261022-1450', status: 'ok', started_at: new Date(2026, 9, 22, 14, 50).toISOString(), ended_at: new Date(2026, 9, 22, 15, 14).toISOString(), duration_ms: 1444795, cost_usd: 3.58, usage: { five_hour: 0.52, seven_day: 0.14 } });
  const html = statusView(p, { ...cfg, schedule: { ...cfg.schedule, slots: ['02:00', '06:00'] } }, { now }).join('\n');
  assert.match(html, /Прогон сейчас не идёт\. Последний: 22\.10 14:50 — ок, 24 мин, ~\$3\.58/);
  assert.match(html, /🔧 <b>demo-work<\/b> — одобрено, задач 1\/3/);
  assert.match(html, /⏳ <b>demo-pending<\/b> — ждёт одобрения/);
  assert.match(html, /<b>Q1<\/b>: Порог &lt;150&gt;\?/);
  assert.match(html, /1\. Выкатить jar с <code>main<\/code>/);
  assert.doesNotMatch(html, /Одобрить demo-pending/); // одобрение уже видно в списке изменений
  assert.match(html, /Следующий прогон:<\/b> 23\.10 02:00 по расписанию — команда продолжит demo-work \(1\/3\)/);
  assert.match(html, /5 часов — занято 52 %, осталось 48 %; неделя — занято 14 %, осталось 86 % <i>\(замер 22\.10 15:14\)<\/i>/);
});

test('0.5.12: «где мы» в пустом проекте и nextSlot', () => {
  const dir = bareProject(); const p = paths(dir);
  const html = statusView(p, cfg, { now: new Date(2026, 9, 22, 23, 0) }).join('\n');
  assert.match(html, /Прогонов ещё не было/); assert.match(html, /Открытых изменений нет/); assert.match(html, /Открытых вопросов нет/); assert.match(html, /замеров ещё нет/);
  assert.deepEqual(nextSlot(['02:00', '06:00'], new Date(2026, 9, 22, 3, 0)), new Date(2026, 9, 22, 6, 0));
  assert.deepEqual(nextSlot(['02:00', '06:00'], new Date(2026, 9, 22, 6, 0)), new Date(2026, 9, 23, 2, 0));
});

test('0.5.12: «статистика» — за 7 дней и всего: прогоны по статусам, задачи, влитые изменения, возвраты, расход', () => {
  const dir = bareProject(); const p = paths(dir); const now = new Date(2026, 9, 22, 15, 0);
  const day = (n) => new Date(now.getTime() - n * 24 * 3600_000).toISOString();
  metric(dir, { type: 'run', id: 'old', status: 'quota', started_at: day(20), cost_usd: 10 });
  metric(dir, { type: 'event', at: day(20), key: 'tasks_done', value: 5 });
  metric(dir, { type: 'run', id: 'new', status: 'ok', started_at: day(1), cost_usd: 2.5 });
  metric(dir, { type: 'event', at: day(1), key: 'tasks_done', value: 3 });
  metric(dir, { type: 'event', at: day(1), key: 'changes_archived', value: 1 });
  metric(dir, { type: 'event', at: day(1), key: 'review_rejections', value: 2 });
  const html = statsView(p, cfg, { now }).join('\n');
  const [week, all] = html.split('<b>Всего');
  assert.match(week, /прогонов 1 \(ок 1\)/); assert.match(week, /задач закрыто: 3/); assert.match(week, /изменений влито и в архиве: 1/); assert.match(week, /возвратов с ревью: 2/); assert.match(week, /~\$2\.5/);
  assert.match(all, /прогонов 2 \(квота 1, ок 1\)|прогонов 2 \(ок 1, квота 1\)/); assert.match(all, /задач закрыто: 8/); assert.match(all, /~\$12\.5/);
});

test('0.5.12: «последний прогон» — простыми словами, сделано, нужно от вас; длинный отчёт урезает «Сделано»', () => {
  const dir = bareProject(); const p = paths(dir);
  assert.match(lastView(p, cfg).join('\n'), /Отчётов прогонов пока нет/);
  report(dir, '20261022-1450', REPORT);
  report(dir, '20261022-1600', '# Прогон 20261022-1600 (авто-сводка runner)\n');
  metric(dir, { type: 'run', id: '20261022-1450', status: 'ok', started_at: new Date(2026, 9, 22, 14, 50).toISOString(), duration_ms: 60_000 * 24 });
  metric(dir, { type: 'run', id: '20261022-1600', status: 'quota', started_at: new Date(2026, 9, 22, 16, 0).toISOString() });
  const html = lastView(p, cfg).join('\n');
  assert.match(html, /22\.10 14:50 — ок, 24 мин/);
  assert.match(html, /После него ещё прогонов без отчёта: 1, последний 22\.10 16:00 — остановлен: лимит квоты/);
  assert.match(html, /Доделали страницу «На проверку» &lt;без&gt; кода\./);
  assert.match(html, /• <code>ReviewTargets<\/code> вынесен/);
  assert.match(html, /2\. Одобрить demo-pending/);
  const long = `# Прогон\n## Сделано\n${[...Array(60)].map((_, i) => `- пункт ${i} ${'х'.repeat(150)}`).join('\n')}\n## Нужно от человека\n- важное дело\n`;
  report(dir, '20261022-1700', long);
  const parts = lastView(p, cfg);
  assert.equal(parts.length, 1); assert.ok(parts[0].length <= 4096);
  assert.match(parts[0], /1\. важное дело/); assert.match(parts[0], /… ещё \d+ — mcfly\/runs\/20261022-1700\/summary\.md/);
});

test('0.5.12: «помощь» — все команды с примерами', () => {
  const html = helpView(paths(bareProject()), cfg).join('\n');
  for (const re of [/где мы/, /цели/, /статистика/, /последний прогон/, /«запусти»/, /«запусти всё равно»/, /«одобряю /, /«отклоняю /, /«Q12: ответ»/, /свайпом/, /заметка/]) assert.match(html, re);
  assert.match(helpView(paths(bareProject()), { ...cfg, run: { ...cfg.run, telegram_start: false } }).join('\n'), /запуск из Telegram выключен/);
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
  const sent = f.sent();
  assert.equal(sent.length, 5); // только ответы на команды, без «📝 Записал как заметку»
  assert.match(sent[0].text, /📍 <b>Статус/); assert.match(sent[1].text, /Сделано 1 из 2/); assert.match(sent[2].text, /📊 <b>Статистика/);
  assert.match(sent[3].text, /📰 <b>Последний прогон/); assert.match(sent[4].text, /Что умеет бот/);
  for (const s of sent) {
    assert.equal(s.parse_mode, 'HTML'); assert.ok(s.text.length <= 4096 && plainLen(s.text) <= 4096);
    assert.deepEqual(s.reply_markup, { keyboard: MAIN_KEYBOARD, resize_keyboard: true, is_persistent: true });
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
  assert.match(sent[1].text, /🔧 <b>demo-x<\/b> — одобрено/);
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
  assert.equal(announce.length, 1); assert.deepEqual(announce[0].reply_markup.keyboard, MAIN_KEYBOARD);
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
