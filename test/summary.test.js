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

// 0.5.3: сводка 02.10 не влезла в Telegram (6647 символов) — пункты «Нужно от человека» из всех прогонов, сырой markdown в одобрениях.
import { splitHtml } from '../src/summary.js';
import { saveState } from '../src/state.js';
const LONG_DONE = '## Сделано\n' + Array.from({ length: 30 }, (_, k) => `- пункт ${k}: ${'сделано подробно '.repeat(5)}`).join('\n') + '\n';
const WHY = '# Proposal: заголовок\n\n## Why\n\n' + 'Импорт прошлой документации создал вторую страницу, и классификатор выбирает между ними наугад. '.repeat(5) + '\n\n## What Changes\n\n- x\n';
function noisyNight(dir, p) {
  for (const name of ['release-page-fixes', 'merge-report-upd', 'tracker-client-hardening']) addChange(dir, name, { proposal: WHY });
  for (const c of listChanges(p.openspecChanges)) requestApproval(c, { now: new Date(2026, 9, 1, 2, 30) });
  const runs = [
    ['20260930-1353', null, new Date(2026, 8, 30, 13, 53), ['запустить eval 1.2.0 с ключом LiteLLM и утвердить стиль', 'решить про HTTPS для доступа вне корпоративной сети', 'Push в origin не делался: запушить main, когда удобно']],
    ['20260930-1530', null, new Date(2026, 8, 30, 15, 30), ['перезапустить `eval 1.2.0 --limit 10` на новых промптах', 'создать бота у BotFather и запустить бота']],
    ['20260930-1753', null, new Date(2026, 8, 30, 17, 53), ['запустить eval 1.2.0 с ключом LiteLLM и утвердить стиль (ждёт с прошлых прогонов)']],
    ['20260930-2040', null, new Date(2026, 8, 30, 20, 40), ['перезапустить `eval 1.2.0 --limit 10` и утвердить стиль', 'настроить бота и выкатить на сервер (остаётся с прошлых прогонов)']],
    ['20261001-0200', '02:00', new Date(2026, 9, 1, 2, 0), ['одобрить `release-page-fixes` и `merge-report-upd`', 'перезапустить serve и bot локально (на сервере — деплой), чтобы в боте появились кнопки версий', 'запустить eval 1.2.0 и утвердить результат (по-прежнему за владельцем)']],
    ['20261001-0600', '06:00', new Date(2026, 9, 1, 6, 0), [
      'одобрить `release-page-fixes`, `merge-report-upd` и `tracker-client-hardening`; порядок реализации: `release-page-fixes` → `merge-report-upd`',
      'перезапустить serve и bot локально (на сервере — деплой), чтобы в боте появились кнопки версий',
      'Перезапустить serve и bot локально (на сервере — деплой) чтобы в боте появились кнопки версий.',
      'запустить eval 1.2.0 и утвердить результат',
      'после слияния `release-page-fixes` на сервере: `docker compose up -d --force-recreate docs-site` и пересборка']],
  ];
  for (const [id, slot, at, need] of runs) {
    run(p, { id, slot, mode: slot ? 'night' : 'day', started_at: at.toISOString(), status: 'ok', cost_usd: 3 });
    report(p, id, `# Прогон ${id}\n${LONG_DONE}## Нужно от человека\n${need.map((x) => `- ${x}`).join('\n')}\n## Блокеры и вопросы\n- нет\n`);
  }
  writeShift(p, 'night', '# Смена: ночь → день, x (источник: команда)\n## Изменения\n## Предложение на день\n1. release-page-fixes\n## Нужны решения человека\n- одобрения трёх изменений (в Telegram)\n- Запустить eval 1.2.0 и утвердить результат (по-прежнему за владельцем)\n- решить, нужны ли заглушки страниц из карты\n## Заметки\n- нет\n', new Date(2026, 9, 1, 6, 15));
}
const needBlock = (html) => html.slice(html.indexOf('🙋'), html.indexOf('🌙'));
test('0.5.3: «Нужно от вас» — из свежего отчёта и ночной передачи, без повторов и одобрений, уже стоящих сверху', () => {
  const dir = bareProject(); const p = paths(dir); noisyNight(dir, p);
  const html = compose(p); const need = needBlock(html);
  assert.match(need, /^🙋 Нужно от вас \(7\)<\/b>/, need);
  assert.equal((need.match(/eval 1\.2\.0/g) || []).length, 1, 'eval — один раз');
  assert.match(need, /запустить eval 1\.2\.0 и утвердить результат \(по-прежнему за владельцем\)/i, 'из повторов остаётся более полный');
  assert.equal((need.match(/serve и bot/gi) || []).length, 1, 'serve и bot — один раз');
  assert.match(need, /docker compose up -d --force-recreate docs-site/);
  assert.match(need, /решить, нужны ли заглушки страниц из карты/, 'пункт ночной передачи');
  assert.doesNotMatch(need, /HTTPS|BotFather|Push в origin|настроить бота/, 'пункты старых прогонов не попадают');
  assert.doesNotMatch(need, /\d\. [Оо]добр(?!ить <b>)/, 'одобрения уже стоят в списке сверху');
  assert.equal((need.match(/Одобрить <b>/g) || []).length, 3);
});
test('0.5.3: регрессия 02.10 — шесть отчётов с повторами: сводка влезает в Telegram, без «## Why», выдержка ≤ 160', () => {
  const dir = bareProject(); const p = paths(dir); noisyNight(dir, p);
  const html = compose(p);
  assert.ok(html.length <= 4096, `длина ${html.length}`);
  assert.doesNotMatch(html, /## Why|## What/);
  for (const m of html.matchAll(/Одобрить <b>[^<]+<\/b>: (.*?)(?: \(авто-одобрение [^)]*\))?$/gm)) assert.ok(m[1].length <= 160, `выдержка ${m[1].length}`);
  assert.match(html, /Одобрить <b>merge-report-upd<\/b>: Импорт прошлой документации/);
  assert.equal((html.match(/<blockquote expandable>/g) || []).length, (html.match(/<\/blockquote>/g) || []).length, 'теги не разорваны');
  assert.match(html, /📊 За период/, 'метрики остаются');
});
test('0.5.3: не влезает — сначала урезаются и выбрасываются блоки «Отчёт», метрики остаются', () => {
  const dir = bareProject(); const p = paths(dir);
  for (let i = 0; i < 6; i++) {
    const id = `20261001-0${i}00`;
    run(p, { id, slot: `0${i}:00`, started_at: new Date(2026, 9, 1, i, 0).toISOString(), status: 'ok' });
    report(p, id, LONG_DONE + (i === 5 ? '## Нужно от человека\n' + Array.from({ length: 12 }, (_, k) => `- задача ${k}: ${'нужно сделать вручную '.repeat(8)}`).join('\n') + '\n' : ''));
  }
  const html = compose(p);
  assert.ok(html.length <= 3900, `длина ${html.length}`);
  const blocks = [...html.matchAll(/<blockquote expandable><b>Отчёт [\d:]+<\/b>\n[\s\S]*?<\/blockquote>/g)].map((m) => m[0]);
  assert.ok(blocks.length > 0 && blocks.length < 6, `блоков ${blocks.length}`);
  for (const b of blocks) assert.match(b, /\n• пункт 0/, 'в каждом показанном блоке есть пункт, а не только «…»');
  assert.match(html, /Отчёт 05:00/, 'остаются свежие отчёты');
  assert.match(html, new RegExp(`Ещё отчётов: ${6 - blocks.length} — mcfly/runs`));
  assert.match(html, /📊 За период/);
  assert.equal((html.match(/<blockquote expandable>/g) || []).length, (html.match(/<\/blockquote>/g) || []).length);
});
test('0.5.3: splitHtml режет по строкам и не разрывает blockquote', () => {
  const html = ['<b>заголовок</b>', ...Array.from({ length: 8 }, (_, i) => `${i + 1}. строка ${'x'.repeat(20)}`), '<blockquote expandable><b>Отчёт</b>', 'a'.repeat(30), 'b'.repeat(30), 'c</blockquote>', 'хвост'].join('\n');
  const parts = splitHtml(html, 120);
  assert.ok(parts.length > 1);
  for (const part of parts) {
    assert.ok(part.length <= 120, `кусок ${part.length}`);
    assert.equal((part.match(/<blockquote/g) || []).length, (part.match(/<\/blockquote>/g) || []).length, part);
  }
  assert.equal(parts.join('\n'), html, 'ничего не теряется');
  assert.deepEqual(splitHtml('коротко', 4000), ['коротко']);
});
test('0.5.3: длинная сводка уходит несколькими сообщениями, клавиатура под первым', async () => {
  const dir = bareProject(); const p = paths(dir);
  const data = loadQuestions(p);
  for (let i = 0; i < 30; i++) addQuestion(data, { category: 'spec', text: `Вопрос номер ${i}: ${'длинная формулировка вопроса '.repeat(6)}`, defaultAnswer: 'да', now: new Date(2026, 9, 1, 9, 0) }, cfg);
  saveQuestions(p, data);
  const sent = [];
  const tg = { sendMessage: async (_c, t, opts) => { sent.push({ t, opts }); } };
  process.env.TOK = 'x';
  await sendSummary(p, { ...cfg, telegram: { chat_id: '1', token_env: 'TOK' } }, { telegram: tg, now: NOW, log: () => {} });
  assert.ok(sent.length > 1, `сообщений ${sent.length}`);
  for (const s of sent) { assert.ok(s.t.length <= 4000, `длина ${s.t.length}`); assert.equal(s.opts.html, true); }
  assert.ok(sent[0].opts.keyboard?.length, 'клавиатура под первым');
  assert.ok(sent.slice(1).every((s) => !s.opts.keyboard), 'под остальными — нет');
  assert.ok(loadState(p).last_summary_at);
});
test('0.5.3: Telegram отверг сводку — короткая тревога без HTML, ошибка дальше, last_summary_at не двигается', async () => {
  const dir = bareProject(); const p = paths(dir);
  saveState(p, { last_summary_at: '2026-10-01T07:30:00.109Z' });
  const sent = [];
  const tg = { sendMessage: async (_c, t, opts = {}) => { sent.push({ t, opts }); if (opts.html) throw new Error('Telegram sendMessage: Bad Request: message is too long'); } };
  process.env.TOK = 'x';
  await assert.rejects(sendSummary(p, { ...cfg, telegram: { chat_id: '1', token_env: 'TOK' } }, { telegram: tg, now: NOW, log: () => {} }), /message is too long/);
  const alarm = sent.at(-1);
  assert.equal(alarm.opts.html ?? false, false);
  assert.equal(alarm.t, '⚠️ mcfly demo: сводка не отправлена (Telegram sendMessage: Bad Request: message is too long), смотрите `mcfly summary`');
  assert.equal(loadState(p).last_summary_at, '2026-10-01T07:30:00.109Z');
});
test('0.5.3: «одобрить X» для уже решённого изменения и без имён — лишний; для изменения без запроса одобрения — остаётся', () => {
  const dir = bareProject(); const p = paths(dir);
  addChange(dir, 'done-x'); addChange(dir, 'new-y');
  setApproval(listChanges(p.openspecChanges).find((c) => c.name === 'done-x'), 'approved', 'human');
  run(p, { id: '20261001-0600', slot: '06:00', started_at: new Date(2026, 9, 1, 6, 0).toISOString(), status: 'ok' });
  report(p, '20261001-0600', '## Сделано\n- x\n## Нужно от человека\n- одобрить `done-x`\n- одобрения трёх изменений (в Telegram)\n- одобрить `new-y`, когда будет время\n');
  const need = needBlock(compose(p));
  assert.match(need, /Нужно от вас \(1\)/, need);
  assert.match(need, /1\. одобрить <code>new-y<\/code>, когда будет время/);
});
test('0.5.3: выдержка одобрения — `код` моноширинным', () => {
  const dir = bareProject(); const p = paths(dir);
  addChange(dir, 'fix-x', { proposal: '## Зачем\n\nЗаметка в `mcfly/answers.md` & <тег>.\n' }); requestApproval(listChanges(p.openspecChanges)[0]);
  assert.match(compose(p), /Одобрить <b>fix-x<\/b>: Заметка в <code>mcfly\/answers\.md<\/code> &amp; &lt;тег&gt;\./);
});
