import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs'; import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { paths } from '../src/state.js';
import { init, mainBranchIssue } from '../src/init.js';
import { doctor } from '../src/doctor.js';
import { parseConfig } from '../src/config.js';
import { commitRunState, recordRun, finishIdeas, finishMessage, freshIdeasMessages } from '../src/runner.js';
import { composeSummary, summaryKeyboard } from '../src/summary.js';
import { proposalSamples, listChanges } from '../src/approvals.js';
import { sendSamples, sendView, viewOf, statusView, helpView } from '../src/overview.js';
import { tickGoals } from '../src/goals.js';
import { loadIdeas, saveIdeas, addIdea, transitionIdea } from '../src/ideas.js';
import { loadQuestions, addQuestion, saveQuestions } from '../src/questions.js';
import { loadFindings, saveFindings, addFinding, decideFinding, findingsView, pendingFindings, inboxPath, mcflyVersion } from '../src/findings.js';
import { parseMessage, applyMessages } from '../src/answers.js';
import { callbackText } from '../src/telegram.js';
import { buildContext } from '../src/context.js';
import { buildLeadPrompt, MCFLY_ROOT } from '../src/prompt.js';
import { cfg, bareProject, tmpDir, git, gitRepo, addChange } from './helpers.js';

const record = (over = {}) => ({ id: 'r1', mode: 'day', slot: null, started_at: '2026-11-15T10:03:00.000Z', status: 'ok', duration_ms: 8 * 60_000, ...over });
const fakeTg = () => { const tg = { sent: [], async sendMessage(_c, text, o = {}) { tg.sent.push({ text, html: !!o.html, keyboard: o.keyboard || null }); return []; } }; return tg; };
const withInbox = (over = {}) => { const inbox = path.join(tmpDir('inbox-'), 'mcfly-inbox.md'); return { ...cfg, project: 'demo', findings: { enabled: true, inbox }, ...over }; };
const cli = (dir, args, env = {}) => spawnSync(process.execPath, [path.join(MCFLY_ROOT, 'bin', 'mcfly'), ...args, '--project', dir], { encoding: 'utf8', env: { ...process.env, MCFLY_RUN_ID: '', ...env } });

// ——— Находки запуска нового проекта (15.11.2026) ———

test('0.11.0: файлы первого прогона коммитятся при пустом mcfly/shifts; init кладёт .gitkeep', () => {
  const dir = gitRepo(bareProject()); const p = paths(dir);
  fs.mkdirSync(p.shifts, { recursive: true }); // как после init до 0.11.0: каталог пуст, git его не видит
  recordRun(p, record());
  const logs = [];
  assert.equal(commitRunState(dir, 'r1', (s) => logs.push(s)), true, logs.join('\n'));
  assert.match(git(dir, 'show', '--name-only', '--format=', 'HEAD'), /mcfly\/runs\/r1\/result\.json/);
  const fresh = tmpDir(); init({ projectDir: fresh, name: 'demo', skipOpenspec: true, log: () => {} });
  assert.ok(fs.existsSync(path.join(fresh, 'mcfly', 'shifts', '.gitkeep')));
});

test('0.11.0: init и doctor замечают, что в проекте нет ветки main; подсказка init ставит schedule install сразу после pair', () => {
  const dir = tmpDir(); git(dir, 'init', '-q', '-b', 'master');
  assert.match(mainBranchIssue(dir), /Сейчас ветка «master»: переименуйте её командой git branch -m master main/);
  const logs = []; init({ projectDir: dir, name: 'demo', skipOpenspec: true, log: (s) => logs.push(s) });
  assert.ok(logs.some((l) => /^⚠ В проекте нет ветки main/.test(l)));
  const hint = logs.find((l) => l.startsWith('Дальше:'));
  assert.ok(hint.indexOf('telegram pair') < hint.indexOf('schedule install') && hint.indexOf('schedule install') < hint.indexOf('mcfly doctor'), hint);
  assert.ok(doctor({ projectDir: dir, log: () => {} }).some((c) => !c.ok && c.label === 'ветка main в проекте' && /git branch -m master main/.test(c.hint)));
  git(dir, 'branch', '-m', 'master', 'main');
  assert.equal(mainBranchIssue(dir), '', 'main без коммитов — уже в порядке');
  assert.ok(doctor({ projectDir: dir, log: () => {} }).some((c) => c.ok && c.label === 'ветка main в проекте'));
  assert.equal(mainBranchIssue(tmpDir()), '', 'не git — не наша забота');
});

