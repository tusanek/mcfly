import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { exists, ensureDir, readJson, writeJson, pad2, localDateKey } from './util.js';
import { MCFLY_ROOT } from './prompt.js';
import { loadState, saveState } from './state.js';
import { speakable, clipSentences, numWords, numGenitive, plural, MONTHS_GEN } from './speech.js';

// 0.12.0: сводка коротким роликом с голосом — по желанию проекта (video.enabled). Текст сводки уходит как раньше и первым;
// ролик собирается после него и приходит отдельным сообщением. Любой сбой сборки — только строка в чат, текст уже у владельца.
// Картинку собирает Remotion (шаблон в video/ комплекта), голос — локальный синтезатор Silero; ставятся командой `mcfly video setup`.

const template = () => path.join(MCFLY_ROOT, 'video'); // функцией: модули ссылаются друг на друга по кругу, при загрузке MCFLY_ROOT ещё нет
export const MODEL_URL = 'https://models.silero.ai/models/tts/ru/v5_ru.pt';
/** Имя проекта для папки роликов: только буквы, цифры, «_» и «-» — из папки роликов по имени не выйти. */
export const projectSlug = (name) => String(name ?? '').replace(/[^\p{L}\p{N}_-]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'project';

/**
 * Где лежит всё для роликов: приложение Remotion, питон с синтезатором, модель голоса, готовые ролики. Общее на все проекты.
 * Пути к питону и модели из настроек проекта не берутся: config.yaml правят агенты, а это запускаемый файл и модель с кодом внутри.
 */
export function videoPaths(cfg, { home = path.join(os.homedir(), '.mcfly', 'video') } = {}) {
  // Готовое окружение навыка video-explainer подходит как есть — второй гигабайт ставить незачем
  const shared = path.join(os.homedir(), '.video-explainer');
  const first = (list) => list.find((f) => exists(f)) || list[0];
  return {
    home, app: path.join(home, 'app'), out: path.join(home, 'out', projectSlug(cfg.project)),
    cli: path.join(home, 'app', 'node_modules', '@remotion', 'cli', 'remotion-cli.js'),
    python: first([path.join(home, 'venv', 'bin', 'python'), path.join(shared, 'venv', 'bin', 'python')]),
    model: first([path.join(home, 'models', 'v5_ru.pt'), path.join(shared, 'models', 'v5_ru.pt')]),
  };
}

/** Чего не хватает для сборки ролика: [{ label, hint }]; пусто — всё на месте. */
export function videoProblems(cfg, vp = videoPaths(cfg)) {
  const hint = 'выполните mcfly video setup';
  const out = [];
  if (!exists(vp.cli)) out.push({ label: `сборщик роликов Remotion не установлен (${vp.app})`, hint });
  if (!exists(vp.python)) out.push({ label: `нет окружения озвучки (${vp.python})`, hint });
  if (!exists(vp.model)) out.push({ label: `нет модели голоса (${vp.model})`, hint });
  return out;
}

const plain = (html) => String(html ?? '').replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
// Исход прогонов словами для счёта: «успешно — два, пропущено — один»
const SPOKEN = { ok: 'успешно', missed: 'пропущено', error: 'сорвалось из-за сбоя', timeout: 'остановлено по времени', quota: 'остановлено из-за лимита подписки', network: 'не состоялось из-за связи', locked: 'не запускалось' };
const SHOWN = { ok: '✅ успешно', missed: '⚠️ пропущено', error: '❌ сбой', timeout: '⏱ остановлено по времени', quota: '⛔ лимит подписки', network: '🌐 не было связи', locked: '🔒 не запускалось' };
// Номера пунктов и вопросов (I22, Q4) в ролике не нужны: остаётся название, а где его нет — ничего
const noIds = (t) => String(t).replace(/(?<![\p{L}\p{N}])[A-Z]\d+(?![\p{L}\p{N}])\s*:?/gu, ' ').replace(/\s*—\s*кнопка\s+«[^»]*»/g, '').replace(/\s+([,.;:])/g, '$1').replace(/(?:,\s*)+(?=[,.;:]|$)/g, '').replace(/\s+/g, ' ').trim();
const CHARS_PER_SECOND = 14; // темп диктора: по нему текст укладывается в video.max_seconds
const RUNS = ['прогон', 'прогона', 'прогонов'];

// Дело владельца — то, что делается руками вне бота (правка на ноутбуке, сервере, в базе, запуск скрипта). Одобрить, выбрать,
// ответить или нажать кнопку в Telegram он увидит в боте сам — в ролик это не идёт.
const IN_BOT = /(?<![\p{L}\p{N}])(одобр|согласов|утверд|решить по|решите|выбрать|выберите|ответить на|ответьте|нажать|нажмите|кнопк|в боте|в телеграм|telegram)/iu;
const cap = (t) => t.charAt(0).toUpperCase() + t.slice(1);
const dot = (t) => (/[.!?…]$/.test(t) ? t : `${t}.`);
/** Сколько секунд держать сцену, чтобы успеть прочитать её с экрана. */
const readSeconds = (lines) => Math.min(9, 2 + lines.join(' ').length / 22);

/**
 * Сцены ролика из частей сводки (summaryData). Главное — что сделано и как это выглядит; прогоны упоминаются вслух, только если
 * что-то не удалось; дела владельца — только те, что делаются вне бота. Заголовки диктор не читает: они на экране.
 * Сцена: { key, kind: 'text' | 'chat', title, lines, speech, hold, chat? }; диктору идут только русские слова (speakable).
 */
export function summaryScenes(data, cfg, { now = new Date() } = {}) {
  const say = (t) => speakable(t, cfg.video.pronounce);
  const scenes = [];
  const add = (title, lines, speech, extra = {}) => { const shown = lines.filter(Boolean); scenes.push({ key: `s${scenes.length}`, kind: 'text', title, lines: shown, speech: say(speech), hold: readSeconds([title, ...shown]), ...extra }); };

  const stats = Object.entries(data.runStats || {}).filter(([, n]) => n > 0);
  const total = stats.reduce((n, [, c]) => n + c, 0);
  const failed = stats.filter(([st]) => st !== 'ok');
  const runsLine = !total ? (data.running ? '▶️ прогон идёт сейчас' : 'Прогонов не было') : failed.length ? '' : `✅ ${total} ${plural(total, RUNS)} — ${total === 1 ? 'успешно' : 'все успешно'}`;
  add(cfg.project, ['Утренняя сводка', `${now.getDate()} ${MONTHS_GEN[now.getMonth()]}`, runsLine], say(cfg.project) ? `Доброе утро. Сводка по проекту ${cfg.project}.` : 'Доброе утро. Утренняя сводка.');

  // Прогоны — отдельной сценой и вслух, только когда что-то не удалось: это требует внимания
  if (failed.length) {
    const ok = total - failed.reduce((n, [, c]) => n + c, 0);
    add('Требует внимания', [...failed.map(([st, n]) => `${SHOWN[st] || st} — ${n}`), ok ? `${SHOWN.ok} — ${ok}` : ''],
      `Не все прогоны прошли гладко: ${failed.map(([st, n]) => `${SPOKEN[st] || 'с другим исходом'} — ${numWords(n)}`).join(', ')}.`);
  }

  const todo = (data.todo || []).map(plain).filter((x) => !IN_BOT.test(x)).map(noIds).filter(Boolean);
  if (todo.length) {
    const shown = todo.slice(0, 4).map((x, i) => `${i + 1}. ${clipSentences(x, 120)}`);
    if (todo.length > 4) shown.push(`…и ещё ${todo.length - 4}`);
    const more = todo.length - 1;
    add('Нужно от вас', shown, `От вас нужно: ${dot(clipSentences(todo[0], 160))}${more ? ` И ещё ${numWords(more, 'n')} ${plural(more, ['дело', 'дела', 'дел'])} — на экране.` : ''}`);
  }

  const titles = (data.work || []).map((w) => ({ title: noIds(plain(w.title)).replace(/^«|»$/g, ''), progress: plain(w.progress) })).filter((w) => w.title);
  const next = titles.length ? `Команда продолжит: ${titles.slice(0, 2).map((w) => `${w.title} — ${w.progress}`).join('; ')}`
    : data.work?.length ? 'Команда продолжит начатое' : data.planning ? 'Команда составит план по взятым предложениям' : 'Работы в очереди у команды нет';
  const nextSpeech = `${dot(clipSentences(next, 180))} Хорошего дня.`;

  // Что сделано — главное в ролике: до трёх последних прогонов, на них уходит всё время, что осталось от остальных сцен
  const done = (data.plain || []).slice(-3).map(({ text }) => {
    const para = (lead) => noIds((text.split('\n').find((l) => l.startsWith(`${lead}:`)) || '').slice(lead.length + 1).trim());
    return { what: cap(para('Что сделано') || noIds(text.replace(/\n/g, ' '))), why: para('Зачем') };
  }).filter((d) => d.what);
  // Образцы: по первому (главному) от двух последних изменений; изменение одно — два его первых образца
  const demos = pickDemos(data.demos);
  const used = scenes.reduce((n, s) => n + s.speech.length, 0) + say(nextSpeech).length + demos.length * 40;
  const room = Math.max(140, Math.floor((cfg.video.max_seconds * CHARS_PER_SECOND - used) / Math.max(1, done.length)));
  for (const d of done) {
    const what = clipSentences(d.what, Math.min(room, 420)); const why = d.why && what.length + d.why.length < room ? clipSentences(d.why, 200) : '';
    add('Что сделано', [clipSentences(d.what, 300), why ? `Зачем: ${why}` : ''], `${dot(what)}${why ? ` ${dot(cap(why))}` : ''}`);
  }
  // Демонстрация — образцы «Как это будет выглядеть» из описаний изменений: экран чата с сообщением и кнопками
  for (const [i, d] of demos.entries()) add(...demoScene(d, i));
  add('Что дальше', titles.length ? titles.slice(0, 2).map((w) => `${clipSentences(w.title, 110)} — ${w.progress}`) : [next], nextSpeech);
  return scenes;
}

/** Образцы для ролика: по первому (главному) от двух последних изменений; изменение одно — два его первых образца. */
function pickDemos(all) {
  const byChange = new Map(); for (const d of all || []) byChange.set(d.change, [...(byChange.get(d.change) || []), d]);
  const groups = [...byChange.values()].slice(-2);
  return groups.length === 1 ? groups[0].slice(0, 2) : groups.map((g) => g[0]);
}
/** Сцена-демонстрация: экран чата с сообщением и кнопками. Возвращает аргументы add. */
function demoScene(d, i) {
  const text = d.text.split('\n').slice(0, 14).join('\n').slice(0, 520);
  return ['Как это выглядит', [clipSentences(noIds(plain(d.title)) || noIds(plain(d.change)).replace(/^«|»$/g, ''), 110)], i ? 'И ещё один пример.' : 'Вот как это выглядит.',
    { kind: 'chat', chat: { text, buttons: d.buttons.slice(0, 3).map((row) => row.slice(0, 4)) }, hold: Math.min(10, 3.5 + text.length / 45) }];
}

const bare = (t) => noIds(plain(t)).replace(/^«|»$/g, '');
const dayMonth = (d) => `${d.getDate()} ${MONTHS_GEN[d.getMonth()]}`;
const count = (n, words, gender = 'm') => `${numWords(n, gender)} ${plural(n, words)}`;

/**
 * Сцены недельного ролика (0.13.0) из weeklyData: что завершено и как это выглядит, цели, прогоны, что ждёт владельца, лимит
 * подписки, что дальше. Те же правила, что у утреннего: заголовки диктор не читает, номеров пунктов нет.
 */
export function weeklyScenes(data, cfg) {
  const say = (t) => speakable(t, cfg.video.pronounce);
  const scenes = [];
  const add = (title, lines, speech, extra = {}) => { const shown = lines.filter(Boolean); scenes.push({ key: `s${scenes.length}`, kind: 'text', title, lines: shown, speech: say(speech), hold: readSeconds([title, ...shown]), ...extra }); };
  add(cfg.project, ['Итоги недели', `${dayMonth(data.since)} — ${dayMonth(data.now)}`], say(cfg.project) ? `Добрый вечер. Итоги недели по проекту ${cfg.project}.` : 'Добрый вечер. Итоги недели.');

  const closed = (data.closed || []).map(bare).filter(Boolean);
  const n = data.closed?.length || 0;
  const shown = closed.slice(-4).map((t) => `• ${clipSentences(t, 90)}`);
  if (closed.length > 4) shown.push(`…и ещё ${closed.length - 4}`);
  const tasks = data.tasksDone ? `Закрыто задач: ${data.tasksDone}` : '';
  const doneSpeech = n ? `Команда завершила ${count(n, ['изменение', 'изменения', 'изменений'], 'n')}${closed.length ? `. ${n > 2 ? 'Среди них: ' : ''}${closed.slice(-2).map((t) => clipSentences(t, 110)).join('; ')}` : ''}.`
    : data.tasksDone ? `Завершённых изменений за неделю нет, закрыто ${count(data.tasksDone, ['задача', 'задачи', 'задач'], 'f')}.` : 'Завершённых изменений за неделю нет.';
  add('Завершено за неделю', n ? [...shown, tasks] : ['Завершённых изменений нет', tasks], doneSpeech);
  for (const [i, d] of pickDemos(data.demos).entries()) add(...demoScene(d, i));

  if (data.goals) {
    const g = data.goals;
    add('Цели', [`Сделано ${g.done} из ${g.total}`, g.delta > 0 ? `+${g.delta} за неделю` : '', g.milestone ? `Веха: ${clipSentences(plain(g.milestone), 140)}` : ''],
      `По целям сделано ${numWords(g.done)} из ${numGenitive(g.total)} ${g.total % 10 === 1 && g.total % 100 !== 11 ? 'пункта' : 'пунктов'}.${g.delta > 0 ? ` За неделю — плюс ${numWords(g.delta)}.` : ''}`);
  }

  const stats = Object.entries(data.runs?.stats || {}).filter(([, c]) => c > 0);
  const total = data.runs?.total || 0;
  const failed = stats.filter(([st]) => st !== 'ok');
  if (!total) add('Прогоны', ['Прогонов не было'], 'Прогонов за неделю не было.');
  else if (!failed.length) add('Прогоны', [`✅ ${total} ${plural(total, RUNS)} — ${total === 1 ? 'успешно' : 'все успешно'}`], total === 1 ? 'Единственный прогон за неделю прошёл успешно.' : 'Все прогоны за неделю прошли успешно.');
  else {
    const ok = total - failed.reduce((s, [, c]) => s + c, 0);
    add('Прогоны', [`Всего ${total}`, ok ? `${SHOWN.ok} — ${ok}` : '', ...failed.map(([st, c]) => `${SHOWN[st] || st} — ${c}`)],
      `За неделю ${count(total, RUNS)}. Не все прошли гладко: ${failed.map(([st, c]) => `${SPOKEN[st] || 'с другим исходом'} — ${numWords(c)}`).join(', ')}.`);
  }

  const w = data.waiting || { questions: [], pending: 0, proposed: 0 };
  const parts = [w.questions.length ? `${count(w.questions.length, ['вопрос', 'вопроса', 'вопросов'])} без ответа` : '', w.pending ? `${count(w.pending, ['план', 'плана', 'планов'])} на одобрении` : '',
    w.proposed ? count(w.proposed, ['предложение', 'предложения', 'предложений'], 'n') : ''].filter(Boolean);
  if (parts.length) {
    add('Ждёт вас', [...w.questions.slice(0, 2).map((q) => `• ${clipSentences(noIds(plain(q.text)), 110)}`), w.pending ? `Планов на одобрении: ${w.pending}` : '', w.proposed ? `Предложений без решения: ${w.proposed}` : ''],
      `Вашего решения ждут: ${parts.join(', ')}. Всё это — в боте.`);
  }

  if (data.usage) {
    const u = data.usage; const now = Math.round(u.now * 100); const peak = u.peak != null && u.peak > u.now ? Math.round(u.peak * 100) : 0;
    add('Лимит подписки', [`Недельный лимит занят на ${now} %`, peak ? `За неделю доходил до ${peak} %` : '', u.quotaStops ? `Остановок из-за лимита: ${u.quotaStops}` : ''],
      `Недельный лимит подписки занят на ${now}%.${u.quotaStops ? ` Из-за лимита остановлено: ${count(u.quotaStops, RUNS)}.` : ''}`);
  }

  const titles = (data.work || []).map((x) => ({ title: bare(x.title), progress: plain(x.progress) })).filter((x) => x.title);
  const next = titles.length ? `Команда продолжит: ${titles.slice(0, 2).map((x) => `${x.title} — ${x.progress}`).join('; ')}` : data.work?.length ? 'Команда продолжит начатое' : 'Работы в очереди у команды нет';
  add('Что дальше', titles.length ? titles.slice(0, 2).map((x) => `${clipSentences(x.title, 110)} — ${x.progress}`) : [next], `${dot(clipSentences(next, 180))} Хорошей недели.`);
  return scenes;
}

/** Запуск с лимитом времени: по истечении убиваем всю группу процессов (у сборщика есть дочерний браузер). */
export function runTool(bin, args, { cwd, timeoutMs, label }) {
  return new Promise((resolve, reject) => {
    if (timeoutMs <= 0) return reject(new Error(`${label}: не осталось времени`));
    let tail = '';
    const child = spawn(bin, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    const keep = (d) => { tail = (tail + d).slice(-600); };
    child.stdout.on('data', keep); child.stderr.on('data', keep);
    const timer = setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} reject(new Error(`${label}: не уложилось в ${Math.round(timeoutMs / 1000)} с`)); }, timeoutMs);
    child.on('error', (e) => { clearTimeout(timer); reject(new Error(`${label}: ${e.message}`)); });
    child.on('close', (code) => { clearTimeout(timer); if (code === 0) resolve(tail); else reject(new Error(`${label}: код ${code}${tail.trim() ? ` — ${tail.trim().split('\n').slice(-2).join(' ')}` : ''}`)); });
  });
}

