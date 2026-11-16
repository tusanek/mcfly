import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { paths, loadState } from '../src/state.js';
import { DEFAULT_CONFIG, parseConfig } from '../src/config.js';
import { weeklyData, composeWeekly, sendWeekly } from '../src/weekly.js';
import { weeklyScenes, sendSummaryVideo } from '../src/video.js';
import { htmlToPlain } from '../src/summary.js';
import { planJobs, ownLabels, jobWhen } from '../src/schedule.js';

const NOW = new Date(2026, 10, 15, 19, 0); // воскресенье
const cfg = { ...DEFAULT_CONFIG, project: 'demo', schedule: { ...DEFAULT_CONFIG.schedule, slots: ['04:00'] }, telegram: { chat_id: '7', token_env: 'TOK_WEEKLY' } };
const at = (day, h = 4) => new Date(2026, 10, day, h, 0).toISOString();

function project({ goals = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcfly-weekly-'));
  const p = paths(dir);
  fs.mkdirSync(p.root, { recursive: true });
  const records = [
    { type: 'run', id: 'old', slot: '04:00', started_at: at(1), status: 'ok', duration_ms: 3600_000, usage: { seven_day: 0.9 } },
    { type: 'run', id: 'a', slot: '04:00', started_at: at(10), status: 'ok', duration_ms: 3600_000, usage: { seven_day: 0.2 } },
    { type: 'run', id: 'b', slot: '04:00', started_at: at(11), status: 'quota', duration_ms: 600_000, usage: { seven_day: 0.72 } },
    { type: 'run', id: 'c', slot: '04:00', started_at: at(15), status: 'ok', duration_ms: 1800_000, usage: { seven_day: 0.4 } },
    { type: 'event', key: 'tasks_done', value: 5, at: at(10) },
    { type: 'event', key: 'tasks_done', value: 9, at: at(2) },
  ];
  fs.writeFileSync(p.metrics, records.map((r) => JSON.stringify(r)).join('\n') + '\n');
  if (goals) fs.writeFileSync(path.join(p.root, 'goals.md'), '## Ближайшая веха\nПоказ в декабре.\n\n## До показа\n- [x] первое\n- [x] второе\n- [ ] третье\n');
  fs.writeFileSync(p.questions, 'questions:\n  - { id: Q1, category: spec, text: "Какой цвет?", status: open, deadline_at: "2026-11-20T00:00:00Z" }\n');
  const arch = path.join(p.openspecChanges, 'archive', '2026-11-12-add-greeting');
  fs.mkdirSync(arch, { recursive: true });
  fs.writeFileSync(path.join(arch, 'proposal.md'), '## Зачем\nБот здоровается с владельцем.\n\n## Как это будет выглядеть\n### Приветствие\n```\nДоброе утро!\n[Спасибо]\n```\n');
  fs.utimesSync(arch, new Date(2026, 10, 12), new Date(2026, 10, 12));
  const old = path.join(p.openspecChanges, 'archive', '2026-10-01-old-change');
  fs.mkdirSync(old, { recursive: true });
  fs.writeFileSync(path.join(old, 'proposal.md'), '## Зачем\nСтарое изменение.\n');
  fs.utimesSync(old, new Date(2026, 9, 1), new Date(2026, 9, 1));
  return p;
}

test('weeklyData: итоги семи дней — завершённое, цели, прогоны с пропусками, вопросы, лимит', () => {
  const p = project();
  const d = weeklyData(p, cfg, { now: NOW });
  assert.equal(d.closed.length, 1);
  assert.match(d.closed[0], /Бот здоровается/);
  assert.equal(d.tasksDone, 5);
  assert.deepEqual(d.goals, { done: 2, total: 3, delta: null, milestone: 'Показ в декабре.' });
  assert.deepEqual(d.runs.stats, { ok: 2, quota: 1, missed: 4 }); // слоты 9, 12, 13, 14 ноября без прогона
  assert.equal(d.runs.total, 7);
  assert.equal(d.waiting.questions.length, 1);
  assert.equal(d.usage.now, 0.4);
  assert.equal(d.usage.peak, 0.72);
  assert.equal(d.usage.quotaStops, 1);
  assert.equal(d.demos.length, 1);
  const text = htmlToPlain(d.html);
  assert.match(text, /demo · итоги недели 08\.11–15\.11/);
  assert.match(text, /Завершено за неделю \(1\)/);
  assert.match(text, /Закрыто задач: 5/);
  assert.match(text, /Сделано 2 из 3\n/);
  assert.match(text, /Всего 7: пропущено 4, успешных 2, остановлено по лимиту подписки 1/);
  assert.match(text, /Команда работала 1 ч 40 мин/);
  assert.match(text, /Вопрос Q1: Какой цвет\?/);
  assert.match(text, /занят на 40 % .*доходил до 72 %/);
  assert.match(text, /остановленных из-за лимита: 1/);
});

test('weeklyData: пропуски считаются только с первой записи проекта; пустой проект не падает', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcfly-weekly-')); const p = paths(dir); fs.mkdirSync(p.root, { recursive: true });
  const empty = htmlToPlain(composeWeekly(p, cfg, { now: NOW }));
  assert.match(empty, /Завершённых изменений нет/);
  assert.match(empty, /Прогонов не было/);
  assert.match(empty, /Ничего: открытых вопросов/);
  assert.match(empty, /Данных о лимите нет/);
  assert.doesNotMatch(empty, /Цели/);
  fs.writeFileSync(p.metrics, JSON.stringify({ type: 'run', id: 'a', slot: '04:00', started_at: at(14), status: 'ok' }) + '\n');
  assert.deepEqual(weeklyData(p, cfg, { now: NOW }).runs.stats, { ok: 1, missed: 1 }); // только слот 15 ноября
});

