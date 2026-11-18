// 0.17.0 «Мелочи без одобрения»: правка существующего видимого, доделки без «Берём», «Закрыть без работы», «Вернуть».
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs'; import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { paths } from '../src/state.js';
import { parseConfig } from '../src/config.js';
import { listChanges, fastTrackBlock, followupBlock, fastKind, approveFast, holdApproval, isFastApproved, isAutoApprovable, expireApprovals, recheckFast } from '../src/approvals.js';
import { loadIdeas, saveIdeas, addIdea, transitionIdea, closeIdea, isArchived, takenInOrder } from '../src/ideas.js';
import { buildLeadPrompt } from '../src/prompt.js';
import { buildContext } from '../src/context.js';
import { parseMessage, applyMessages } from '../src/answers.js';
import { callbackText } from '../src/telegram.js';
import { summaryKeyboard, composeSummary } from '../src/summary.js';
import { finishMessage } from '../src/runner.js';
import { cfg, bareProject, addChange } from './helpers.js';

const bin = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'mcfly');
const cli = (args, dir, env = {}) => spawnSync(process.execPath, [bin, ...args], { cwd: dir, encoding: 'utf8', env: { ...process.env, MCFLY_PROJECT_DIR: '', MCFLY_RUN_ID: '', ...env } });
const on = { ...cfg, ideas: { ...cfg.ideas, fast_sizes: ['S', 'M'], fast_edits: true }, limits: { ...cfg.limits, followups_per_run: 2 } };
const QUIET = '# Proposal\n\n## Простыми словами\nЧиним внутреннее.\n\n## Как это будет выглядеть\nСнаружи ничего не меняется\n';
const EDIT = '# Proposal\n\n## Простыми словами\nПоправляем подсказку.\n\n## Как это будет выглядеть\nПравка существующего: ответ бота «не нашёл» — добавляем строку про отмену\n### Было\n```\nНичего не нашёл\n```\n### Стало\n```\nНичего не нашёл\nПередумали — /отмена\n```\n\n## Риски\nнет\n';
const NEWUI = '# Proposal\n\n## Как это будет выглядеть\n### Новая кнопка\n```\nГотово\n[Отменить]\n```\n';
const CONFIG = 'project: demo\nlimits:\n  followups_per_run: 2\nideas:\n  fast_sizes: [S, M]\n  fast_edits: true\n';
const inRun = { MCFLY_RUN_ID: '20261118-1200' };
function takeIdeas(p, sizes) {
  const data = loadIdeas(p);
  for (const [i, size] of sizes.entries()) { const it = addIdea(data, { title: `Пункт ${i + 1}`, benefit: 'польза', source: 'team', size }); transitionIdea(data, it.id, 'taken', { actor: 'session' }); }
  saveIdeas(p, data); return data;
}
const archive = (dir, name, opts) => { const from = addChange(dir, name, opts); const to = path.join(dir, 'openspec', 'changes', 'archive', `2026-11-18-${name}`); fs.mkdirSync(path.dirname(to), { recursive: true }); fs.renameSync(from, to); return to; };
const byName = (p) => Object.fromEntries(listChanges(p.openspecChanges).map((c) => [c.name, c]));

