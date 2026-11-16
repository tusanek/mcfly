import { speakable } from './speech.js';

// 0.15.0: раскадровку ролика-сводки пишет роль-режиссёр. Здесь — правила, которые проверяет код: виды сцен, пределы текста,
// запреты владельца (номера пунктов, одобрения и кнопки бота, выдуманные сообщения бота), длина и темп. Плюс разбор замечаний зрителя.

export const SCENE_KINDS = ['text', 'chat', 'hook', 'number', 'compare', 'steps', 'finale'];
export const SCENE_ENTER = ['up', 'left', 'scale', 'fade'];
export const CHARS_PER_SECOND = 14; // темп диктора при скорости 1
export const SCENE_GAP = 0.4; // секунд между сценами: хвост после речи и задержка голоса
const SCREEN_LIMIT = { text: 420, chat: 120, hook: 160, finale: 200, number: 160, compare: 120, steps: 420 };
const SCREEN_PER_SPEECH = 1.5; // знаков на экране на знак речи: больше — не успеть прочитать, пока говорит диктор
const CHAT_SPEECH_MIN = 56; // речь к экрану чата — около четырёх секунд
// Оформление (необязательно): что из этого рисует шаблон — см. video/src/Daily.jsx и Weekly.jsx
export const SCENE_ACCENTS = ['amber', 'mint', 'sky', 'coral', 'violet'];
export const SCENE_STYLES = ['note', 'bubbles', 'checks'];
export const SCENE_ICONS = ['mic', 'moon', 'sun', 'bell', 'repeat', 'calendar', 'shield', 'edit', 'undo', 'flag', 'spark', 'pulse', 'arrow', 'check', 'chat'];
const TEXT_FIELDS = ['tag', 'mark'];
const IDS = /(?<![\p{L}\p{N}])[A-Z]\d+(?![\p{L}\p{N}])/u;
const IN_BOT = /кнопк|одобр|в боте/i;

const norm = (t) => String(t).replace(/\s+/g, ' ').trim();
const isObj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
const str = (x) => typeof x === 'string';
/** Список сцен из того, что написал режиссёр: сам список или { scenes }. */
export const sceneList = (raw) => (Array.isArray(raw) ? raw : isObj(raw) && Array.isArray(raw.scenes) ? raw.scenes : null);

/** Образцы экрана чата в данных сводки: утром — demos, в недельной — features[].sample. */
function samples(data, weekly) {
  const list = weekly ? (data?.features || []).map((f) => f?.sample).filter(Boolean) : (data?.demos || []);
  return {
    lines: new Set(list.flatMap((s) => String(s?.text ?? '').split('\n').map(norm)).filter(Boolean)),
    buttons: new Set(list.flatMap((s) => (Array.isArray(s?.buttons) ? s.buttons.flat() : [])).map(norm)),
  };
}

/** Знаки, которые зритель читает с экрана: заголовок, строки, «было — стало», подпись цифры. Сообщение в чате не считается. */
const screenChars = (s) => [s.title, ...(Array.isArray(s.lines) ? s.lines : []), s.compare?.before, s.compare?.after, s.number?.label].filter(str).join(' ').length;

/**
 * Проверка раскадровки режиссёра. Возвращает нарушения простыми словами (их читает режиссёр при повторе); пусто — принята.
 * Никогда не бросает: на вход может прийти что угодно.
 */