/** Шаблон ролика из комплекта → приложение в общей папке (без node_modules): обновление mcfly доходит до роликов само. */
export function syncTemplate(vp) {
  ensureDir(vp.app);
  for (const name of ['package.json', 'silero.py', 'src']) fs.cpSync(path.join(template(), name), path.join(vp.app, name), { recursive: true, force: true });
}

/**
 * Собрать ролик: озвучка сцен → длина сцен по голосу → картинка. Возвращает { file, seconds }.
 * Всё вместе — не дольше video.timeout_minutes; рабочие файлы — во временной папке, она удаляется.
 */
export async function buildVideo(cfg, { scenes, name, kind = 'Утренняя сводка', now = new Date(), run = runTool, vp = videoPaths(cfg) }) {
  const missing = videoProblems(cfg, vp);
  if (missing.length) throw new Error(`${missing.map((m) => m.label).join('; ')} — ${missing[0].hint}`);
  const deadline = Date.now() + cfg.video.timeout_minutes * 60_000;
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'mcfly-video-'));
  try {
    syncTemplate(vp);
    const durationsFile = path.join(work, 'durations.json');
    writeJson(path.join(work, 'scenes.json'), Object.fromEntries(scenes.map((s) => [s.key, s.speech])));
    await run(vp.python, ['-I', path.join(vp.app, 'silero.py'), path.join(work, 'scenes.json'), path.join(work, 'public', 'voice'), durationsFile, cfg.video.voice, vp.model], { cwd: work, timeoutMs: deadline - Date.now(), label: 'озвучка' });
    const durations = readJson(durationsFile, null);
    if (!durations || scenes.some((s) => !(durations[s.key] > 0))) throw new Error('озвучка: нет длительностей сцен');
    const props = { project: cfg.project, kind, date: `${now.getDate()} ${MONTHS_GEN[now.getMonth()]}`, scenes: scenes.map((s) => ({ key: s.key, kind: s.kind || 'text', title: s.title, lines: s.lines, chat: s.chat || null, voice: durations[s.key], duration: Math.max(durations[s.key], s.hold || 0) })) };
    writeJson(path.join(work, 'props.json'), props);
    const file = path.join(ensureDir(vp.out), `${name}.mp4`);
    await run(process.execPath, [vp.cli, 'render', 'src/index.jsx', 'Summary', file, `--props=${path.join(work, 'props.json')}`, `--public-dir=${path.join(work, 'public')}`, '--log=error'],
      { cwd: vp.app, timeoutMs: deadline - Date.now(), label: 'сборка ролика' });
    if (!exists(file)) throw new Error('сборка ролика: файл не появился');
    return { file, seconds: Math.round(props.scenes.reduce((n, s) => n + s.duration + 1.2, 0)) };
  } finally { fs.rmSync(work, { recursive: true, force: true }); }
}

