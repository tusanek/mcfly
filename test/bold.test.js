import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { run } from '../src/runner.js';
import { rateLimitInfo } from '../src/claude.js';
import { chainDecision, quotaAllows, autoApproveAndStart, lastUsage } from '../src/chain.js';
import { approvalDeadline, isSmallChange, listChanges } from '../src/approvals.js';
import { withReplyQuestion, applyMessages } from '../src/answers.js';
import { extractMessages } from '../src/telegram.js';
import { parseConfig } from '../src/config.js';
import { appendMetric } from '../src/metrics.js';
import { paths } from '../src/state.js';
import { loadQuestions, addQuestion, saveQuestions } from '../src/questions.js';
import { cfg as baseCfg, bareProject, fakeClaudeSeq, addChange, gitRepo, git } from './helpers.js';

const cfg = parseConfig('project: demo');
const rl = (five, week) => ({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed', unifiedWindows: { five_hour: { utilization: five }, seven_day: { utilization: week } } } });
const resultEvent = (over = {}) => ({ type: 'result', subtype: 'success', is_error: false, num_turns: 1, total_cost_usd: 0.1, session_id: 's', result: 'готово', ...over });
const approved = (tasks = '- [ ] a\n- [x] b\n') => ({ tasks, meta: { schema: 'spec-driven', mcfly: { approval: 'approved' } } });

test('0.5.11: доли лимитов из rate_limit_event; прочие строки — null', () => {
  assert.deepEqual(rateLimitInfo(JSON.stringify(rl(0.28, 0.3))), { five_hour: 0.28, seven_day: 0.3 });
  assert.equal(rateLimitInfo(JSON.stringify({ type: 'assistant' })), null);
  assert.equal(rateLimitInfo('не json'), null);
});

test('0.5.11: настройки по умолчанию — цепочка до 70 % недели, мелкие изменения до 6 задач одобряются через 4 часа', () => {
  assert.equal(cfg.run.chain_max_weekly, 0.7); assert.equal(cfg.run.chain_max_five_hour, 0.9); assert.equal(cfg.run.chain_max_runs, 8);
  assert.equal(cfg.escalation.small_change_max_tasks, 6); assert.equal(cfg.escalation.small_approval_deadline_hours, 4);
  assert.throws(() => parseConfig('project: x\nrun:\n  chain_max_weekly: 1.5\n'), /chain_max_weekly/);
});

test('0.5.11: срок авто-одобрения — 4 часа для мелких, 24 для остальных; 0 задач в small_change_max_tasks — мелких нет', () => {
  const at = '2026-10-21T00:00:00.000Z';
  const small = { tasksDone: 0, tasksOpen: 5, mcfly: { requested_at: at } };
  const big = { tasksDone: 2, tasksOpen: 6, mcfly: { requested_at: at } };
  assert.equal(isSmallChange(small, cfg), true); assert.equal(isSmallChange(big, cfg), false);
  assert.equal(approvalDeadline(small, cfg).toISOString(), '2026-10-21T04:00:00.000Z');
  assert.equal(approvalDeadline(big, cfg).toISOString(), '2026-10-22T00:00:00.000Z');
  const off = parseConfig('project: x\nescalation:\n  small_change_max_tasks: 0\n');
  assert.equal(approvalDeadline(small, off).toISOString(), '2026-10-22T00:00:00.000Z');
});

test('0.5.11: лимиты для цепочки — выключена, нет данных, неделя или пять часов сверх порога', () => {
  assert.equal(quotaAllows(cfg, { five_hour: 0.2, seven_day: 0.3 }).ok, true);
  assert.match(quotaAllows(cfg, null).reason, /нет данных/);
  assert.match(quotaAllows(cfg, { five_hour: 0.2, seven_day: 0.71 }).reason, /недельный лимит 71 %/);
  assert.match(quotaAllows(cfg, { five_hour: 0.95, seven_day: 0.3 }).reason, /пятичасовой лимит 95 %/);
  assert.match(quotaAllows(parseConfig('project: x\nrun:\n  chain_max_weekly: 0\n'), { seven_day: 0 }).reason, /выключена/);
});

test('0.5.11: решение о цепочке — работа есть и прогон её продвинул; без коммитов команды или без работы — стоп', async () => {
  const dir = gitRepo(bareProject()); const p = paths(dir);
  await new Promise((r) => setTimeout(r, 1100)); // git --since с точностью до секунды: коммит init — до старта
  const started = new Date();
  const rec = { status: 'ok', usage: { five_hour: 0.2, seven_day: 0.3 } };
  assert.equal(chainDecision({ cfg, p, record: rec, projectDir: dir, started }).chain, false, 'одобренной работы нет');
  addChange(dir, 'add-x', approved());
  assert.match(chainDecision({ cfg, p, record: rec, projectDir: dir, started }).reason, /не продвинул/);
  git(dir, 'commit', '-q', '--allow-empty', '-m', 'feat(add-x): задача');
  assert.deepEqual(chainDecision({ cfg, p, record: rec, projectDir: dir, started }), { chain: true, reason: 'неделя 30 %' });
  assert.match(chainDecision({ cfg, p, record: { ...rec, status: 'quota' }, projectDir: dir, started }).reason, /не «ок»/);
  for (let i = 0; i < 8; i++) appendMetric(p, { type: 'run', chained: true, started_at: new Date().toISOString() });
  assert.match(chainDecision({ cfg, p, record: rec, projectDir: dir, started }).reason, /уже 8 прогонов цепочки/);
});

test('0.5.11: прогон с оставшейся работой и прогрессом запускает следующий после снятия лока; итог говорит об этом', async () => {
  const dir = gitRepo(bareProject()); const p = paths(dir);
  addChange(dir, 'add-x', approved());
  git(dir, 'add', '.'); git(dir, 'commit', '-q', '-m', 'feat(add-x): работа команды');
  fakeClaudeSeq(dir, [{ lines: [rl(0.1, 0.34), resultEvent()] }]);
  const started = []; const notes = [];
  // коммит команды «во время прогона»: since — время старта, поэтому коммит делаем в beforeAttempt
  const r = await run({ projectDir: dir, mode: 'day', log: () => {}, sleep: async () => {}, notify: async (t) => { notes.push(t); },
    beforeAttempt: () => { git(dir, 'commit', '-q', '--allow-empty', '-m', 'feat(add-x): задача 1'); },
    startRun: (d, o) => { started.push([d, o]); assert.equal(fs.existsSync(p.lock), false, 'лок уже снят'); } });
  assert.equal(r.chained, true); assert.deepEqual(started, [[dir, { chained: true }]]);
  const rec = JSON.parse(fs.readFileSync(path.join(p.runs, r.id, 'result.json'), 'utf8'));
  assert.deepEqual(rec.usage, { five_hour: 0.1, seven_day: 0.34 });
  assert.match(rec.chain, /следующий прогон запущен \(неделя 34 %\)/);
  assert.match(notes[0], /Дальше: следующий прогон запущен \(неделя 34 %\)/);
  assert.deepEqual(lastUsage(p), { five_hour: 0.1, seven_day: 0.34 });
});

test('0.5.11: недельный лимит выше порога — цепочки нет, причина в итоге', async () => {
  const dir = gitRepo(bareProject()); const p = paths(dir);
  addChange(dir, 'add-x', approved());
  fakeClaudeSeq(dir, [{ lines: [rl(0.1, 0.75), resultEvent()] }]);
  const started = []; const notes = [];
  const r = await run({ projectDir: dir, mode: 'day', log: () => {}, sleep: async () => {}, notify: async (t) => { notes.push(t); },
    beforeAttempt: () => { git(dir, 'commit', '-q', '--allow-empty', '-m', 'feat(add-x): задача 1'); }, startRun: (d) => started.push(d) });
  assert.equal(r.chained, false); assert.deepEqual(started, []);
  assert.match(notes[0], /Дальше: команда продолжит add-x \(1\/2\) \(цепочка остановлена: недельный лимит 75 %/);
});

test('0.5.11: задание answers авто-одобряет мелкое изменение через 4 часа и запускает прогон, если лимиты позволяют', () => {
  const dir = bareProject(); const p = paths(dir);
  const t0 = new Date('2026-10-21T00:00:00Z');
  addChange(dir, 'small', { tasks: '- [ ] a\n- [ ] b\n', meta: { schema: 'spec-driven', mcfly: { approval: 'pending', category: 'spec', requested_at: t0.toISOString() } } });
  const started = [];
  const opts = { cfg, p, isRunning: () => false, startRun: () => started.push(1) };
  assert.deepEqual(autoApproveAndStart({ ...opts, now: new Date('2026-10-21T03:59:00Z') }), [], 'срок не вышел');
  appendMetric(p, { type: 'run', started_at: t0.toISOString(), usage: { five_hour: 0.1, seven_day: 0.3 } });
  const lines = autoApproveAndStart({ ...opts, now: new Date('2026-10-21T04:01:00Z') });
  assert.match(lines[0], /Одобрено автоматически \(срок истёк\): small/); assert.match(lines[1], /▶️ Запускаю прогон \(неделя 30 %\)/);
  assert.equal(started.length, 1);
  assert.equal(listChanges(p.openspecChanges)[0].mcfly.approval, 'approved');
  assert.match(fs.readFileSync(p.answers, 'utf8'), /small одобрено автоматически/);
  assert.deepEqual(autoApproveAndStart({ ...opts, now: new Date('2026-10-21T05:00:00Z') }), [], 'повторно ничего');
});

test('0.5.11: ответ свайпом на сообщение с одним открытым вопросом закрывает этот вопрос; с двумя — остаётся заметкой', () => {
  const dir = bareProject(); const p = paths(dir);
  const data = loadQuestions(p);
  addQuestion(data, { category: 'spec', text: 'Оставить «пространство»?', defaultAnswer: 'нет' }, baseCfg);
  addQuestion(data, { category: 'spec', text: 'Лимит?', defaultAnswer: '20' }, baseCfg);
  addQuestion(data, { category: 'spec', text: 'Порог?', defaultAnswer: '150' }, baseCfg);
  saveQuestions(p, data);
  const upd = (id, text, replyText) => ({ update_id: id, message: { message_id: id, chat: { id: 42 }, text, date: 1700000000, reply_to_message: { message_id: 1, text: replyText } } });
  const { messages } = extractMessages([upd(5, 'оставляем', 'Решить:\n❓ Q1: Оставить «пространство»?\n   По умолчанию: нет'), upd(6, 'не знаю', '❓ Q2: …\n❓ Q3: …')], '42');
  assert.equal(messages[0].replyTo.includes('Q1'), true);
  const acks = applyMessages(p, messages);
  assert.match(acks[0], /✅ Q1: ответ записан/); assert.match(acks[1], /заметку/);
  const q = loadQuestions(p).questions;
  assert.equal(q[0].status, 'answered'); assert.equal(q[0].answer, 'оставляем'); assert.equal(q[1].status, 'open'); assert.equal(q[2].status, 'open');
  assert.deepEqual(withReplyQuestion({ type: 'note', text: 'x' }, 'Q9: закрытый', loadQuestions(p)), { type: 'note', text: 'x' }, 'вопрос не открыт — заметка');
  assert.deepEqual(withReplyQuestion({ type: 'approve', change: 'a', note: '' }, '❓ Q2', loadQuestions(p)).type, 'approve', 'команды не переопределяются');
});