export function checkStoryboard(raw, data, cfg, { weekly = false } = {}) {
  const scenes = sceneList(raw);
  if (!scenes) return ['раскадровка — список сцен (или { "scenes": [...] })'];
  if (scenes.length < 3) return ['нужен список не меньше чем из трёх сцен'];
  const errors = [];
  if (scenes.length > 16) errors.push(`сцен ${scenes.length}, больше 16 — ролик рассыпается`);
  const sample = samples(data, weekly);
  const speed = cfg.video.voice_speed || 1;
  let chars = 0;
  scenes.forEach((s, i) => {
    const at = `сцена ${i + 1}`;
    if (!isObj(s)) { errors.push(`${at}: сцена — объект с полями kind, title, lines, speech`); return; }
    if (!SCENE_KINDS.includes(s.kind)) errors.push(`${at}: неизвестный вид «${s.kind}» (есть: ${SCENE_KINDS.join(', ')})`);
    if (s.enter != null && !SCENE_ENTER.includes(s.enter)) errors.push(`${at}: неизвестное появление «${s.enter}» (есть: ${SCENE_ENTER.join(', ')})`);
    if (!str(s.title) || !s.title.trim()) errors.push(`${at}: нет заголовка`);
    else if (s.title.length > 90) errors.push(`${at}: заголовок длиннее 90 знаков`);
    const lines = Array.isArray(s.lines) && s.lines.every(str) ? s.lines : null;
    if (!lines) errors.push(`${at}: lines — список строк (можно пустой)`);
    else {
      const total = lines.join(' ').length; const limit = SCREEN_LIMIT[s.kind] ?? 420;
      if (total > limit) errors.push(`${at}: текста на экране ${total} знаков, для вида «${s.kind}» не больше ${limit}`);
      if (s.kind === 'steps' && (lines.length < 2 || lines.length > 6)) errors.push(`${at}: в «steps» от 2 до 6 строк`);
    }
    if (s.accent != null && !(SCENE_ACCENTS.includes(s.accent) || (str(s.accent) && /^#[0-9a-f]{6}$/i.test(s.accent)))) errors.push(`${at}: accent — один из ${SCENE_ACCENTS.join(', ')} или цвет вида #rrggbb`);
    if (s.style != null && !SCENE_STYLES.includes(s.style)) errors.push(`${at}: style — один из ${SCENE_STYLES.join(', ')}`);
    if (s.icon != null && !SCENE_ICONS.includes(s.icon)) errors.push(`${at}: icon — один из ${SCENE_ICONS.join(', ')}`);
    for (const f of TEXT_FIELDS) if (s[f] != null && !(str(s[f]) && s[f].length <= 24)) errors.push(`${at}: ${f} — строка до 24 знаков`);
    if (s.kind === 'number' && !(isObj(s.number) && Number.isFinite(Number(s.number.value)) && str(s.number.label))) errors.push(`${at}: «number» требует number: { value: число, label: подпись, unit?: знак }`);
    if (s.kind === 'compare' && !(isObj(s.compare) && str(s.compare.before) && str(s.compare.after) && (s.compare.before + s.compare.after).length <= 300)) errors.push(`${at}: «compare» требует compare: { before, after }, вместе до 300 знаков`);
    if (s.bar != null && !(isObj(s.bar) && Number(s.bar.total) > 0 && Number(s.bar.done) >= 0)) errors.push(`${at}: bar: { done, total }, total больше нуля`);
    if (s.kind === 'chat') {
      if (!isObj(s.chat) || !str(s.chat.text) || !Array.isArray(s.chat.buttons) || !s.chat.buttons.every((r) => Array.isArray(r) && r.every(str))) errors.push(`${at}: «chat» требует chat: { text, buttons: [[подписи]] }`);
      else {
        if (s.chat.text.length > 520 || s.chat.text.split('\n').length > 14) errors.push(`${at}: сообщение в чате — до 520 знаков и 14 строк`);
        const alien = s.chat.text.split('\n').map(norm).filter((l) => l && !sample.lines.has(l));
        if (alien.length) errors.push(`${at}: строки чата не из образцов в данных (сообщения бота не выдумываем): «${alien[0].slice(0, 60)}»`);
        const fake = s.chat.buttons.flat().map(norm).filter((b) => !sample.buttons.has(b));
        if (fake.length) errors.push(`${at}: кнопка не из образцов в данных: «${fake[0].slice(0, 40)}»`);
        if (s.chat.buttons.length > 3 || s.chat.buttons.some((r) => r.length > 4)) errors.push(`${at}: кнопок — до 3 рядов по 4`);
      }
    }
    if (!str(s.speech) || s.speech.trim().length < 8) { errors.push(`${at}: нет текста диктора`); return; }
    const spoken = speakable(s.speech, cfg.video.pronounce).length;
    chars += spoken;
    if (IDS.test([s.speech, s.title, ...(lines || [])].join(' '))) errors.push(`${at}: номера пунктов и вопросов (I22, Q4) в ролик не идут`);
    if (IN_BOT.test(s.speech)) errors.push(`${at}: диктор не говорит про то, что решается кнопкой в боте, и про одобрения`);
    if (s.kind === 'chat' && spoken < CHAT_SPEECH_MIN) errors.push(`${at}: мало речи для экрана чата — диктор говорит всё время показа, нужно не меньше ${CHAT_SPEECH_MIN} знаков`);
    else if (screenChars(s) > spoken * SCREEN_PER_SPEECH) errors.push(`${at}: мало речи для такого экрана (на экране ${screenChars(s)} знаков, речи ${spoken}): сократите экран или дополните речь`);
  });
  const limit = weekly ? cfg.video.weekly_max_seconds : cfg.video.max_seconds;
  const seconds = Math.round(chars / (CHARS_PER_SECOND * speed) + scenes.length * SCENE_GAP);
  if (seconds > limit * 1.1) errors.push(`текста диктора на ~${seconds} с, лимит ролика ${limit} с — сократите`);
  return errors;
}

/** Принятая раскадровка → сцены сборщика: ключи, речь только русскими словами, без времени «на чтение». */
export function toScenes(raw, cfg) {
  return sceneList(raw).map((s, i) => ({ ...s, key: `s${i}`, speech: speakable(s.speech, cfg.video.pronounce), hold: 0 }));
}

/**
 * Замечания зрителя из его ответа: первый массив JSON в тексте, не больше шести.
 * Замечание: { scene: номер с единицы, kind: 'fact' (утверждение без опоры в данных) | 'view', problem, fix }. Не разобрался — пусто.
 */
export function parseRemarks(text) {
  const t = String(text ?? ''); const from = t.indexOf('['); const to = t.lastIndexOf(']');
  if (from < 0 || to <= from) return [];
  let list; try { list = JSON.parse(t.slice(from, to + 1)); } catch { return []; }
  if (!Array.isArray(list)) return [];
  return list.filter((r) => isObj(r) && Number.isInteger(r.scene) && r.scene >= 1)
    .map((r) => ({ scene: r.scene, kind: r.kind === 'fact' ? 'fact' : 'view', problem: String(r.problem ?? '').slice(0, 400), fix: String(r.fix ?? '').slice(0, 400) })).slice(0, 6);
}

const same = (a, b) => a.title === b.title && a.speech === b.speech && JSON.stringify(a.lines) === JSON.stringify(b.lines);

/**
 * Раскадровка после круга правок. Сцена с замечанием 'fact' должна измениться или исчезнуть: оставшаяся дословно вырезается.
 * after — исправленная раскадровка, принятая проверкой, или null (правки нет или она не принята): тогда исходная без таких сцен.
 */
export function applyRemarks(before, after, remarks) {
  const flagged = remarks.filter((r) => r.kind === 'fact').map((r) => before[r.scene - 1]).filter(Boolean);
  return (after || before).filter((s) => !flagged.some((f) => same(f, s)));
}
