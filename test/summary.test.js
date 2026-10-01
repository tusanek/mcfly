import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs'; import path from 'node:path';
import { composeSummary, summaryKeyboard, htmlToPlain, sendSummary } from '../src/summary.js';
import { paths, loadState } from '../src/state.js';
import { appendMetric } from '../src/metrics.js';
import { loadQuestions, addQuestion, saveQuestions } from '../src/questions.js';
import { listChanges, requestApproval, setApproval } from '../src/approvals.js';
import { cfg, bareProject, addChange, git, gitRepo, changeBranch } from './helpers.js';

const NOW = new Date(2026, 9, 1, 10, 30); const SINCE = new Date(2026, 8, 30, 10, 30);
const run = (p, over) => appendMetric(p, { type: 'run', mode: 'night', duration_ms: 3_300_000, ...over });
const report = (p, id, text) => { fs.mkdirSync(path.join(p.runs, id), { recursive: true }); fs.writeFileSync(path.join(p.runs, id, 'summary.md'), text); };
const compose = (p, c = cfg) => composeSummary(p, c, { now: NOW, since: SINCE });

test('сводка: сначала то, что нужно от человека, с номерами', () => {
  const dir = bareProject(); const p = paths(dir);
  const data = loadQuestions(p); addQuestion(data, { category: 'spec', text: 'Кэш в git?', defaultAnswer: 'оставить', now: new Date(2026, 9, 1, 9, 0) }, cfg); saveQuestions(p, data);
  addChange(dir, 'fix-x', { proposal: '# fix-x\n\nМелочи ревью.\n' }); requestApproval(listChanges(p.openspecChanges)[0], { now: new Date(2026, 9, 1, 9, 0) });
  run(p, { id: '20261001-0926', slot: null, mode: 'day', started_at: new Date(2026, 9, 1, 9, 26).toISOString(), status: 'ok', cost_usd: 4.43, turns: 25 });
  report(p, '20261001-0926', '# Прогон\n## Сделано\n- llm-adaptation: 10/10\n## Нужно от человека\n- Запустить eval 1.2.0 и утвердить стиль\n## План\n- …\n');
  const html = compose(p);
  assert.match(html, /^☀️ <b>demo<\/b> · 01\.10/);
  const need = html.indexOf('🙋'); assert.ok(need > 0 && need < html.indexOf('🌙'), 'блок «Нужно от вас» идёт перед прогонами');
  assert.match(html, /<b>🙋 Нужно от вас \(3\)<\/b>/);
  assert.match(html, /1\. Вопрос <b>Q1<\/b>: Кэш в git\? — по умолчанию «оставить», срок 02\.10/);
  assert.match(html, /2\. Одобрить <b>fix-x<\/b>: Мелочи ревью\./);
  assert.match(html, /3\. Запустить eval 1\.2\.0 и утвердить стиль/);
});
test('сводка: ничего не нужно — одна строка', () => {
  const p = paths(bareProject());
  assert.match(compose(p), /От вас ничего не нужно/);
});
test('сводка: прогоны по строке со значком, причина по-человечески, пропущенный слот', () => {
  const p = paths(bareProject());
  run(p, { id: '20261001-0000', slot: '00:00', started_at: new Date(2026, 9, 1, 0, 0).toISOString(), status: 'network', note: 'Failed to authenticate. API Error: 403 Request not allowed; репортёр не написал отчёт, записана авто-сводка' });
  run(p, { id: '20261001-0926', slot: null, mode: 'day', started_at: new Date(2026, 9, 1, 9, 26).toISOString(), status: 'ok', cost_usd: 4.43, turns: 25 });
  const html = compose(p);
  assert.match(html, /❌ 00:00 — нет доступа к API \(VPN\?\)/);
  assert.match(html, /💤 04:00 — пропущен: Mac спал или был выключен/);
  assert.match(html, /✅ 09:26 \(днём\) — 55 мин · ~\$4\.43/);
  assert.doesNotMatch(html, /авто-сводка|репортёр не написал/);
});
test('сводка: изменения с прогрессом по ветке и строка о следующем прогоне', () => {
  const dir = bareProject(); const p = paths(dir);
  addChange(dir, 'ddm', { tasks: '- [ ] a\n- [ ] b\n- [ ] c\n' });
  const [c] = listChanges(p.openspecChanges); requestApproval(c); setApproval(c, 'approved', 'human');
  gitRepo(dir); git(dir, 'add', '.'); git(dir, 'commit', '-q', '-m', 'проект');
  changeBranch(dir, 'ddm', '- [x] a\n- [x] b\n- [ ] c\n');
  const html = compose(p);
  assert.match(html, /<b>📦 Изменения<\/b>\n🔧 ddm — 2\/3/);
  assert.match(html, /<b>🗓 Следующий прогон:<\/b> команда продолжит ddm \(2\/3\)/);
});
test('сводка: работы нет — подсказка одобрить изменение', () => {
  const p = paths(bareProject());
  assert.match(compose(p), /<b>🗓 Следующий прогон:<\/b> работы нет — одобрите изменение/);
});
test('сводка: отчёты команды и метрики свёрнуты, авто-сводки не вставляются, HTML экранирован', () => {
  const p = paths(bareProject());
  run(p, { id: '20261001-0926', slot: null, mode: 'day', started_at: new Date(2026, 9, 1, 9, 26).toISOString(), status: 'ok' });
  run(p, { id: '20261001-0200', slot: '02:00', started_at: new Date(2026, 9, 1, 2, 0).toISOString(), status: 'error', note: 'boom' });
  report(p, '20261001-0926', '# Прогон 20261001-0926\n## Сделано\n- eval: отчёт <reports/eval.md> & кэш\n## В работе\n- нет\n');
  report(p, '20261001-0200', '# Прогон 20261001-0200 — авто-сводка (репортёр не отработал)\n## Коммиты за прогон\n(нет коммитов)\n');
  const html = compose(p);
  assert.match(html, /<blockquote expandable><b>Отчёт 09:26<\/b>\nСделано:\n• eval: отчёт &lt;reports\/eval\.md&gt; &amp; кэш/);
  assert.doesNotMatch(html, /Коммиты за прогон/);
  assert.match(html, /<blockquote expandable>📊 За период: /);
});
test('сводка: длинные отчёты урезаются, сообщение влезает в лимит Telegram', () => {
  const p = paths(bareProject());
  for (let i = 0; i < 6; i++) {
    const id = `20261001-0${i}00`;
    run(p, { id, slot: `0${i}:00`, started_at: new Date(2026, 9, 1, i, 0).toISOString(), status: 'ok' });
    report(p, id, '## Сделано\n' + Array.from({ length: 40 }, (_, k) => `- пункт ${k} ${'x'.repeat(60)}`).join('\n'));
  }
  const html = compose(p);
  assert.ok(html.length <= 3900, `длина ${html.length}`);
  assert.match(html, /…/);
  assert.equal((html.match(/<blockquote expandable>/g) || []).length, (html.match(/<\/blockquote>/g) || []).length, 'теги не разорваны');
});
test('summaryKeyboard: кнопки одобрения и ответа по умолчанию; prod-вопрос без кнопки', () => {
  const dir = bareProject(); const p = paths(dir);
  const data = loadQuestions(p);
  addQuestion(data, { category: 'spec', text: 'a?', defaultAnswer: 'да' }, cfg);
  addQuestion(data, { category: 'prod', text: 'на сервер?' }, cfg); saveQuestions(p, data);
  addChange(dir, 'fix-x'); requestApproval(listChanges(p.openspecChanges)[0]);
  assert.deepEqual(summaryKeyboard(p, cfg), [
    [{ text: '✅ Q1: по умолчанию', callback_data: 'qd:Q1' }],
    [{ text: '✅ Одобрить fix-x', callback_data: 'ap:fix-x' }, { text: '❌ Отклонить', callback_data: 'rj:fix-x' }],
  ]);
});
test('htmlToPlain: для консоли без тегов и сущностей', () => {
  assert.equal(htmlToPlain('<b>а</b> &lt;b&gt; &amp; <blockquote expandable>в</blockquote>'), 'а <b> & в');
});
test('sendSummary без Telegram печатает текст без тегов и не меняет state', async () => {
  const p = paths(bareProject()); const lines = [];
  const r = await sendSummary(p, { ...cfg, telegram: { chat_id: '', token_env: 'NOPE' } }, { log: (s) => lines.push(s), now: NOW });
  assert.equal(r.sent, false); assert.doesNotMatch(lines.join('\n'), /<b>/);
  assert.equal(loadState(p).last_summary_at, undefined);
});
test('sendSummary через Telegram: HTML и кнопки, обновляет last_summary_at', async () => {
  const dir = bareProject(); const p = paths(dir);
  addChange(dir, 'fix-x'); requestApproval(listChanges(p.openspecChanges)[0]);
  const sent = [];
  const tg = { sendMessage: async (_c, t, opts) => { sent.push({ t, opts }); } };
  process.env.TOK = 'x';
  const r = await sendSummary(p, { ...cfg, telegram: { chat_id: '1', token_env: 'TOK' } }, { telegram: tg, now: NOW, log: () => {} });
  assert.equal(r.sent, true); assert.equal(sent.length, 1);
  assert.equal(sent[0].opts.html, true);
  assert.equal(sent[0].opts.keyboard[0][0].callback_data, 'ap:fix-x');
  assert.ok(loadState(p).last_summary_at);
});