test('настройки: правка видимого и доделки по умолчанию выключены; шаблон нового проекта их включает', () => {
  const d = parseConfig('project: x\n');
  assert.equal(d.ideas.fast_edits, false); assert.equal(d.limits.followups_per_run, 0);
  assert.throws(() => parseConfig('project: x\nideas:\n  fast_edits: да\n'), /ideas\.fast_edits/);
  assert.throws(() => parseConfig('project: x\nlimits:\n  followups_per_run: -1\n'), /limits\.followups_per_run/);
  const tpl = parseConfig(fs.readFileSync(path.join(path.dirname(bin), '..', 'templates', 'config.yaml'), 'utf8').replace(/^project:.*$/m, 'project: x'));
  assert.equal(tpl.ideas.fast_edits, true); assert.equal(tpl.limits.followups_per_run, 3);
});
test('правка существующего видимого: быстрым путём только с пометкой, для пункта S, при ideas.fast_edits и малом числе задач', () => {
  const dir = bareProject(); const p = paths(dir);
  addChange(dir, 'edit', { proposal: EDIT }); addChange(dir, 'newui', { proposal: NEWUI });
  addChange(dir, 'long', { proposal: EDIT, tasks: '- [ ] 1\n- [ ] 2\n- [ ] 3\n- [ ] 4\n- [ ] 5\n- [ ] 6\n- [ ] 7\n' });
  const c = byName(p); const S = [{ id: 'I1', size: 'S' }]; const M = [{ id: 'I2', size: 'M' }];
  assert.equal(fastTrackBlock(c.edit, S, on), ''); assert.equal(fastKind(c.edit), 'edit');
  assert.match(fastTrackBlock(c.edit, M, on), /только для небольших пунктов, а I2 размера M/);
  assert.match(fastTrackBlock(c.edit, S, { ...on, ideas: { ...on.ideas, fast_edits: false } }), /видит или нажимает/);
  assert.match(fastTrackBlock(c.newui, S, on), /видит или нажимает/, 'образцы без пометки — новое видимое');
  assert.match(fastTrackBlock(c.long, S, on), /правка видимого на 7 задач/);
  // пометка вне раздела образцов не считается
  addChange(dir, 'trick', { proposal: `Правка существующего: всё\n${NEWUI}` });
  assert.match(fastTrackBlock(byName(p).trick, S, on), /видит или нажимает/);
});
test('доделка: условия — предел за прогон, родитель в архиве, мало задач, категория, видимое', () => {
  const dir = bareProject(); const p = paths(dir);
  addChange(dir, 'tail', { proposal: QUIET }); addChange(dir, 'edit', { proposal: EDIT }); addChange(dir, 'newui', { proposal: NEWUI });
  const c = byName(p); const ok = { parentArchived: true, used: 0 };
  assert.equal(followupBlock(c.tail, on, ok), ''); assert.equal(followupBlock(c.edit, on, ok), '');
  assert.match(followupBlock(c.tail, cfg, ok), /выключены/);
  assert.match(followupBlock(c.tail, on, { ...ok, parentArchived: false }), /нет в архиве/);
  assert.match(followupBlock(c.tail, on, { ...ok, used: 2 }), /уже 2 доделок/);
  assert.match(followupBlock(c.tail, on, { ...ok, category: 'prod' }), /категория prod/);
  assert.match(followupBlock(c.newui, on, ok), /видит или нажимает/);
  assert.match(followupBlock(c.tail, { ...on, escalation: { ...on.escalation, small_change_max_tasks: 1 } }, ok), /задач 2 — для доделки много/);
});
test('approval request --followup: одобряется сразу до предела, дальше отказ; свежая идея без завершённого родителя — отказ', () => {
  const dir = bareProject(); const p = paths(dir); fs.writeFileSync(p.config, CONFIG);
  archive(dir, 'parent');
  for (const n of ['tail-a', 'tail-b', 'tail-c']) addChange(dir, n, { proposal: QUIET });
  addChange(dir, 'fresh', { proposal: QUIET });
  assert.equal(isArchived(p.openspecChanges, 'parent'), true);
  const a = cli(['approval', 'request', 'tail-a', '--followup', 'parent'], dir, inRun);
  assert.equal(a.status, 0, a.stderr); assert.match(a.stdout, /Одобрено сразу: tail-a \(доделка к parent\)/);
  assert.equal(cli(['approval', 'request', 'tail-b', '--followup', 'parent'], dir, inRun).status, 0);
  const third = cli(['approval', 'request', 'tail-c', '--followup', 'parent'], dir, inRun);
  assert.equal(third.status, 1); assert.match(third.stderr, /не принята: за этот прогон уже 2 доделок/); assert.match(third.stderr, /mcfly ideas add/);
  const fresh = cli(['approval', 'request', 'fresh', '--followup', 'no-such'], dir, { MCFLY_RUN_ID: 'другой' });
  assert.equal(fresh.status, 1); assert.match(fresh.stderr, /нет в архиве/);
  assert.match(cli(['approval', 'request', 'fresh', '--followup', 'parent', '--idea', 'I1'], dir).stderr, /вместе не указывают/);
  const c = byName(p);
  assert.equal(c['tail-a'].mcfly.by, 'followup'); assert.equal(c['tail-a'].mcfly.followup_of, 'parent'); assert.equal(isFastApproved(c['tail-a']), true);
  assert.ok(c['tail-a'].mcfly.fast_hash); assert.equal(c['tail-c'].mcfly.approval, undefined, 'отказ ничего не запрашивает');
  assert.match(fs.readFileSync(p.answers, 'utf8'), /tail-a одобрено сразу как доделка к parent/);
  // изменённый после одобрения план доделки возвращается владельцу и молчанием не одобряется
  fs.appendFileSync(path.join(c['tail-a'].dir, 'tasks.md'), '- [ ] новая кнопка\n');
  assert.deepEqual(recheckFast(listChanges(p.openspecChanges)).map((x) => x.name), ['tail-a']);
  const held = byName(p)['tail-a']; assert.equal(isAutoApprovable(held, on), false);
  assert.deepEqual(expireApprovals([held], on, new Date(Date.now() + 100 * 3600_000)), []);
});
test('approval request --idea: правка существующего по пункту S одобряется сразу, новое видимое ждёт кнопки', () => {
  const dir = bareProject(); const p = paths(dir); fs.writeFileSync(p.config, CONFIG); takeIdeas(p, ['S', 'S']);
  addChange(dir, 'edit', { proposal: EDIT }); addChange(dir, 'newui', { proposal: NEWUI });
  assert.match(cli(['approval', 'request', 'edit', '--idea', 'I1'], dir, inRun).stdout, /Одобрено сразу: edit/);
  assert.match(cli(['approval', 'request', 'newui', '--idea', 'I2'], dir, inRun).stdout, /Ждёт кнопки владельца: изменение меняет то, что человек видит/);
  assert.equal(byName(p).edit.mcfly.fast_kind, 'edit'); assert.match(byName(p).edit.mcfly.note, /правка существующего/);
});
test('промпт: правка существующего и шаг 5b — только при включённых настройках', () => {
  const dir = bareProject(); const p = paths(dir); const base = { p, runId: 'r', mode: 'day', deadline: new Date(), context: '' };
  const off = buildLeadPrompt({ ...base, cfg });
  assert.doesNotMatch(off, /5b\. Доделки/); assert.doesNotMatch(off, /Правка существующего/); assert.doesNotMatch(off, /\{\{/);
  const full = buildLeadPrompt({ ...base, cfg: on });
  assert.match(full, /Исключение — мелкая правка существующего \(только пункты размера S, не больше 6 задач\)/);
  assert.match(full, /5b\. Доделки без одобрения — не больше 2 за прогон/); assert.match(full, /--followup <имя завершённого изменения>/);
  assert.match(full, /мелкая правка уже существующего текста/); assert.doesNotMatch(full, /\{\{/);
  assert.ok(full.indexOf('5b. Доделки') < full.indexOf('6. Завершение'));
  const noEdits = buildLeadPrompt({ ...base, cfg: { ...on, ideas: { ...on.ideas, fast_edits: false } } });
  assert.match(noEdits, /5b\. Доделки/); assert.doesNotMatch(noEdits, /Правка существующего/);
});

test('возвращённый план: свои кнопки и строка в «Решить»; «закрыть» закрывает план и пункт, команда убирает папку', () => {
  assert.deepEqual(parseMessage('закрыть I7'), { type: 'close', target: 'I7', text: 'закрыть I7' });
  assert.equal(callbackText('cl:some-plan'), 'закрыть some-plan'); assert.equal(callbackText('rv:some-plan'), 'вернуть some-plan');
  const dir = bareProject(); const p = paths(dir);
  const data = takeIdeas(p, ['S', 'S']); transitionIdea(data, 'I1', 'planned', { actor: 'team', change: 'not-needed' }); saveIdeas(p, data);
  addChange(dir, 'not-needed', { proposal: QUIET, meta: { schema: 'spec-driven', mcfly: { approval: 'pending', category: 'spec', idea: 'I1', requested_at: new Date().toISOString() } } });
  approveFast(byName(p)['not-needed']); holdApproval(byName(p)['not-needed'], 'работа не нужна: уже совпадает');
  assert.deepEqual(summaryKeyboard(p, cfg)[0], [{ text: '✅ Всё равно делать I1', callback_data: 'ap:not-needed' }, { text: '🗑 Закрыть без работы', callback_data: 'cl:not-needed' }]);
  const fin = finishMessage(cfg, { id: 'r1', status: 'ok', mode: 'day', started_at: new Date().toISOString(), ended_at: new Date().toISOString() }, p).text;
  assert.match(fin, /↩ Команда вернула вам план I1 «Пункт 1»: работа не нужна: уже совпадает/); assert.doesNotMatch(fin, /📋 Одобрить/);
  assert.match(composeSummary(p, cfg, { now: new Date() }), /Команда вернула вам план <b>I1 «Пункт 1»<\/b>: работа не нужна: уже совпадает/);
  assert.match(buildContext(p, cfg), /not-needed \(запрошено [^)]*\) — возвращено владельцу командой, ждёт его решения: не реализовывать/);
  const acks = applyMessages(p, [{ text: 'закрыть not-needed' }, { text: 'закрыть I2' }, { text: 'закрыть вопрос' }, { text: 'закрыть I9' }], { cfg });
  assert.match(acks[0], /🗑 not-needed, I1: закрыто без работы — команда уберёт план/); assert.match(acks[1], /🗑 I2: закрыто без работы$/);
  assert.match(acks[2], /Записал как заметку/, 'обычная фраза остаётся заметкой'); assert.match(acks[3], /Записал как заметку/);
  const c = byName(p)['not-needed']; assert.equal(c.mcfly.approval, 'rejected'); assert.equal(c.mcfly.closed, true);
  assert.deepEqual(loadIdeas(p).ideas.map((x) => x.status), ['rejected', 'rejected']);
  assert.match(buildContext(p, cfg), /Закрыты владельцем без работы — в шаге 0 удали папку изменения[^\n]*: not-needed/);
  assert.deepEqual(summaryKeyboard(p, cfg), []);
  assert.match(closeIdea(loadIdeas(p), 'I1').error, /закрыть можно взятый/);
});
test('«Вернуть»: в итоге прогона — блок и кнопка; нажатие создаёт взятый пункт первым в очереди, его план идёт быстрым путём', () => {
  const dir = bareProject(); const p = paths(dir); const started = new Date(Date.now() - 60_000);
  const adir = addChange(dir, 'hint-fix', { proposal: EDIT, tasks: '- [x] готово\n' });
  approveFast(byName(p)['hint-fix'], 'доделка', new Date(), { by: 'followup', followupOf: 'parent' });
  const to = path.join(dir, 'openspec', 'changes', 'archive', '2026-11-18-hint-fix'); fs.mkdirSync(path.dirname(to), { recursive: true }); fs.renameSync(adir, to);
  const m = finishMessage(on, { id: 'r1', status: 'ok', mode: 'day', started_at: started.toISOString(), ended_at: new Date().toISOString() }, p);
  assert.match(m.text, /⚡ Без вашего одобрения \(отменить — кнопка «↩ Вернуть» ниже\):\n• [^\n]*доделка, правка существующего — сделано/);
  assert.deepEqual(m.keyboard.at(-1).map((b) => b.callback_data), ['rv:hint-fix']);
  assert.deepEqual(parseMessage('вернуть hint-fix'), { type: 'revert', change: 'hint-fix', text: 'вернуть hint-fix' });
  const acks = applyMessages(p, [{ text: 'вернуть hint-fix' }, { text: 'вернуть hint-fix' }, { text: 'вернуть долг' }], { cfg: on });
  assert.match(acks[0], /↩ Принял: ближайший прогон вернёт hint-fix как было \(I1, первым в очереди\)/);
  assert.match(acks[1], /возврат уже в очереди \(I1\)/); assert.match(acks[2], /Записал как заметку/);
  const idea = takenInOrder(loadIdeas(p))[0]; assert.equal(idea.revert_of, 'hint-fix'); assert.equal(idea.size, 'S'); assert.ok(idea.first_at);
  assert.match(buildContext(p, on), /возврат по кнопке владельца: I1 — откат слияния изменения hint-fix/);
  // план отката меняет видимое обратно — владелец уже решил: быстрым путём, без второго нажатия
  addChange(dir, 'revert-hint-fix', { proposal: NEWUI });
  assert.equal(fastTrackBlock(byName(p)['revert-hint-fix'], [idea], on), '');
  assert.match(fastTrackBlock(byName(p)['revert-hint-fix'], [{ id: 'I5', size: 'S' }], on), /видит или нажимает/);
});