test('sendWeekly: отправляет текст, запоминает цели — следующая сводка показывает прирост; ролик только при video.enabled', async () => {
  process.env.TOK_WEEKLY = 'x';
  const p = project(); const sent = []; const clips = [];
  const tg = { sendMessage: async (chat, text, opts) => { sent.push({ chat, text, opts }); return [{ message_id: 5 }]; } };
  const video = async (pp, c, o) => { clips.push(o); return { sent: true }; };
  const r = await sendWeekly(p, cfg, { now: NOW, telegram: tg, log: () => {}, video });
  assert.equal(r.sent, true);
  assert.equal(r.video, null);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].opts.html, true);
  assert.equal(loadState(p).weekly_goals_done, 2);
  assert.equal(loadState(p).last_weekly_at, NOW.toISOString());
  fs.writeFileSync(path.join(p.root, 'goals.md'), '## До показа\n- [x] первое\n- [x] второе\n- [x] третье\n');
  const next = new Date(NOW.getTime() + 7 * 24 * 3600_000);
  assert.match(htmlToPlain(composeWeekly(p, cfg, { now: next })), /Сделано 3 из 3 \(\+1 за неделю\)/);
  await sendWeekly(p, { ...cfg, video: { ...cfg.video, enabled: true } }, { now: next, telegram: tg, log: () => {}, video });
  assert.equal(clips.length, 1);
  assert.equal(clips[0].weekly, true);
  assert.equal(clips[0].replyTo, 5);
});

test('sendWeekly без Telegram печатает текст и не меняет состояние', async () => {
  const p = project(); const lines = [];
  const r = await sendWeekly(p, { ...cfg, telegram: { chat_id: '', token_env: 'NOPE_WEEKLY' } }, { now: NOW, log: (s) => lines.push(s) });
  assert.equal(r.sent, false);
  assert.match(lines[0], /итоги недели/);
  assert.equal(loadState(p).last_weekly_at, undefined);
});