test('сводка: старый отчёт без раздела «Нужно от человека» — строки «От вас: …»', () => {
  const p = paths(bareProject());
  run(p, { id: '20261001-0926', slot: null, mode: 'day', started_at: new Date(2026, 9, 1, 9, 26).toISOString(), status: 'ok' });
  report(p, '20261001-0926', '# Прогон\n## Сделано\n- x\n## Блокеры и вопросы\n- От вас: реальный `eval 1.2.0`, чтобы утвердить стиль.\n');
  assert.match(compose(p), /1\. реальный <code>eval 1\.2\.0<\/code>, чтобы утвердить стиль\./);
});

import { writeShift } from '../src/shift-files.js';
test('сводка: предложение на день из ночной передачи и пометка об авто-передаче', () => {
  const p = paths(bareProject());
  writeShift(p, 'day', '# Смена: день → ночь, x (источник: авто)\n## Изменения\n## Порядок\n## Нужны решения человека\n## Заметки\n', new Date(2026, 9, 1, 0, 0));
  writeShift(p, 'night', '# Смена: ночь → день, x (источник: команда)\n## Изменения\n## Предложение на день\n1. ddm — доделать 2.3 вместе\n2. eval после правок\n## Нужны решения человека\n- нет\n## Заметки\n- нет\n', new Date(2026, 9, 1, 6, 40));
  const html = compose(p);
  assert.match(html, /<b>🌅 Предложение на день<\/b>\n1\. ddm — доделать 2\.3 вместе\n2\. eval после правок/);
  assert.match(html, /⚠️ смену не сдали — ночь шла по авто-передаче/);
});
