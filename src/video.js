import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { exists, ensureDir, readJson, writeJson, pad2, localDateKey } from './util.js';
import { MCFLY_ROOT } from './prompt.js';
import { loadState, saveState } from './state.js';
import { speakable, clipSentences, numWords, plural, dateWords, MONTHS_GEN } from './speech.js';

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

/**
 * Сцены ролика из частей сводки (summaryData): у каждой — заголовок и строки на экран и текст диктору.
 * Диктору идут только русские слова (speakable), на экране текст остаётся как в сводке.
 */
export function summaryScenes(data, cfg, { now = new Date() } = {}) {
  const say = (t) => speakable(t, cfg.video.pronounce);
  const day = now.getDate(); const month = now.getMonth() + 1;
  const scenes = [];
  const add = (title, lines, speech) => scenes.push({ key: `s${scenes.length}`, title, lines: lines.filter(Boolean), speech: say(speech) });
  add(cfg.project, ['Утренняя сводка', `${day} ${MONTHS_GEN[month - 1]}`], `Доброе утро. Сводка по проекту ${cfg.project} от ${dateWords(day, month)}.`);

  // Дела владельца — сразу после заставки. Одобрения, вопросы и решения по спискам в ролик не идут (0.12.0, решение владельца):
  // они решаются кнопками под текстом сводки, а перечень номеров на слух и на экране ролика бесполезен.
  const todo = (data.todo || []).map(plain).map(noIds).filter(Boolean);
  if (todo.length) {
    const shown = todo.slice(0, 4).map((x, i) => `${i + 1}. ${clipSentences(x, 120)}`);
    if (todo.length > 4) shown.push(`…и ещё ${todo.length - 4}`);
    const first = clipSentences(todo[0], 160);
    const count = `${numWords(todo.length, 'n')} ${plural(todo.length, ['дело', 'дела', 'дел'])}`;
    add(`Нужно сделать: ${todo.length}`, shown, `От вас нужно ${count}. ${todo.length > 1 ? 'Первое' : 'Вот оно'}: ${first}${/[.!?…]$/.test(first) ? '' : '.'}${todo.length > 1 ? ' Остальное — на экране и в сообщении.' : ''}`);
  }

  const stats = Object.entries(data.runStats).filter(([, n]) => n > 0);
  const total = stats.reduce((n, [, c]) => n + c, 0);
  const runLines = stats.map(([st, n]) => `${SHOWN[st] || st} — ${n}`);
  if (data.running) runLines.push('▶️ один идёт сейчас');
  if (total) add(`${total} ${plural(total, RUNS)}`, runLines, `${plural(total, ['Был', 'Было', 'Было'])} ${numWords(total)} ${plural(total, RUNS)}: ${stats.map(([st, n]) => `${SPOKEN[st] || 'с другим исходом'} — ${numWords(n)}`).join(', ')}.${data.running ? ' Ещё один идёт сейчас.' : ''}`);
  else add('Прогонов не было', data.running ? ['▶️ один идёт сейчас'] : [], data.running ? 'Законченных прогонов не было, один идёт сейчас.' : 'Прогонов не было.');

  // Пересказ последнего прогона: на него уходит всё время, что осталось от остальных сцен
  // Что дальше — названиями, без номеров; «одобрите» и «выберите» сюда не попадают
  const titles = (data.work || []).map((w) => ({ title: noIds(plain(w.title)).replace(/^«|»$/g, ''), progress: plain(w.progress) })).filter((w) => w.title);
  const next = titles.length ? `Команда продолжит: ${titles.slice(0, 2).map((w) => `${w.title} — ${w.progress}`).join('; ')}`
    : data.work?.length ? 'Команда продолжит начатое' : data.planning ? 'Команда составит план по взятым предложениям' : 'Работы в очереди у команды нет';
  const nextSpeech = `Дальше. ${clipSentences(next, 180)}. Хорошего дня.`;
  const last = data.plain[data.plain.length - 1];
  if (last) {
    const para = (lead) => (last.text.split('\n').find((l) => l.startsWith(`${lead}:`)) || '').slice(lead.length + 1).trim();
    const raw = noIds(para('Что сделано') || last.text.replace(/\n/g, ' '));
    const done = raw.charAt(0).toUpperCase() + raw.slice(1);
    const used = scenes.reduce((n, s) => n + s.speech.length, 0) + say(nextSpeech).length;
    const room = Math.max(160, cfg.video.max_seconds * CHARS_PER_SECOND - used);
    add('Что сделано', [clipSentences(done, 330)], `Что сделано. ${clipSentences(done, Math.min(room, 420))}`);
  }
  add('Что дальше', titles.length ? titles.slice(0, 2).map((w) => `${clipSentences(w.title, 110)} — ${w.progress}`) : [next], nextSpeech);
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
    const props = { project: cfg.project, kind, date: `${now.getDate()} ${MONTHS_GEN[now.getMonth()]}`, scenes: scenes.map((s) => ({ key: s.key, title: s.title, lines: s.lines, duration: durations[s.key] })) };
    writeJson(path.join(work, 'props.json'), props);
    const file = path.join(ensureDir(vp.out), `${name}.mp4`);
    await run(process.execPath, [vp.cli, 'render', 'src/index.jsx', 'Summary', file, `--props=${path.join(work, 'props.json')}`, `--public-dir=${path.join(work, 'public')}`, '--log=error'],
      { cwd: vp.app, timeoutMs: deadline - Date.now(), label: 'сборка ролика' });
    if (!exists(file)) throw new Error('сборка ролика: файл не появился');
    return { file, seconds: Math.round(scenes.reduce((n, s) => n + durations[s.key] + 1.2, 0)) };
  } finally { fs.rmSync(work, { recursive: true, force: true }); }
}

/** Старые ролики проекта: оставляем keep последних. */
export function pruneVideos(dir, keep = 5) {
  let files = []; try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.mp4')).sort(); } catch { return; }
  for (const f of files.slice(0, Math.max(0, files.length - keep))) fs.rmSync(path.join(dir, f), { force: true });
}

const mmss = (sec) => `${Math.floor(sec / 60)}:${pad2(sec % 60)}`;

/**
 * Ролик утренней сводки: собрать и отправить ответом на текст сводки. Никогда не бросает исключение — текст уже отправлен.
 * При сбое пишет в чат одну короткую строку, не чаще раза в сутки. Возвращает { sent, file?, error? }.
 */
export async function sendSummaryVideo(p, cfg, { data, tg, now = new Date(), replyTo = null, log = console.log, build = buildVideo } = {}) {
  try {
    const scenes = summaryScenes(data, cfg, { now });
    const name = `summary-${localDateKey(now)}-${pad2(now.getHours())}${pad2(now.getMinutes())}`;
    const { file, seconds } = await build(cfg, { scenes, name, now });
    await tg.sendVideo(cfg.telegram.chat_id, file, { caption: `🎬 Сводка за ${pad2(now.getDate())}.${pad2(now.getMonth() + 1)} · ${mmss(seconds)}`, replyTo, duration: seconds, width: 1080, height: 1920 });
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