test('weeklyScenes: диктору — только русские слова; сцены по разделам, образец экраном чата', () => {
  const p = project();
  const scenes = weeklyScenes(weeklyData(p, cfg, { now: NOW }), cfg);
  assert.deepEqual(scenes.map((s) => s.title), ['demo', 'Завершено за неделю', 'Как это выглядит', 'Цели', 'Прогоны', 'Ждёт вас', 'Лимит подписки', 'Что дальше']);
  for (const s of scenes) assert.doesNotMatch(s.speech, /[0-9A-Za-z<>&]/, s.title);
  const by = Object.fromEntries(scenes.map((s) => [s.title, s]));
  assert.deepEqual(by.demo.lines, ['Итоги недели', '8 ноября — 15 ноября']);
  assert.match(by['Завершено за неделю'].speech, /завершила одно изменение\. Бот здоровается/);
  assert.equal(by['Как это выглядит'].kind, 'chat');
  assert.match(by['Цели'].speech, /сделано два из трёх пунктов/);
  assert.match(by['Прогоны'].speech, /семь прогонов\. Не все прошли гладко/);
  assert.match(by['Ждёт вас'].speech, /один вопрос без ответа\. Всё это — в боте/);
  assert.match(by['Лимит подписки'].speech, /занят на сорок процентов\. Из за лимита остановлено: один прогон/);
  assert.match(by['Что дальше'].speech, /Хорошей недели/);
});

test('weeklyScenes: спокойная неделя — без сцен «Ждёт вас», целей и лимита', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcfly-weekly-')); const p = paths(dir); fs.mkdirSync(p.root, { recursive: true });
  fs.writeFileSync(p.metrics, JSON.stringify({ type: 'run', id: 'a', slot: '04:00', started_at: at(15), status: 'ok' }) + '\n');
  const scenes = weeklyScenes(weeklyData(p, cfg, { now: NOW }), cfg);
  assert.deepEqual(scenes.map((s) => s.title), ['demo', 'Завершено за неделю', 'Прогоны', 'Что дальше']);
  assert.match(scenes[2].speech, /Единственный прогон за неделю прошёл успешно/);
});

test('sendSummaryVideo weekly: своё имя файла, подпись и вид ролика', async () => {
  const p = project(); const calls = []; const built = [];
  const tg = { sendVideo: async (...a) => { calls.push(a); }, sendMessage: async () => [] };
  const c = { ...cfg, video: { ...cfg.video, enabled: true } };
  const r = await sendSummaryVideo(p, c, { data: weeklyData(p, c, { now: NOW }), tg, now: NOW, replyTo: 5, log: () => {}, weekly: true, build: async (_, o) => { built.push(o); return { file: '/tmp/x/weekly.mp4', seconds: 61 }; } });
  assert.equal(r.sent, true);
  assert.equal(built[0].kind, 'Итоги недели');
  assert.match(built[0].name, /^weekly-2026-11-15-1900$/);
  assert.equal(calls[0][2].caption, '🎬 Итоги недели к 15.11 · 1:01');
});

test('расписание: недельная сводка — задание weekly с днём недели; weekly_day 0 — без него', () => {
  const opts = { projectDir: '/p', node: '/usr/bin/node', mcflyBin: '/m/bin/mcfly', logsDir: '/l', pathEnv: '/usr/bin', home: '/h' };
  const job = planJobs(cfg, opts).find((j) => j.label === 'com.mcfly.demo.weekly');
  assert.deepEqual(job.args, ['summary', '--weekly', '--send', '--project', '/p']);
  assert.equal(jobWhen(job), 'вс 19:00');
  assert.match(job.plist, /<dict><key>Weekday<\/key><integer>7<\/integer><key>Hour<\/key><integer>19<\/integer><key>Minute<\/key><integer>0<\/integer><\/dict>/);
  assert.doesNotMatch(planJobs(cfg, opts).find((j) => j.label.endsWith('.summary')).plist, /Weekday/);
  assert.equal(planJobs({ ...cfg, schedule: { ...cfg.schedule, weekly_day: 0 } }, opts).some((j) => j.label.endsWith('.weekly')), false);
  assert.deepEqual(ownLabels(['com.mcfly.demo.weekly.plist'], 'demo'), ['com.mcfly.demo.weekly']);
});

test('настройки: weekly_day от 0 до 7, weekly_at — время', () => {
  assert.equal(parseConfig('project: demo').schedule.weekly_day, 7);
  assert.throws(() => parseConfig('project: demo\nschedule: { weekly_day: 8 }'), /weekly_day/);
  assert.throws(() => parseConfig('project: demo\nschedule: { weekly_at: "7pm" }'), /weekly_at/);
});