test('0.11.0: doctor предупреждает, что бот не ответит на кнопки без задания answers', { skip: process.platform !== 'darwin' }, () => {
  const dir = bareProject();
  fs.writeFileSync(path.join(dir, 'mcfly', 'config.yaml'), 'project: demo\ntelegram:\n  chat_id: "42"\n  token_env: MCFLY_TEST_TG_DOCTOR\n');
  process.env.MCFLY_TEST_TG_DOCTOR = 'T';
  const calls = [];
  const off = doctor({ projectDir: dir, log: () => {}, launchctl: (a) => { calls.push(a.join(' ')); return { status: 113 }; } });
  assert.ok(off.some((c) => !c.ok && /бот не будет отвечать на кнопки и сообщения — нет задания answers/.test(c.label) && /mcfly schedule install/.test(c.hint)));
  assert.match(calls[0], /^print gui\/\d+\/com\.mcfly\.demo\.answers$/);
  const on = doctor({ projectDir: dir, log: () => {}, launchctl: () => ({ status: 0 }) });
  assert.ok(on.some((c) => c.ok && /задание answers работает/.test(c.label)));
  delete process.env.MCFLY_TEST_TG_DOCTOR;
});

test('0.11.0: образец — одно сообщение с заголовком курсивом; «бот молчит» — заголовком, а не ответом бота', async () => {
  const proposal = '## Как это будет выглядеть\n\n### Пишет владелец\n```\nЗаписал.\n[Отменить]\n```\n\n### Пишет кто-то другой — бот молчит\n\n### Пишет посторонний\n```\n(бот не отвечает совсем)\n```\n';
  assert.deepEqual(proposalSamples({ proposal }), [
    { title: 'Пишет владелец', text: 'Записал.', buttons: [['Отменить']] },
    { title: 'Пишет кто-то другой — бот молчит', text: '', buttons: [] },
    { title: 'Пишет посторонний', text: '(бот не отвечает совсем)', buttons: [] },
  ]);
  const dir = bareProject(); const p = paths(dir); addChange(dir, 'quiet', { proposal });
  const tg = fakeTg();
  assert.equal(await sendSamples(tg, '42', p, cfg, 'quiet'), 3);
  assert.deepEqual(tg.sent.slice(1).map((m) => m.text), [
    '<i>1. Пишет владелец</i>\n\nЗаписал.',
    '<i>2. Пишет кто-то другой — бот молчит</i>',
    '<i>3. Пишет посторонний — бот не отвечает совсем</i>',
  ]);
  assert.equal(tg.sent.length, 4, 'по одному сообщению на образец');
  assert.deepEqual(tg.sent[1].keyboard.map((r) => r.map((b) => b.text)), [['Отменить']]);
});

test('0.11.0: подсказка «свой ответ: Qн» — только при открытом вопросе и с его номером', () => {
  const dir = bareProject(); const p = paths(dir);
  addChange(dir, 'add-y', { meta: { schema: 'spec-driven', mcfly: { approval: 'pending', category: 'spec', requested_at: new Date().toISOString() } } });
  const only = finishMessage(cfg, record(), p).text;
  assert.match(only, /\nКнопки ниже\n/); assert.doesNotMatch(only, /Q\d/);
  assert.doesNotMatch(composeSummary(p, cfg, {}), /свой ответ/);
  const data = loadQuestions(p);
  for (let i = 0; i < 6; i++) addQuestion(data, { category: 'spec', text: `вопрос ${i}`, defaultAnswer: 'да' }, cfg);
  data.questions.slice(0, 5).forEach((q) => { q.status = 'answered'; }); saveQuestions(p, data);
  assert.match(finishMessage(cfg, record(), p).text, /Кнопки ниже; свой ответ — текстом: «Q6: …»/);
  assert.match(composeSummary(p, cfg, {}), /свой ответ: «Q6: текст»/);
});