/** Старые ролики проекта: оставляем keep последних. */
export function pruneVideos(dir, keep = 8) {
  let files = []; try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.mp4')).sort(); } catch { return; }
  for (const f of files.slice(0, Math.max(0, files.length - keep))) fs.rmSync(path.join(dir, f), { force: true });
}

const mmss = (sec) => `${Math.floor(sec / 60)}:${pad2(sec % 60)}`;

/**
 * Ролик утренней сводки (weekly — недельной, из weeklyData): собрать и отправить ответом на текст сводки. Никогда не бросает исключение — текст уже отправлен.
 * При сбое пишет в чат одну короткую строку, не чаще раза в сутки. Возвращает { sent, file?, error? }.
 */
export async function sendSummaryVideo(p, cfg, { data, tg, now = new Date(), replyTo = null, log = console.log, build = buildVideo, weekly = false } = {}) {
  try {
    const scenes = weekly ? weeklyScenes(data, cfg) : summaryScenes(data, cfg, { now });
    const name = `${weekly ? 'weekly' : 'summary'}-${localDateKey(now)}-${pad2(now.getHours())}${pad2(now.getMinutes())}`;
    const { file, seconds } = await build(cfg, { scenes, name, now, ...(weekly ? { kind: 'Итоги недели' } : {}) });
    await tg.sendVideo(cfg.telegram.chat_id, file, { caption: `🎬 ${weekly ? 'Итоги недели к' : 'Сводка за'} ${pad2(now.getDate())}.${pad2(now.getMonth() + 1)} · ${mmss(seconds)}`, replyTo, duration: seconds, width: 1080, height: 1920 });
    pruneVideos(path.dirname(file));
    log(`Ролик сводки отправлен (${mmss(seconds)}, ${file}).`);
    return { sent: true, file };
  } catch (e) {
    const reason = String(e?.message || e).replace(/\s+/g, ' ').slice(0, 300);
    log(`Ролик сводки не собран: ${reason}`);
    const state = loadState(p); const today = localDateKey(now);
    if (state.video_failed_on !== today) {
      state.video_failed_on = today; saveState(p, state);
      try { await tg.sendMessage(cfg.telegram.chat_id, `🎬 Ролик сводки не собрался: ${reason}. Текст сводки выше — полный. Проверка: mcfly doctor`); } catch (e2) { log(`Сообщение о ролике не отправлено: ${e2?.message || e2}`); }
    }
    return { sent: false, error: reason };
  }
}

