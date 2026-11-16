import test from 'node:test';
import assert from 'node:assert/strict';
import { weeklyWidget, weeklyRichHtml, weeklyListHtml, packedSize } from '../src/widget.js';
import { sendWeeklyList } from '../src/weekly.js';
import { DEFAULT_CONFIG, parseConfig } from '../src/config.js';
import { createTelegram } from '../src/telegram.js';

const cfg = { ...DEFAULT_CONFIG, project: 'demo', telegram: { chat_id: '7', token_env: 'TOK' } };
const item = (i, notable = true, benefit = `Польза пункта ${i}: стало удобнее и быстрее`) => ({ title: `Возможность номер ${i}`, benefit, notable });
const data = (items, goals = { done: 2, total: 4, delta: 1 }) => ({ since: new Date(2026, 10, 8, 19), now: new Date(2026, 10, 15, 19), goals, items });

test('weeklyWidget: один документ без внешних файлов; данные в коде, свежие сверху, две вкладки', () => {
  const w = weeklyWidget(data([item(1), item(2, false), item(3)]), cfg);
  assert.equal(w.total, 3); assert.equal(w.shown, 3);
  assert.equal(w.caption, '📋 demo: все изменения недели — 3');
  assert.match(w.html, /Итоги недели · 08\.11–15\.11/);
  assert.match(w.html, /Цели: сделано 2 из 4 · \+1 за неделю<\/div><div class=b><i style="width:50%">/);
  assert.doesNotMatch(w.html, /https?:|<link|<img|src=|fetch\(|\0/);
  const groups = JSON.parse(/var D=(\[.*?\]),g=0/.exec(w.html)[1]);
  assert.deepEqual(groups.map(([name, rows]) => [name, rows.map((r) => r[0])]), [['Новое', ['Возможность номер 3', 'Возможность номер 1']], ['Доработки', ['Возможность номер 2']]]);
  assert.ok(packedSize(w.html) <= 3900);
});

test('weeklyWidget: разметка в названиях не ломает код; нет пунктов — нет виджета; без целей — без полосы', () => {
  const w = weeklyWidget(data([{ title: 'Тег </script><b>x', benefit: 'a & b', notable: true }], null), cfg);
  assert.equal((w.html.match(/<\/script>/g) || []).length, 1);
  assert.doesNotMatch(w.html, /class=b>/);
  assert.equal(weeklyWidget(data([]), cfg), null);
});

test('weeklyWidget: не влезает в предел — сначала короче польза, потом без самых старых; в подписи — сколько показано', () => {
  const noise = (i) => Array.from({ length: 24 }, (_, k) => String.fromCharCode(1072 + ((i * 7 + k * 13) % 32)) + String.fromCharCode(1072 + ((i * 3 + k * 5) % 32))).join(' ');
  const many = Array.from({ length: 300 }, (_, i) => ({ title: `Пункт ${i} ${noise(i)}`, benefit: noise(i + 500), notable: i % 2 === 0 }));
  const w = weeklyWidget(data(many), cfg);
  assert.ok(packedSize(w.html) <= 3900, String(packedSize(w.html)));
  assert.ok(Buffer.byteLength(w.html) <= 32000);
  assert.ok(w.shown < 300 && w.shown > 5, String(w.shown));
  assert.match(w.caption, new RegExp(`— 300 \\(в списке последние ${w.shown}\\)`));
  assert.match(w.html, /Пункт 299 /);
  assert.doesNotMatch(w.html, /Пункт 0 /);
});

test('weeklyListHtml: тот же список текстом, по разделам', () => {
  const html = weeklyListHtml(data([item(1), item(2, false, '')]), cfg);
  assert.match(html, /все изменения недели \(2\)/);
  assert.match(html, /<b>Новое \(1\)<\/b>\n• <b>Возможность номер 1<\/b> — Польза пункта 1/);
  assert.match(html, /<b>Исправления и доработки \(1\)<\/b>\n• <b>Возможность номер 2<\/b>$/);
  assert.equal(weeklyListHtml(data([]), cfg), '');
});

test('weeklyRichHtml: расширенное сообщение — два сворачиваемых раздела, в каждом нумерованный список с пользой', () => {
  const html = weeklyRichHtml(data([item(1), item(2, false, ''), { title: 'A <b> & c', benefit: 'x < y', notable: true }]), cfg);
  assert.match(html, /^<h3>📋 demo · итоги недели 08\.11–15\.11<\/h3><p>Завершено изменений: 3\. Цели: сделано 2 из 4, \+1 за неделю\.<\/p>/);
  assert.match(html, /<details open><summary><b>Новое · 2<\/b><\/summary><ol><li><b>A &lt;b&gt; &amp; c<\/b><br>x &lt; y<\/li><li><b>Возможность номер 1<\/b><br>Польза пункта 1/);
  assert.match(html, /<details><summary><b>Исправления и доработки · 1<\/b><\/summary><ol><li><b>Возможность номер 2<\/b><\/li><\/ol><\/details>/);
  const big = weeklyRichHtml(data(Array.from({ length: 260 }, (_, i) => item(i))), cfg);
  assert.match(big, /Завершено изменений: 260 \(в списке последние 200\)/);
  assert.ok(big.length < 32768);
});

test('sendWeeklyList: начинаем с выбранного способа, не принят — следующий: виджет → расширенное сообщение → текст', async () => {
  const d = data([item(1)]); const calls = []; const lines = [];
  const ok = { sendWidget: async (...a) => { calls.push(['widget', ...a]); }, sendRichMessage: async (...a) => { calls.push(['rich', ...a]); }, sendMessage: async (...a) => { calls.push(['text', ...a]); return [{}]; } };
  const mode = (m) => ({ ...cfg, schedule: { ...cfg.schedule, weekly_list: m } });
  assert.equal(await sendWeeklyList(cfg, { data: d, tg: ok, replyTo: 5, log: () => {} }), 'widget');
  assert.equal(calls[0][0], 'widget'); assert.equal(calls[0][1], '7');
  assert.deepEqual(calls[0][3], { caption: '📋 demo: все изменения недели — 1', replyTo: 5 });
  calls.length = 0;
  const closed = { ...ok, sendWidget: async () => { throw new Error('Telegram sendWidget: Bad Request: INPUT_MEDIA_WIDGET_NOT_ALLOWED'); } };
  assert.equal(await sendWeeklyList(cfg, { data: d, tg: closed, replyTo: 5, log: (s) => lines.push(s) }), 'rich');
  assert.match(lines[0], /Список недели виджетом не отправлен: .*INPUT_MEDIA_WIDGET_NOT_ALLOWED/);
  assert.match(lines[1], /отправлен расширенным сообщением \(пунктов 1\)/);
  assert.deepEqual([calls[0][0], calls[0][3]], ['rich', { replyTo: 5 }]);
  calls.length = 0;
  const old = { ...closed, sendRichMessage: async () => { throw new Error('Not Found'); } };
  assert.equal(await sendWeeklyList(cfg, { data: d, tg: old, log: () => {} }), 'text');
  assert.equal(calls[0][0], 'text');
  calls.length = 0;
  assert.equal(await sendWeeklyList(mode('rich'), { data: d, tg: ok, log: () => {} }), 'rich');
  assert.equal(await sendWeeklyList(mode('text'), { data: d, tg: ok, log: () => {} }), 'text');
  assert.deepEqual(calls.map((c) => c[0]), ['rich', 'text']);
  calls.length = 0;
  assert.equal(await sendWeeklyList(mode('off'), { data: d, tg: ok, log: () => {} }), null);
  assert.equal(await sendWeeklyList(cfg, { data: data([]), tg: ok, log: () => {} }), null);
  assert.equal(calls.length, 0);
  const dead = { sendWidget: async () => { throw new Error('x'); }, sendRichMessage: async () => { throw new Error('z'); }, sendMessage: async () => { throw new Error('y'); } };
  assert.equal(await sendWeeklyList(cfg, { data: d, tg: dead, log: () => {} }), null, 'сбой списка сводку не срывает');
});

test('telegram.sendWidget: запрос sendWidget с подписью и ответом на сообщение', async () => {
  const seen = [];
  const tg = createTelegram({ token: 't', fetchImpl: async (url, opts) => { seen.push([url, JSON.parse(opts.body)]); return { json: async () => ({ ok: true, result: { message_id: 9 } }) }; } });
  assert.deepEqual(await tg.sendWidget('7', '<b>x</b>', { caption: 'Подпись', replyTo: 3 }), { message_id: 9 });
  assert.match(seen[0][0], /\/sendWidget$/);
  assert.deepEqual(seen[0][1], { chat_id: '7', html: '<b>x</b>', caption: 'Подпись', reply_parameters: { message_id: 3, allow_sending_without_reply: true } });
});

test('telegram.sendRichMessage: запрос sendRichMessage с разметкой HTML', async () => {
  const seen = [];
  const tg = createTelegram({ token: 't', fetchImpl: async (url, opts) => { seen.push([url, JSON.parse(opts.body)]); return { json: async () => ({ ok: true, result: { message_id: 9 } }) }; } });
  await tg.sendRichMessage('7', '<h3>x</h3>', { replyTo: 3 });
  assert.match(seen[0][0], /\/sendRichMessage$/);
  assert.deepEqual(seen[0][1], { chat_id: '7', rich_message: { html: '<h3>x</h3>' }, reply_parameters: { message_id: 3, allow_sending_without_reply: true } });
});

test('настройки: weekly_list — widget, rich, text или off', () => {
  assert.equal(parseConfig('project: demo').schedule.weekly_list, 'widget');
  assert.equal(parseConfig('project: demo\nschedule: { weekly_list: rich }').schedule.weekly_list, 'rich');
  assert.throws(() => parseConfig('project: demo\nschedule: { weekly_list: file }'), /weekly_list/);
});
