// 0.16.0 «Скорость очереди»: число изменений за прогон, быстрый путь (план и работа одним прогоном), «⬆ Вперёд».
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs'; import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { paths } from '../src/state.js';
import { parseConfig, maxChanges, MAX_RUN_CHANGES } from '../src/config.js';
import { approveFast, recheckFast, fastPlanIntact, planHash, listChanges, moveFirst, firstPriority, fastTrackBlock, holdApproval, isFastApproved, setApproval, priorityOf } from '../src/approvals.js';
import { loadIdeas, saveIdeas, addIdea, transitionIdea, markFirst, takenInOrder } from '../src/ideas.js';
import { buildLeadPrompt } from '../src/prompt.js';
import { buildContext } from '../src/context.js';
import { parseMessage, applyMessages } from '../src/answers.js';
import { callbackText } from '../src/telegram.js';
import { pullAnswers, runChoiceRow } from '../src/pull.js';
import { queueView, queueKeyboard, viewOf } from '../src/overview.js';
import { chainDecision } from '../src/chain.js';
import { finishMessage } from '../src/runner.js';
import { cfg, bareProject, addChange, gitRepo, git } from './helpers.js';

const bin = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'mcfly');
const cli = (args, dir, env = {}) => spawnSync(process.execPath, [bin, ...args], { cwd: dir, encoding: 'utf8', env: { ...process.env, MCFLY_PROJECT_DIR: '', MCFLY_RUN_ID: '', ...env } });
const fastCfg = { ...cfg, ideas: { ...cfg.ideas, fast_sizes: ['S', 'M'] } };
const QUIET = '# Proposal\n\n## Простыми словами\nЧиним внутреннее.\n\n## Как это будет выглядеть\nСнаружи ничего не меняется\n';
const VISIBLE = '# Proposal\n\n## Как это будет выглядеть\n### Ответ бота\n```\nГотово\n[Отменить]\n```\n';
const pending = (over = {}) => ({ schema: 'spec-driven', mcfly: { approval: 'pending', category: 'spec', requested_at: new Date().toISOString(), ...over } });
const approved = (over = {}) => ({ schema: 'spec-driven', mcfly: { approval: 'approved', category: 'spec', ...over } });
/** Взятые пункты I1… с заданными размерами. */
function takeIdeas(p, sizes) {
  const data = loadIdeas(p);
  for (const [i, size] of sizes.entries()) { const it = addIdea(data, { title: `Пункт ${i + 1}`, benefit: 'польза', source: 'team', size }); transitionIdea(data, it.id, 'taken', { actor: 'session' }); }
  saveIdeas(p, data); return data;
}