test('0.11.0: сделанный пункт бэклога владельца отмечается в goals.md, итог прогона говорит об этом', () => {
  const dir = gitRepo(bareProject()); const p = paths(dir);
  const goals = path.join(dir, 'mcfly', 'goals.md');
  fs.writeFileSync(goals, '## Цель\nПлан с утра.\n\n## До MVP\n- [ ] Приём дел **голосом** и текстом\n- [ ] Утренний план\n- [ ] Вечерний разговор\n');
  git(dir, 'add', '.'); git(dir, 'commit', '-q', '-m', 'проект');
  const d = loadIdeas(p);
  addIdea(d, { title: 'Приём дел голосом и текстом', benefit: 'y', source: 'owner-backlog', size: 'M' });
  addIdea(d, { title: 'Утренний план', benefit: 'y', source: 'team', size: 'S' });
  for (const id of ['I1', 'I2']) { transitionIdea(d, id, 'taken', { actor: 'bot' }); transitionIdea(d, id, 'planned', { actor: 'team', change: `gone-${id.toLowerCase()}` }); }
  saveIdeas(p, d);
  const info = {};
  assert.deepEqual(finishIdeas(p, cfg, info).map((x) => x.id), ['I1', 'I2']);
  assert.deepEqual(info.goals, ['Приём дел голосом и текстом']);
  assert.equal(fs.readFileSync(goals, 'utf8'), '## Цель\nПлан с утра.\n\n## До MVP\n- [x] Приём дел **голосом** и текстом\n- [ ] Утренний план\n- [ ] Вечерний разговор\n', 'только галочка; идея команды цели не отмечает');
  assert.equal(loadIdeas(p).ideas[0].goal_checked, true);
  assert.match(finishMessage(cfg, record({ goals_checked: info.goals }), p).text, /🎯 Отмечено в целях: Приём дел голосом и текстом/);
  recordRun(p, record());
  assert.equal(commitRunState(dir, 'r1', () => {}, ['mcfly/goals.md']), true);
  assert.match(git(dir, 'show', '--name-only', '--format=', 'HEAD'), /mcfly\/goals\.md/);
  // владелец снял галочку — второй раз не ставим
  fs.writeFileSync(goals, fs.readFileSync(goals, 'utf8').replace('[x]', '[ ]'));
  const again = {}; finishIdeas(p, cfg, again); assert.deepEqual(again.goals, []);
});

test('0.11.0: tickGoals не гадает — два похожих пункта или непохожий остаются как были', () => {
  const dir = bareProject(); const p = paths(dir); const goals = path.join(dir, 'mcfly', 'goals.md');
  fs.writeFileSync(goals, '- [ ] Напоминания о делах утром\n- [ ] Напоминания о делах вечером\n- [x] Поиск\n');
  assert.deepEqual(tickGoals(p, [{ title: 'Напоминания о делах' }, { title: 'Экспорт в календарь' }, { title: 'Поиск' }]), []);
  assert.deepEqual(tickGoals(p, [{ title: 'Напоминания о делах вечером' }]), ['Напоминания о делах вечером']);
  assert.deepEqual(tickGoals(paths(bareProject()), [{ title: 'x' }]), [], 'нет goals.md');
});

test('0.11.0: прогон только пополнил список — «Предложения» с кнопками идут сразу за итогом', () => {
  const dir = bareProject(); const p = paths(dir); const since = new Date('2026-11-15T10:00:00Z');
  assert.deepEqual(freshIdeasMessages(p, cfg, since), []);
  const d = loadIdeas(p); addIdea(d, { title: 'Приём дел голосом', benefit: 'быстрее', source: 'owner-backlog', size: 'M', now: new Date('2026-11-15T10:05:00Z') }); saveIdeas(p, d);
  const m = freshIdeasMessages(p, cfg, since);
  assert.match(m[0].text, /💡 <b>Предложения · demo<\/b>[\s\S]*Приём дел голосом/);
  assert.deepEqual(m.at(-1).keyboard[0].map((b) => b.callback_data), ['ib:I1', 'ix:I1']);
  assert.deepEqual(freshIdeasMessages(p, cfg, new Date('2026-11-15T11:00:00Z')), [], 'пункты старые — список остаётся по кнопке');
  addChange(dir, 'add-y', { meta: { schema: 'spec-driven', mcfly: { approval: 'pending', category: 'spec', requested_at: new Date().toISOString() } } });
  assert.deepEqual(freshIdeasMessages(p, cfg, since), [], 'есть план на одобрении — не отвлекаем');
});