/**
 * `mcfly video setup`: приложение Remotion с зависимостями, браузер для сборки, окружение озвучки и модель голоса — в общую папку.
 * Готовое окружение озвучки (см. videoPaths) используется как есть. Запускает владелец в терминале: качает около 2 ГБ.
 */
export async function setupVideo(cfg, { log = console.log, run = runTool, fetchImpl = globalThis.fetch, vp = videoPaths(cfg) } = {}) {
  const hour = 60 * 60_000;
  syncTemplate(vp);
  log(`Ставлю сборщик роликов Remotion в ${vp.app} (около 800 МБ, несколько минут)…`);
  await run('npm', ['install', '--no-audit', '--no-fund'], { cwd: vp.app, timeoutMs: hour, label: 'npm install' });
  await run(process.execPath, [vp.cli, 'browser', 'ensure'], { cwd: vp.app, timeoutMs: hour, label: 'браузер для сборки' });
  if (exists(vp.python)) log(`Окружение озвучки уже есть: ${vp.python}`);
  else {
    const venv = path.join(vp.home, 'venv');
    log(`Ставлю окружение озвучки в ${venv} (около 1 ГБ)…`);
    await run('python3', ['-m', 'venv', venv], { cwd: vp.home, timeoutMs: hour, label: 'python3 -m venv' });
    await run(path.join(venv, 'bin', 'python'), ['-m', 'pip', 'install', '--quiet', 'torch', 'numpy'], { cwd: vp.home, timeoutMs: hour, label: 'pip install torch' });
  }
  if (exists(vp.model)) log(`Модель голоса уже есть: ${vp.model}`);
  else {
    const file = path.join(vp.home, 'models', 'v5_ru.pt');
    log(`Качаю модель голоса ${MODEL_URL}…`);
    const res = await fetchImpl(MODEL_URL);
    if (!res.ok) throw new Error(`модель голоса: HTTP ${res.status}`);
    ensureDir(path.dirname(file)); fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));
  }
  const left = videoProblems(cfg, videoPaths(cfg, { home: vp.home }));
  if (left.length) throw new Error(left.map((m) => m.label).join('; '));
  log('Готово. Включите в mcfly/config.yaml: video.enabled: true; проба — mcfly video build');
}