test('настройки: ночной предел, варианты числа изменений и размеры быстрого пути — по умолчанию выключены, проверяются', () => {
  const d = parseConfig('project: x\n');
  assert.deepEqual(d.limits, { max_changes_per_run: 2, max_changes_night: 0, max_tasks_per_change: 10, run_choices: [] });
  assert.deepEqual(d.ideas.fast_sizes, []);
  assert.throws(() => parseConfig('project: x\nlimits:\n  max_changes_per_run: 0\n'), /limits\.max_changes_per_run/);
  assert.throws(() => parseConfig('project: x\nlimits:\n  max_changes_night: -1\n'), /limits\.max_changes_night/);
  assert.throws(() => parseConfig('project: x\nlimits:\n  run_choices: [1, 99]\n'), /limits\.run_choices/);
  assert.throws(() => parseConfig('project: x\nideas:\n  fast_sizes: [XL]\n'), /ideas\.fast_sizes/);
  assert.deepEqual(parseConfig('project: x\nlimits:\n  run_choices: [1, 3, 5]\nideas:\n  fast_sizes: [S, M]\n').limits.run_choices, [1, 3, 5]);
});
test('maxChanges: число из запуска → ночной предел → дневной; шаблон нового проекта проходит проверку', () => {
  const c = parseConfig('project: x\nlimits:\n  max_changes_per_run: 2\n  max_changes_night: 5\n');
  assert.equal(maxChanges(c, 'day'), 2); assert.equal(maxChanges(c, 'night'), 5); assert.equal(maxChanges(c, 'night', 3), 3);
  assert.equal(maxChanges(c, 'day', 999), MAX_RUN_CHANGES);
  assert.equal(maxChanges(parseConfig('project: x\n'), 'night'), 2, '0 — как дневной');
  const tpl = parseConfig(fs.readFileSync(path.join(path.dirname(bin), '..', 'templates', 'config.yaml'), 'utf8').replace(/^project:.*$/m, 'project: x'));
  assert.equal(tpl.limits.max_changes_night, 5); assert.deepEqual(tpl.limits.run_choices, [1, 3, 5]); assert.deepEqual(tpl.ideas.fast_sizes, ['S', 'M']);
});
test('промпт и контекст: предел прогона подставляется в лимиты и шаг 2; быстрый путь описан только при ideas.fast_sizes', () => {
  const dir = bareProject(); const p = paths(dir);
  const base = { p, runId: 'r', mode: 'day', deadline: new Date(), context: '' };
  const slow = buildLeadPrompt({ ...base, cfg, limit: 5 });
  assert.match(slow, /Лимиты: не больше 5 изменений за прогон/); assert.match(slow, /не больше 5 за прогон/);
  assert.match(slow, /молчанием не одобряется — ждёт кнопки владельца/); assert.doesNotMatch(slow, /Быстрый путь/);
  const fast = buildLeadPrompt({ ...base, cfg: fastCfg, limit: 3 });
  assert.match(fast, /Быстрый путь \(размеры пунктов S, M\)/); assert.match(fast, /«Одобрено сразу»/); assert.match(fast, /лимит 3 изменений за прогон/);
  assert.match(fast, /одобрил сразу \(быстрый путь, см\. b\), реализуй в этом же прогоне/);
  assert.doesNotMatch(fast, /\{\{/);
  assert.match(buildContext(p, cfg, { limit: 5 }), /не больше 5 изменений за прогон/);
});
test('команда run: --changes — целое от 1; dry-run показывает предел в промпте', () => {
  const dir = bareProject();
  assert.match(cli(['run', '--changes', '0'], dir).stderr, /--changes: целое число от 1/);
  const r = cli(['run', '--dry-run', '--changes', '4'], dir); assert.equal(r.status, 0, r.stderr);
  const prompt = fs.readFileSync(path.join(dir, fs.readdirSync(path.join(dir, 'mcfly', 'logs')).map((f) => path.join('mcfly', 'logs', f)).find((f) => f.endsWith('.prompt.md'))), 'utf8');
  assert.match(prompt, /не больше 4 изменений за прогон/);
});

test('бот: «запусти 3» и кнопки rn:N; без числа при limits.run_choices — вопрос с кнопками, выбор запоминается', async () => {
  assert.deepEqual(parseMessage('запусти 3'), { type: 'run', text: 'запусти 3', changes: 3 });
  assert.equal(parseMessage('▶️ Запусти').changes, undefined);
  assert.equal(callbackText('rn:3'), 'запусти 3'); assert.equal(callbackText('rn:5!'), 'запусти всё равно 5'); assert.equal(callbackText('rn:day'), 'запусти');
  process.env.MCFLY_TEST_TG = 'T';
  const tgCfg = { ...cfg, telegram: { chat_id: '42', token_env: 'MCFLY_TEST_TG' }, limits: { ...cfg.limits, run_choices: [1, 3, 5] } };
  const msg = (id, text) => ({ update_id: id, message: { message_id: id, chat: { id: 42 }, text, date: 1700000000 } });
  const fakeTg = (updates) => { const tg = { sent: [], async getUpdates(o) { return updates.filter((u) => u.update_id >= o); }, async sendMessage(_c, text, o = {}) { tg.sent.push({ text, keyboard: o.keyboard || [] }); return []; }, async answerCallbackQuery() { return true; } }; return tg; };
  const dir = bareProject(); const p = paths(dir); const started = [];
  const startRun = (d, o) => started.push(o || null);
  const ask = fakeTg([msg(1, 'запусти')]);
  await pullAnswers({ projectDir: dir, cfg: tgCfg, p, telegram: ask, log: () => {}, startRun });
  assert.deepEqual(started, []); assert.match(ask.sent[0].text, /Сколько изменений взять/);
  assert.deepEqual(ask.sent[0].keyboard, [[{ text: '▶️ 1', callback_data: 'rn:1' }, { text: '▶️ 3', callback_data: 'rn:3' }, { text: '▶️ 5', callback_data: 'rn:5' }]]);
  const go = fakeTg([msg(2, 'запусти 3')]);
  await pullAnswers({ projectDir: dir, cfg: tgCfg, p, telegram: go, log: () => {}, startRun, session: {} });
  assert.deepEqual(started, [{ changes: 3 }]); assert.match(go.sent[0].text, /изменений не больше 3/);
  assert.deepEqual(runChoiceRow(tgCfg, JSON.parse(fs.readFileSync(p.state, 'utf8')).run_changes).map((b) => b.text), ['▶️ 1', '▶️ 3 •', '▶️ 5']);
  // без вариантов в настройках — как раньше: запуск сразу, без числа
  const plain = fakeTg([msg(3, 'запусти')]); const old = [];
  await pullAnswers({ projectDir: dir, cfg: { ...tgCfg, limits: cfg.limits }, p, telegram: plain, log: () => {}, startRun: (d, o) => old.push(o), session: {} });
  assert.deepEqual(old, [undefined]);
});

test('быстрый путь: причины отказа и согласие — по признакам плана', () => {
  const dir = bareProject(); const p = paths(dir);
  addChange(dir, 'quiet', { proposal: QUIET }); addChange(dir, 'seen', { proposal: VISIBLE }); addChange(dir, 'bare');
  const by = Object.fromEntries(listChanges(p.openspecChanges).map((c) => [c.name, c]));
  const S = [{ id: 'I1', size: 'S' }]; const L = [{ id: 'I2', size: 'L' }];
  assert.equal(fastTrackBlock(by.quiet, S, fastCfg), '');
  assert.equal(fastTrackBlock(by.quiet, [{ id: 'I1', size: 'S' }, { id: 'I3', size: 'M' }], fastCfg), '');
  assert.match(fastTrackBlock(by.quiet, S, cfg), /выключен/);
  assert.match(fastTrackBlock(by.quiet, [], fastCfg), /не по взятому пункту/);
  assert.match(fastTrackBlock(by.quiet, L, fastCfg), /I2 размера L/);
  assert.match(fastTrackBlock(by.quiet, S, fastCfg, 'prod'), /категория prod/);
  assert.match(fastTrackBlock(by.seen, S, fastCfg), /видит или нажимает/);
  assert.match(fastTrackBlock(by.bare, S, fastCfg), /нет раздела/);
  assert.match(fastTrackBlock(by.quiet, S, { ...fastCfg, limits: { ...cfg.limits, max_tasks_per_change: 1 } }), /задач 2/);
  holdApproval(by.quiet); assert.match(fastTrackBlock(by.quiet, S, fastCfg), /возвращали/);
});
test('approval request --idea: небольшой пункт без видимого одобряется сразу; видимое и крупное ждут кнопки; hold возвращает', () => {
  const dir = bareProject(); const p = paths(dir);
  fs.writeFileSync(p.config, 'project: demo\nideas:\n  fast_sizes: [S, M]\n');
  takeIdeas(p, ['S', 'S', 'L']);
  addChange(dir, 'quiet', { proposal: QUIET }); addChange(dir, 'seen', { proposal: VISIBLE }); addChange(dir, 'big', { proposal: QUIET });
  const inRun = { MCFLY_RUN_ID: '20261118-0000' };
  const a = cli(['approval', 'request', 'quiet', '--idea', 'I1'], dir, inRun);
  assert.equal(a.status, 0, a.stderr); assert.match(a.stdout, /Одобрено сразу: quiet/);
  assert.match(cli(['approval', 'request', 'seen', '--idea', 'I2'], dir, inRun).stdout, /Ждёт кнопки владельца: изменение меняет то, что человек видит/);
  assert.match(cli(['approval', 'request', 'big', '--idea', 'I3'], dir, inRun).stdout, /Ждёт кнопки владельца: пункт I3 размера L/);
  const by = () => Object.fromEntries(listChanges(p.openspecChanges).map((c) => [c.name, c]));
  assert.equal(isFastApproved(by().quiet), true); assert.equal(by().seen.mcfly.approval, 'pending'); assert.equal(by().big.mcfly.approval, 'pending');
  assert.match(fs.readFileSync(p.answers, 'utf8'), /quiet одобрено сразу после «Берём»/);
  assert.equal(loadIdeas(p).ideas[0].status, 'planned');
  // страховка: команда в прогоне возвращает быстрый план на одобрение, но одобрить сама по-прежнему не может
  assert.equal(cli(['approval', 'hold', 'seen'], dir, inRun).status, 1);
  const h = cli(['approval', 'hold', 'quiet', '--note', 'меняет текст бота'], dir, inRun); assert.equal(h.status, 0, h.stderr);
  assert.equal(by().quiet.mcfly.approval, 'pending'); assert.equal(by().quiet.mcfly.held, true);
  assert.equal(cli(['approval', 'set', 'quiet', 'approved'], dir, inRun).status, 1);
});
test('без ideas.fast_sizes план по пункту ждёт кнопки, как раньше', () => {
  const dir = bareProject(); const p = paths(dir); takeIdeas(p, ['S']); addChange(dir, 'quiet', { proposal: QUIET });
  const a = cli(['approval', 'request', 'quiet', '--idea', 'I1'], dir);
  assert.match(a.stdout, /^Одобрение запрошено: quiet\. Человек увидит его в утренней сводке\.\n$/);
  assert.equal(listChanges(p.openspecChanges)[0].mcfly.approval, 'pending');
});
test('итог прогона называет одобренное быстрым путём; цепочка при быстром пути считает взятые пункты работой', () => {
  const dir = gitRepo(bareProject()); const p = paths(dir); const started = new Date(Date.now() - 60_000);
  addChange(dir, 'quiet', { proposal: QUIET }); approveFast(listChanges(p.openspecChanges)[0]);
  const text = finishMessage(cfg, { id: 'r1', status: 'ok', mode: 'day', started_at: started.toISOString(), ended_at: new Date().toISOString() }, p).text;
  assert.match(text, /⚡ Без второго одобрения[^\n]*в работе/);
  const dir2 = gitRepo(bareProject()); const p2 = paths(dir2); takeIdeas(p2, ['S']);
  git(dir2, 'commit', '-q', '--allow-empty', '-m', 'feat: работа');
  const rec = { status: 'ok', usage: { five_hour: 0.1, seven_day: 0.3 } }; const since = new Date(Date.now() - 60_000);
  assert.equal(chainDecision({ cfg, p: p2, record: rec, projectDir: dir2, started: since }).chain, false, 'без быстрого пути взятый пункт цепочку не запускает');
  assert.equal(chainDecision({ cfg: fastCfg, p: p2, record: rec, projectDir: dir2, started: since }).chain, true);
});

test('«⬆ Вперёд»: изменение становится первым в очереди; уже первое не трогается', () => {
  const dir = bareProject(); const p = paths(dir);
  addChange(dir, 'a', { meta: approved({ priority: 10 }) }); addChange(dir, 'b', { meta: pending({ priority: 20 }) }); addChange(dir, 'c', { meta: approved({ priority: 30 }) }); addChange(dir, 'z');
  let ch = listChanges(p.openspecChanges);
  assert.equal(firstPriority(ch), 9);
  assert.equal(moveFirst(ch, 'c').error, null);
  assert.deepEqual(listChanges(p.openspecChanges).map((c) => c.name), ['c', 'a', 'b', 'z']);
  ch = listChanges(p.openspecChanges); moveFirst(ch, 'c'); assert.equal(priorityOf(listChanges(p.openspecChanges)[0]), 9, 'повторное нажатие приоритет не уменьшает');
  assert.match(moveFirst(ch, 'z').error, /ждёт одобрения или одобрено/); assert.equal(moveFirst(ch, 'нет').change, null);
});
test('«⬆ Вперёд»: взятый пункт идёт раньше «неудобно» и остальных; его план встаёт первым сам', () => {
  const dir = bareProject(); const p = paths(dir);
  const data = takeIdeas(p, ['S', 'M', 'S']); data.ideas[1].ux = true;
  assert.deepEqual(takenInOrder(data).map((x) => x.id), ['I2', 'I1', 'I3']);
  assert.equal(markFirst(data, 'I3', new Date(2026, 10, 18, 10)).error, null);
  assert.deepEqual(takenInOrder(data).map((x) => x.id), ['I3', 'I2', 'I1']);
  transitionIdea(data, 'I1', 'planned', { actor: 'team', change: 'x' }); assert.match(markFirst(data, 'I1').error, /взятый пункт/);
  saveIdeas(p, data);
  assert.match(buildContext(p, fastCfg), /спланируй по порядку: I3 \[S\] «Пункт 3», I2 \[M\] «Пункт 2» \(I3 — владелец поднял «вперёд», планируй и делай их раньше всех; I2 — жалобы «неудобно»/);
  addChange(dir, 'old', { meta: approved({ priority: 50 }) }); addChange(dir, 'new-plan', { proposal: VISIBLE });
  assert.equal(cli(['approval', 'request', 'new-plan', '--idea', 'I3'], dir).status, 0);
  assert.equal(listChanges(p.openspecChanges)[0].name, 'new-plan');
  // порядок очереди — решение владельца: в прогоне команды запрещено
  assert.match(cli(['ideas', 'first', 'I2'], dir, { MCFLY_RUN_ID: 'r' }).stderr, /задаёт владелец/);
  assert.match(cli(['approval', 'first', 'old'], dir, { MCFLY_RUN_ID: 'r' }).stderr, /задаёт владелец/);
  assert.equal(cli(['ideas', 'first', 'I2'], dir).status, 0);
});
test('бот: «вперёд I7», «вперёд имя», кнопка up:, экран «очередь» с кнопками', () => {
  assert.deepEqual(parseMessage('вперёд i7'), { type: 'first', target: 'i7' }); assert.deepEqual(parseMessage('Вперед add-x'), { type: 'first', target: 'add-x' });
  assert.equal(callbackText('up:I7'), 'вперёд I7'); assert.equal(callbackText('qu:1'), 'очередь'); assert.equal(viewOf('очередь'), 'queue');
  const dir = bareProject(); const p = paths(dir);
  const data = takeIdeas(p, ['S', 'M', 'S']); transitionIdea(data, 'I3', 'planned', { actor: 'team', change: 'late' }); saveIdeas(p, data);
  addChange(dir, 'early', { meta: approved({ priority: 10 }) }); addChange(dir, 'late', { meta: pending({ priority: 20, idea: 'I3' }) });
  assert.deepEqual(queueKeyboard(p, cfg).map((r) => r[0].callback_data), ['up:late', 'up:I2']);
  const view = queueView(p, cfg).join('\n');
  assert.match(view, /1\. 🔧[^\n]*\n2\. ⏳ I3 «Пункт 3» — ждёт вашего одобрения/); assert.match(view, /3\. 💡 I1 · небольшая работа — Пункт 1\n4\. 💡 I2/);
  const acks = applyMessages(p, [{ text: 'вперёд I2' }, { text: 'вперёд I3' }, { text: 'вперёд I9' }, { text: 'вперёд nope' }], { cfg });
  assert.match(acks[0], /⬆ I2 — первым в очереди/); assert.match(acks[1], /⬆ I3 — первым в очереди \(план ещё ждёт вашего одобрения\)/);
  assert.match(acks[2], /I9: такого предложения нет/); assert.match(acks[3], /nope: такого изменения нет/);
  assert.equal(listChanges(p.openspecChanges)[0].name, 'late'); assert.equal(takenInOrder(loadIdeas(p))[0].id, 'I2');
  assert.match(fs.readFileSync(p.answers, 'utf8'), /— вперёд I2\n/);
  assert.deepEqual(queueKeyboard(p, cfg).map((r) => r[0].callback_data), ['up:early', 'up:I1']);
  assert.match(queueView(bareProject() && paths(bareProject()), cfg).join('\n'), /Очередь пуста/);
});

test('0.16.1: быстрое одобрение привязано к тексту плана — изменился, возвращается владельцу; отметки задач не в счёт', () => {
  const dir = bareProject(); const p = paths(dir);
  const cdir = addChange(dir, 'quiet', { proposal: QUIET }); addChange(dir, 'other', { meta: approved() });
  const get = () => listChanges(p.openspecChanges).find((c) => c.name === 'quiet');
  approveFast(get(), 'быстрый путь');
  assert.equal(get().mcfly.fast_hash, planHash(get())); assert.equal(fastPlanIntact(get()), true);
  fs.writeFileSync(path.join(cdir, 'tasks.md'), '- [x] первая\n- [x] нулевая\n');
  assert.deepEqual(recheckFast(listChanges(p.openspecChanges)), [], 'задачи отмечены сделанными — план тот же');
  fs.appendFileSync(path.join(cdir, 'proposal.md'), '### Новая кнопка\n```\nПривет\n[Ок]\n```\n');
  assert.deepEqual(recheckFast(listChanges(p.openspecChanges)).map((c) => c.name), ['quiet']);
  assert.equal(get().mcfly.approval, 'pending'); assert.equal(get().mcfly.held, true);
  assert.equal(listChanges(p.openspecChanges).find((c) => c.name === 'other').mcfly.approval, 'approved', 'обычные одобрения не трогаются');
  // быстрое одобрение без отпечатка (запись руками) — тоже на одобрение владельца
  setApproval(get(), 'approved', 'fast'); assert.equal(recheckFast(listChanges(p.openspecChanges)).length, 1);
});
test('0.16.1: approval request сохраняет отпечаток; добавленная после одобрения задача возвращает план в начале прогона', async () => {
  const dir = gitRepo(bareProject()); const p = paths(dir);
  fs.writeFileSync(p.config, 'project: demo\nideas:\n  fast_sizes: [S]\n');
  takeIdeas(p, ['S']); const cdir = addChange(dir, 'quiet', { proposal: QUIET });
  assert.match(cli(['approval', 'request', 'quiet', '--idea', 'I1'], dir, { MCFLY_RUN_ID: 'r' }).stdout, /Одобрено сразу/);
  assert.ok(listChanges(p.openspecChanges)[0].mcfly.fast_hash);
  fs.appendFileSync(path.join(cdir, 'tasks.md'), '- [ ] новая кнопка в боте\n');
  const { run } = await import('../src/runner.js'); const { fakeClaude } = await import('./helpers.js');
  fakeClaude(dir, { lines: [{ type: 'result', subtype: 'success', is_error: false, num_turns: 1, total_cost_usd: 0, session_id: 's', result: 'готово' }] });
  const notes = [];
  await run({ projectDir: dir, mode: 'day', log: () => {}, sleep: async () => {}, notify: async (t) => { notes.push(t); }, startRun: () => {} });
  assert.equal(listChanges(p.openspecChanges)[0].mcfly.approval, 'pending');
  assert.match(fs.readFileSync(p.answers, 'utf8'), /quiet возвращено на одобрение владельца\nплан изменился после быстрого одобрения/);
  assert.match(fs.readFileSync(path.join(p.runs, fs.readdirSync(p.runs)[0], 'prompt.md'), 'utf8'), /Ожидают одобрения \(1\)/);
});

test('0.16.2: approval check — отказ для неодобренного и для изменённого быстрого плана (с возвратом владельцу)', () => {
  const dir = bareProject(); const p = paths(dir);
  const cdir = addChange(dir, 'quiet', { proposal: QUIET }); addChange(dir, 'wait', { meta: pending() });
  approveFast(listChanges(p.openspecChanges).find((c) => c.name === 'quiet'));
  const inRun = { MCFLY_RUN_ID: 'r' };
  assert.equal(cli(['approval', 'check', 'quiet'], dir, inRun).status, 0);
  assert.match(cli(['approval', 'check', 'wait'], dir, inRun).stderr, /не одобрено/);
  fs.appendFileSync(path.join(cdir, 'tasks.md'), '- [ ] ещё одна\n');
  const r = cli(['approval', 'check', 'quiet'], dir, inRun);
  assert.equal(r.status, 1); assert.match(r.stderr, /план изменился после быстрого одобрения/);
  assert.equal(listChanges(p.openspecChanges).find((c) => c.name === 'quiet').mcfly.approval, 'pending');
});