test('0.11.0: план без раздела образцов не принимается на одобрение при описании продукта', () => {
  const dir = bareProject(); addChange(dir, 'plain');
  assert.equal(cli(dir, ['approval', 'request', 'plain']).status, 0, 'без описания продукта — как раньше');
  addChange(dir, 'bot-reply'); fs.writeFileSync(path.join(dir, 'mcfly', 'product.md'), '## Что это\nАссистент.\n');
  const no = cli(dir, ['approval', 'request', 'bot-reply']);
  assert.equal(no.status, 1); assert.match(no.stderr, /нет раздела «## Как это будет выглядеть»[\s\S]*mcfly:designer[\s\S]*Снаружи ничего не меняется/);
  fs.appendFileSync(path.join(dir, 'openspec', 'changes', 'bot-reply', 'proposal.md'), '\n## Как это будет выглядеть\nСнаружи ничего не меняется.\n');
  assert.equal(cli(dir, ['approval', 'request', 'bot-reply']).status, 0);
});

test('0.11.0: правила ролей — дизайнера зовёт лид, «вы», три абзаца, окружение в проекте, ничего сверх пункта', () => {
  const read = (f) => fs.readFileSync(path.join(MCFLY_ROOT, f), 'utf8');
  const dir = bareProject(); const p = paths(dir);
  const prompt = () => buildLeadPrompt({ cfg, p, runId: 'r1', mode: 'day', deadline: new Date(2026, 10, 15, 12), context: 'ctx' });
  assert.doesNotMatch(prompt(), /сам вызови mcfly:designer|\{\{DESIGN\}\}/);
  fs.writeFileSync(path.join(dir, 'mcfly', 'product.md'), '## Что это\nАссистент.\n');
  assert.match(prompt(), /сообщения и кнопки бота, уведомления, экраны — после планировщика сам вызови mcfly:designer[^\n]*`mcfly ideas add --source team`/);
  assert.doesNotMatch(prompt(), /\\`/, 'в задании нет лишних обратных косых');
  assert.match(prompt(), /три абзаца — «Что сделано:», «Зачем:», «Что дальше:», на «вы»/);
  assert.match(prompt(), /mcfly finding add --text/);
  assert.doesNotMatch(read('agents/planner.md'), /вызови mcfly:designer/);
  assert.match(read('agents/planner.md'), /не добавляй в план функций сверх пункта списка/);
  assert.match(read('agents/reporter.md'), /Все три абзаца обязательны[\s\S]*на «вы»[\s\S]*если ещё не сделано/);
  assert.match(read('agents/designer.md'), /блока под подзаголовком не ставь вовсе/);
  const skill = read('skills/mcfly-process/SKILL.md');
  for (const re of [/## Тексты для владельца/, /## Находки для доработки mcfly/, /не в `\/tmp` и не в другом временном каталоге/, /Дизайнера вызывает лид/]) assert.match(skill, re);
  for (const a of fs.readdirSync(path.join(MCFLY_ROOT, 'agents'))) assert.match(read(`agents/${a}`), /mcfly finding add/, a);
  assert.match(read('templates/CLAUDE.snippet.md'), /mcfly finding add/);
});

// ——— Автопередача находок ———

test('0.11.0: находка — запись, повтор, секреты; настройки findings', () => {
  const dir = bareProject(); const p = paths(dir); const data = loadFindings(p);
  const f = addFinding(data, { text: 'mcfly init создаёт пустую mcfly/shifts.\nКоммит падает', evidence: 'pathspec did not match, ключ sk-ant-abc123', source: 'run', runId: 'r7' });
  assert.deepEqual([f.id, f.status, f.source, f.run_id, f.mcfly_version], ['F1', 'new', 'run', 'r7', mcflyVersion()]);
  assert.equal(f.text, 'mcfly init создаёт пустую mcfly/shifts. Коммит падает'); assert.match(f.evidence, /sk-ant-\*\*\*/);
  assert.throws(() => addFinding(data, { text: 'MCFLY init создаёт пустую mcfly/shifts — коммит падает!' }), /уже есть: F1/);
  assert.throws(() => addFinding(data, { text: '  ' }), /Нужен текст находки/);
  saveFindings(p, data); assert.equal(pendingFindings(p, cfg), 1);
  assert.equal(pendingFindings(p, { ...cfg, findings: { enabled: false, inbox: 'x' } }), 0);
  fs.writeFileSync(p.findings, 'findings:\n  - \n'); assert.match(loadFindings(p).error, /элемент 1 без номера вида F1/);
  assert.equal(parseConfig('project: demo\n').findings.inbox, '~/mcfly-inbox.md');
  assert.match(inboxPath(parseConfig('project: demo\n')), /^\/.+\/mcfly-inbox\.md$/);
  assert.throws(() => parseConfig('project: demo\nfindings:\n  inbox: ""\n'), /findings\.inbox/);
});

test('0.11.0: одобренная находка дописывается в общий ящик с проектом, датой и версией; «не надо» — нет', () => {
  const dir = bareProject(); const p = paths(dir); const c = withInbox(); const now = new Date(2026, 10, 15, 12, 0);
  const data = loadFindings(p);
  addFinding(data, { text: 'Первая проблема. Подробности тут', evidence: 'строка журнала', source: 'run' });
  addFinding(data, { text: 'Вторая проблема', source: 'session' }); addFinding(data, { text: 'Третья проблема' });
  assert.equal(decideFinding(data, c, 'F1', 'send', { now }).error, null);
  assert.equal(decideFinding(data, c, 'f2', 'send', { now }).error, null);
  assert.equal(decideFinding(data, c, 'F3', 'drop', { now }).item.status, 'dropped');
  assert.match(decideFinding(data, c, 'F1', 'send', { now }).error, /уже передано/);
  assert.equal(decideFinding(data, c, 'F9', 'send', { now }).item, null);
  const text = fs.readFileSync(c.findings.inbox, 'utf8');
  assert.match(text, /^# Входящие для доработки mcfly\n/);
  assert.equal(text.split(`## 15.11.2026 · demo · mcfly ${mcflyVersion()}`).length, 2, 'один заголовок на день, проект и версию');
  assert.match(text, /Одобрено владельцем 15\.11\.2026\.\n\n- \[ \] \*\*Первая проблема\.\*\* Подробности тут Что видели: строка журнала _\(F1, заметила команда в прогоне\)_\n- \[ \] \*\*Вторая проблема\*\* _\(F2, заметила сессия Claude Code\)_\n$/);
  assert.doesNotMatch(text, /Третья/);
  // ящик недоступен — находка остаётся ждать решения
  const bad = { ...c, findings: { enabled: true, inbox: path.join(c.findings.inbox, 'нельзя', 'x.md') } };
  addFinding(data, { text: 'Четвёртая проблема' });
  const r = decideFinding(data, bad, 'F4', 'send', { now });
  assert.match(r.error, /не удалось записать в ящик/); assert.equal(r.item.status, 'new');
});

test('0.11.0: бот — «mcfly: текст» сразу в ящик, экран «находки» с кнопками «Передать» / «Не надо»', async () => {
  const dir = bareProject(); const p = paths(dir); const c = withInbox();
  assert.deepEqual(parseMessage('mcfly: кнопки молчат без schedule install'), { type: 'finding', text: 'кнопки молчат без schedule install' });
  assert.deepEqual(parseMessage(callbackText('fb:F2')), { type: 'findingSend', id: 'F2' });
  assert.deepEqual(parseMessage(callbackText('fb:все')), { type: 'findingSend', id: 'ВСЕ' });
  assert.deepEqual(parseMessage(callbackText('fx:F2')), { type: 'findingDrop', id: 'F2' });
  assert.deepEqual(parseMessage(callbackText('fl:1')), { type: 'view', view: 'findings' });
  assert.equal(viewOf('Находки'), 'findings'); assert.equal(parseMessage('не надо так делать').type, 'note');
  const before = fs.readFileSync(p.answers, 'utf8');
  assert.deepEqual(applyMessages(p, [{ text: 'mcfly: кнопки молчат без schedule install' }, { text: 'mcfly:' }], { cfg: c }),
    ['📮 F1 передал в ящик доработки mcfly', '⚠️ Напишите после «mcfly:», что не так в самом mcfly']);
  assert.match(fs.readFileSync(c.findings.inbox, 'utf8'), /\*\*кнопки молчат без schedule install\*\* _\(F1, написал владелец\)_/);
  assert.equal(fs.readFileSync(p.answers, 'utf8'), before, 'находка для mcfly — не заметка команде проекта');
  const data = loadFindings(p);
  addFinding(data, { text: 'Первый прогон почти пустой', evidence: 'только перенос бэклога', source: 'run' }); addFinding(data, { text: 'Обращение скачет ты/вы', source: 'session' }); addFinding(data, { text: 'Лишний шаг <b>', source: 'run' });
  saveFindings(p, data);
  const v = findingsView(p, c);
  assert.match(v.text, /📮 <b>Находки для доработки mcfly · demo<\/b>[\s\S]*<b>F2<\/b> · заметила команда в прогоне[\s\S]*Первый прогон почти пустой\n<i>Что видели: только перенос бэклога<\/i>[\s\S]*Лишний шаг &lt;b&gt;/);
  assert.deepEqual(v.keyboard.map((r) => r.map((b) => b.callback_data)), [['fb:F2', 'fx:F2'], ['fb:F3', 'fx:F3'], ['fb:F4', 'fx:F4'], ['fb:все']]);
  const tg = fakeTg(); await sendView(tg, '42', 'findings', p, c);
  assert.equal(tg.sent.length, 1); assert.equal(tg.sent[0].keyboard.length, 4);
  // решение ждёт владельца: кнопка под сводкой и итогом прогона, строка в сводке, «Статусе» и контексте команды
  assert.deepEqual(summaryKeyboard(p, c).at(-1), [{ text: '📮 Находки для mcfly (3)', callback_data: 'fl:1' }]);
  assert.match(composeSummary(p, c, {}), /Решить, передавать ли находки для доработки mcfly: 3/);
  assert.match(finishMessage(c, record(), p).text, /📮 Находки для доработки mcfly: 3/);
  assert.match(statusView(p, c).join('\n'), /📮 Находки для доработки mcfly: 3/);
  assert.match(buildContext(p, c), /Находки для доработки самого mcfly \(mcfly finding add\): ждут решения владельца 3 — не дублируй: F2 «Первый прогон почти пустой»/);
  assert.match(helpView(p, c).join('\n'), /«mcfly: текст»/);
  assert.deepEqual(applyMessages(p, [{ text: 'не надо F2' }, { text: 'передать все' }, { text: 'передать F2' }, { text: 'передать F9' }], { cfg: c }),
    ['🚫 F2 убрал — передавать не буду', '📮 F3 передал в ящик доработки mcfly', '📮 F4 передал в ящик доработки mcfly', 'ℹ️ F2: уже не надо', '⚠️ F9: такой находки нет']);
  assert.equal(pendingFindings(p, c), 0); assert.equal(summaryKeyboard(p, c).length, 0);
  assert.match(findingsView(p, c).text, /Новых находок нет/);
  assert.doesNotMatch(fs.readFileSync(c.findings.inbox, 'utf8'), /Первый прогон почти пустой/);
});

test('0.11.0: mcfly finding — add из прогона и сессии, list; send и drop только владелец в терминале', () => {
  const dir = bareProject(); const p = paths(dir);
  const a = cli(dir, ['finding', 'add', '--text', 'Команда mcfly ideas add падает на кавычках', '--evidence', 'YAMLParseError'], { MCFLY_RUN_ID: '20261115-1512' });
  assert.equal(a.status, 0, a.stderr); assert.match(a.stdout, /F1 записана\. Передавать ли её в доработку mcfly, решит владелец/);
  assert.equal(cli(dir, ['finding', 'add', '--text', 'Вторая находка']).status, 0);
  assert.deepEqual(loadFindings(p).findings.map((x) => [x.id, x.source, x.run_id]), [['F1', 'run', '20261115-1512'], ['F2', 'session', '']]);
  assert.equal(cli(dir, ['finding', 'add', '--text', 'вторая находка']).status, 1);
  assert.match(cli(dir, ['finding', 'list']).stdout, /F1 \[ждёт решения\] Команда mcfly ideas add падает на кавычках — что видели: YAMLParseError/);
  const s = cli(dir, ['finding', 'send', 'F1']);
  assert.equal(s.status, 1); assert.match(s.stderr, /только владелец в терминале/);
  assert.equal(loadFindings(p).findings[0].status, 'new');
});
