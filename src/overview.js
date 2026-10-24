import path from 'node:path';
import fs from 'node:fs';
import { readText, writeText, fmtShort, fmtDuration, truncate, pad2 } from './util.js';
import { readMetrics, aggregate } from './metrics.js';
import { loadQuestions, openQuestions } from './questions.js';
import { listChanges, pendingApprovals, approvedWithWork, approvalDeadline, isAutoApprovable } from './approvals.js';
import { autoDefault } from './config.js';
import { parseSlot } from './window.js';
import { currentRun } from './runner.js';
import { hasActions, listActions } from './action-config.js';
import { currentAction, offerKeyboard } from './actions.js';
import { escHtml, inline, splitHtml, reportSections, plainWords, humanItems, approvalCovered, isNone, changeProgress, nextRunText, runsByStatus, STATUS_RU } from './summary.js';

/**
 * Команды обзора для владельца в Telegram: «где мы», «цели», «статистика», «последний прогон», «помощь».
 * Только читают состояние проекта — ничего не пишут в answers.md, не трогают вопросы и одобрения, не запускают прогон.
 */
const VIEW_WORDS = {
  status: ['/status', 'где мы', 'где мы сейчас', 'статус'],
  goals: ['/goals', 'цели', 'цель'],
  stats: ['/stats', 'статистика'],
  last: ['/last', 'последний прогон'],
  help: ['/help', '/start', 'помощь', 'справка'],
};
/** Текст команды без эмодзи кнопки в начале, «@имя_бота» после /команды, регистра, «ё» и знаков в конце: «📍 Где мы?» → «где мы». */
export const commandText = (text) => String(text || '').trim().replace(/^[^\p{L}\p{N}/]+/u, '').replace(/^(\/\w+)@\w+/, '$1')
  .toLowerCase().replace(/ё/g, 'е').replace(/[\s?!.]+$/u, '').replace(/\s+/g, ' ');
/** Имя обзора (status, goals, stats, last, help) или null: сообщение целиком должно быть командой, «статус по X» — заметка. */
export function viewOf(text) {
  const t = commandText(text);
  return Object.keys(VIEW_WORDS).find((v) => VIEW_WORDS[v].includes(t)) || null;
}

/** Меню команд Telegram (setMyCommands): латиница в нижнем регистре, описание до 256 символов. */
export const BOT_COMMANDS = [
  { command: 'status', description: '📍 Где мы: прогон, изменения, вопросы, квота' },
  { command: 'goals', description: '🎯 Цели проекта и чек-лист до MVP' },
  { command: 'stats', description: '📊 Статистика за 7 дней и всего' },
  { command: 'last', description: '📰 Последний прогон простыми словами' },
  { command: 'run', description: '▶️ Запустить прогон' },
  { command: 'help', description: '❓ Все команды с примерами' },
];
const ACTIONS_COMMAND = { command: 'actions', description: '🛠 Действия: выкат, откат и другое — с подтверждением' };
/** Меню «/» проекта: с действиями — ещё /actions перед /help. */
export const botCommands = (cfg) => (hasActions(cfg) ? [...BOT_COMMANDS.slice(0, -1), ACTIONS_COMMAND, BOT_COMMANDS.at(-1)] : BOT_COMMANDS);
/** Постоянная клавиатура внизу чата: нажатие отправляет текст кнопки, как если бы его написали. */
export const MAIN_KEYBOARD = [[{ text: '📍 Где мы' }, { text: '🎯 Цели' }], [{ text: '📊 Статистика' }, { text: '▶️ Запусти' }]];
/** Клавиатура проекта: с действиями (раздел actions) — третий ряд «🛠 Действия». */
export const mainKeyboard = (cfg) => (hasActions(cfg) ? [...MAIN_KEYBOARD, [{ text: '🛠 Действия' }]] : MAIN_KEYBOARD);
/** Ревизия меню: другая — задание answers один раз обновит меню и пришлёт клавиатуру (метка в mcfly/logs, она вне git). */
export const MENU_REV = '0.6.0';
/** Ревизия с учётом действий: появились или пропали — меню и клавиатура обновятся. */
const menuRev = (cfg) => `${MENU_REV}${hasActions(cfg) ? '+actions' : ''}`;
const menuMark = (p) => path.join(p.logs, '.bot-menu');

const MAX = 4000; // предел сообщения Telegram 4096 символов — с запасом
const ITEM_MAX = 220;
const NEED_MAX = 8;
const at = (d) => fmtShort(new Date(d));
const pct = (x) => Math.round(Number(x) * 100);

function runs(p) { return readMetrics(p).filter((r) => r.type === 'run'); }
/** Строка о прогоне: «22.10 14:50 (слот 02:00) — ок, 24 мин, ~$3.58». */
function runBrief(r) {
  const extra = [r.duration_ms ? fmtDuration(r.duration_ms) : '', r.cost_usd != null ? `~$${Number(r.cost_usd).toFixed(2)}` : ''].filter(Boolean);
  return `${at(r.started_at)}${r.slot ? ` (слот ${r.slot})` : ''} — ${STATUS_RU[r.status] || r.status}${extra.length ? `, ${extra.join(', ')}` : ''}`;
}
/** Самый свежий отчёт репортёра: { id, sec, record } по каталогам mcfly/runs (авто-сводки runner'а пропускаются) или null. */
export function latestReport(p) {
  let ids = [];
  try { ids = fs.readdirSync(p.runs).filter((d) => /^\d{8}-\d{4}/.test(d)).sort().reverse(); } catch {}
  const records = runs(p);
  for (const id of ids) {
    const sec = reportSections(readText(path.join(p.runs, id, 'summary.md'), ''));
    if (sec) return { id, sec, record: records.findLast((r) => r.id === id) || null };
  }
  return null;
}
/** Ближайший запуск по расписанию после now: Date. */
export function nextSlot(slots, now = new Date()) {
  const out = [];
  for (const day of [0, 1]) {
    for (const s of slots) {
      const m = parseSlot(s);
      const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + day, Math.floor(m / 60), m % 60);
      if (d > now) out.push(d);
    }
  }
  return out.sort((a, b) => a - b)[0] || null;
}
/** Последние известные лимиты подписки и когда они замерены: { usage, at } или null. */
export function lastUsageAt(p) {
  const r = runs(p).filter((x) => x.usage && x.usage.seven_day != null).at(-1);
  return r ? { usage: r.usage, at: new Date(r.ended_at || r.started_at) } : null;
}
const changeLine = (p, cfg, c) => {
  const st = c.mcfly.approval;
  if (st === 'pending') return `⏳ <b>${escHtml(c.name)}</b> — ждёт одобрения${isAutoApprovable(c, cfg) ? ` (авто-одобрение ${fmtShort(approvalDeadline(c, cfg))})` : ''}`;
  if (st === 'rejected') return `⛔ ${escHtml(c.name)} — отклонено`;
  if (st === 'approved') return `${c.tasksOpen > 0 ? '🔧' : '🏁'} <b>${escHtml(c.name)}</b> — одобрено, задач ${changeProgress(p.projectDir, c)}`;
  return `⚪ ${escHtml(c.name)} — одобрение не запрошено, задач ${changeProgress(p.projectDir, c)}`;
};
const toParts = (html) => splitHtml(html, MAX);

/** 📍 Где мы: прогон, изменения, вопросы, «Нужно от вас», следующий прогон и квота. Возвращает куски HTML ≤ 4000 символов. */
export function statusView(p, cfg, { now = new Date() } = {}) {
  const L = [`📍 <b>Где мы · ${escHtml(cfg.project)}</b> · ${fmtShort(now)}`, ''];
  const cur = currentRun(p);
  const last = runs(p).at(-1);
  if (cur) L.push(`▶️ <b>Идёт прогон</b> ${escHtml(cur.id || '')} с ${fmtShort(cur.since)}${cur.lastEvent ? `\nПоследнее действие: ${escHtml(truncate(cur.lastEvent, 300))}` : ''}`);
  else L.push(`💤 Прогон сейчас не идёт.${last ? ` Последний: ${escHtml(runBrief(last))}` : ' Прогонов ещё не было.'}`);
  const act = currentAction(p);
  if (act) L.push(`🛠 <b>Идёт действие</b> «${escHtml(act.title || act.id)}» с ${fmtShort(act.since)} — итог придёт сообщением`);

  const changes = listChanges(p.openspecChanges);
  L.push('', `<b>📦 Изменения (${changes.length})</b>`, ...(changes.length ? changes.map((c) => changeLine(p, cfg, c)) : ['Открытых изменений нет']));

  const q = openQuestions(loadQuestions(p));
  if (q.length) {
    L.push('', `<b>❓ Открытые вопросы (${q.length})</b>`);
    for (const x of q) {
      L.push(`<b>${escHtml(x.id)}</b>: ${escHtml(truncate(String(x.text || '').replace(/\s+/g, ' '), ITEM_MAX))}`);
      L.push(autoDefault(cfg, x.category) && x.default ? `   по умолчанию «${escHtml(truncate(String(x.default), 120))}» с ${at(x.deadline_at)}` : '   без ответа по умолчанию — команда ждёт вас');
    }
  } else L.push('', '❓ Открытых вопросов нет');

  const rep = latestReport(p);
  const need = rep ? humanItems(rep.sec).filter((x) => !isNone(x) && !approvalCovered(x, changes)) : [];
  if (need.length) {
    L.push('', `<b>🙋 Нужно от вас</b> <i>(отчёт ${escHtml(rep.record ? at(rep.record.started_at) : rep.id)})</i>`);
    L.push(...need.slice(0, NEED_MAX).map((x, i) => `${i + 1}. ${inline(truncate(x, ITEM_MAX))}`));
    if (need.length > NEED_MAX) L.push(`… ещё ${need.length - NEED_MAX} — «последний прогон»`);
  }

  const slot = nextSlot(cfg.schedule.slots, now);
  const plan = nextRunText(approvedWithWork(changes), pendingApprovals(changes), (c) => changeProgress(p.projectDir, c), escHtml);
  L.push('', `<b>🗓 Следующий прогон:</b> ${slot ? `${fmtShort(slot)} по расписанию` : 'расписания нет'} — ${plan}`);

  const u = lastUsageAt(p);
  if (u) {
    const parts = [];
    if (u.usage.five_hour != null) parts.push(`5 часов — занято ${pct(u.usage.five_hour)} %, осталось ${100 - pct(u.usage.five_hour)} %`);
    parts.push(`неделя — занято ${pct(u.usage.seven_day)} %, осталось ${100 - pct(u.usage.seven_day)} %`);
    L.push(`<b>⛽ Квота подписки:</b> ${parts.join('; ')} <i>(замер ${fmtShort(u.at)})</i>`);
  } else L.push('⛽ Квота подписки: замеров ещё нет — появятся после прогона');
  return toParts(L.join('\n'));
}

/** Цели из mcfly/goals.md: { goal, milestone, items: [{ done, text, group }] } или null, если файла нет. */
export function parseGoals(text) {
  if (!String(text || '').trim()) return null;
  const g = { goal: [], milestone: [], items: [] };
  let cur = null; let group = '';
  for (const line of String(text).replace(/<!--[\s\S]*?-->/g, '').split('\n')) {
    const h = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (h) {
      if (h[1].length === 1) { cur = null; continue; }
      const t = h[2].toLowerCase();
      cur = /вех/.test(t) ? 'milestone' : /^цел/.test(t) ? 'goal' : 'list';
      if (cur === 'list') group = h[2];
      continue;
    }
    const item = /^\s*[-*+]\s+\[([ xX])\]\s+(.+?)\s*$/.exec(line);
    if (item) { g.items.push({ done: item[1] !== ' ', text: item[2], group }); continue; }
    if (line.trim() && (cur === 'goal' || cur === 'milestone')) g[cur].push(line.trim().replace(/^[-*+]\s+/, ''));
  }
  return g;
}
const GOALS_HINT = [
  '🎯 <b>Цели проекта не заданы</b>',
  '',
  'Создайте в репозитории проекта файл <code>mcfly/goals.md</code>, например:',
  '<pre>## Цель\nЧто делаем и для кого — одним-двумя предложениями.\n\n## Ближайшая веха\nПоказ MVP в декабре.\n\n## До MVP\n- [x] сделанный пункт\n- [ ] следующий пункт</pre>',
  'Отмечайте сделанное «- [x]» — бот посчитает «сделано N из M». Файл ведёте вы, команда его не меняет.',
].join('\n');
const bar = (done, total) => { const n = total ? Math.round((done / total) * 10) : 0; return '▰'.repeat(n) + '▱'.repeat(10 - n); };

/** 🎯 Цели: цель, ближайшая веха и чек-лист «сделано N из M» из mcfly/goals.md. */
export function goalsView(p, cfg) {
  const g = parseGoals(readText(path.join(p.root, 'goals.md'), ''));
  if (!g) return toParts(GOALS_HINT);
  const head = [`🎯 <b>Цели · ${escHtml(cfg.project)}</b>`];
  if (g.goal.length) head.push('', `<b>Цель:</b> ${inline(g.goal.join(' '))}`);
  if (g.milestone.length) head.push('', `<b>Ближайшая веха:</b> ${inline(g.milestone.join(' '))}`);
  const done = g.items.filter((x) => x.done).length; const total = g.items.length;
  if (!total) return toParts([...head, '', 'Чек-листа нет: добавьте пункты «- [ ] …» в mcfly/goals.md'].join('\n'));
  const groups = new Set(g.items.map((x) => x.group)).size > 1;
  const list = (items) => {
    const out = []; let grp = null;
    for (const x of items) {
      if (groups && x.group !== grp) { grp = x.group; out.push(`<b>${escHtml(grp)}</b>`); }
      out.push(`${x.done ? '✅' : '⬜'} ${inline(truncate(x.text, ITEM_MAX))}`);
    }
    return out;
  };
  const top = [...head, '', `<b>Сделано ${done} из ${total}</b> ${bar(done, total)} ${Math.round((done / total) * 100)} %`, ''];
  let html = [...top, ...list(g.items)].join('\n');
  // Не влезает в одно сообщение — сделанные пункты одной строкой, открытые остаются целиком.
  if (html.length > MAX) html = [...top, ...list(g.items.filter((x) => !x.done)), ...(done ? [`✅ … и ещё ${done} сделанных — в mcfly/goals.md`] : [])].join('\n');
  return toParts(html);
}

/** 📊 Статистика: прогоны по статусам, задачи, изменения, возвраты с ревью и расход — за 7 дней и всего. */
export function statsView(p, cfg, { now = new Date() } = {}) {
  const records = readMetrics(p);
  const first = records.map((r) => new Date(r.started_at || r.at || 0)).filter((d) => d.getTime() > 0).sort((a, b) => a - b)[0];
  const block = (title, agg) => {
    const ev = agg.events;
    return [
      `<b>${title}</b>`,
      `🌙 ${escHtml(runsByStatus(agg))}`,
      `✅ задач закрыто: ${ev.tasks_done || 0}`,
      `🏁 изменений влито и в архиве: ${ev.changes_archived || 0} (предложено ${ev.changes_proposed || 0})`,
      `↩️ возвратов с ревью: ${ev.review_rejections || 0}${ev.tests_failed ? `, падений тестов: ${ev.tests_failed}` : ''}`,
      `❓ вопросов к вам: ${ev.escalations || 0}`,
      `💵 расход: ~$${agg.cost_usd}`,
    ];
  };
  const week = aggregate(records, { since: new Date(now.getTime() - 7 * 24 * 3600_000) });
  const all = aggregate(records);
  const L = [`📊 <b>Статистика · ${escHtml(cfg.project)}</b>`, '', ...block('За 7 дней', week), '', ...block(`Всего${first ? ` (с ${pad2(first.getDate())}.${pad2(first.getMonth() + 1)}.${first.getFullYear()})` : ''}`, all)];
  L.push('', '<i>Расход — оценка Claude Code по ценам API; при подписке это мерило объёма работы, а не счёт.</i>');
  return toParts(L.join('\n'));
}

/** 📰 Последний прогон: «Простыми словами», «Сделано» и «Нужно от вас» самого свежего отчёта. */
export function lastView(p, cfg) {
  const rep = latestReport(p);
  if (!rep) return toParts('📰 Отчётов прогонов пока нет — первый появится после прогона команды.');
  const L = [`📰 <b>Последний прогон · ${escHtml(cfg.project)}</b>`, rep.record ? escHtml(runBrief(rep.record)) : `прогон ${escHtml(rep.id)}`];
  const newer = runs(p).filter((r) => rep.record ? new Date(r.started_at) > new Date(rep.record.started_at) : r.id > rep.id);
  if (newer.length) L.push(`<i>После него ещё прогонов без отчёта: ${newer.length}, последний ${escHtml(runBrief(newer.at(-1)))}</i>`);
  const plain = plainWords(rep.sec, 1500);
  if (plain) L.push('', '<b>🗣 Простыми словами</b>', escHtml(plain));
  const done = (rep.sec['Сделано'] || []).filter((l) => !isNone(l));
  const need = humanItems(rep.sec);
  const tail = need.length ? ['', '<b>🙋 Нужно от вас</b>', ...need.map((x, i) => `${i + 1}. ${inline(truncate(x, ITEM_MAX))}`)] : ['', '🙋 От вас ничего не нужно'];
  const doneLines = (n) => (done.length ? ['', '<b>✅ Сделано</b>', ...done.slice(0, n).map((l) => `• ${inline(truncate(l, ITEM_MAX))}`), ...(done.length > n ? [`• … ещё ${done.length - n} — mcfly/runs/${escHtml(rep.id)}/summary.md`] : [])] : []);
  // «Нужно от вас» важнее — если не влезает, урезается «Сделано».
  let n = done.length; let html;
  do { html = [...L, ...doneLines(n), ...tail].join('\n'); n -= 1; } while (html.length > MAX && n >= 0);
  return toParts(html);
}

/** ❓ Помощь: все команды бота с примерами. */
export function helpView(p, cfg) {
  const start = cfg.run.telegram_start === false
    ? '▶️ «запусти» — записать просьбу о прогоне (запуск из Telegram выключен: run.telegram_start: false)'
    : '▶️ «запусти» — прогон сейчас; если работы нет, а изменение ждёт одобрения, бот предложит одобрить его кнопкой\n«запусти всё равно» — прогон без одобрения, например чтобы команда прочла заметку';
  return toParts([
    `❓ <b>Что умеет бот mcfly · ${escHtml(cfg.project)}</b>`,
    '',
    '<b>Посмотреть</b> (ничего не меняет)',
    '📍 «где мы» или /status — идёт ли прогон, изменения и их задачи, вопросы, что нужно от вас, следующий прогон, квота',
    '🎯 «цели» или /goals — цель проекта, ближайшая веха и чек-лист до MVP (файл mcfly/goals.md)',
    '📊 «статистика» или /stats — прогоны, задачи, изменения, возвраты с ревью и расход за 7 дней и всего',
    '📰 «последний прогон» или /last — пересказ простыми словами, что сделано и что нужно от вас',
    '❓ «помощь» или /help — это сообщение',
    '',
    '<b>Управлять</b>',
    start,
    '✅ «одобряю имя-изменения» — разрешить команде делать изменение, например «одобряю site-design»',
    '⛔ «отклоняю имя-изменения причина» — отказать, например «отклоняю site-design не сейчас»',
    '💬 «Q12: ответ» — ответ на вопрос команды; «Q12: по умолчанию» — согласиться с ответом по умолчанию',
    '↩️ Ответ свайпом на сообщение с одним вопросом — ответ на этот вопрос, «Q12:» писать не нужно',
    '📝 Любой другой текст — заметка команде, её прочтёт ближайший прогон',
    ...(hasActions(cfg) ? ['', '<b>Действия</b> (раздел actions в mcfly/config.yaml)', `🛠 «действия» или /actions — ${listActions(cfg).map((a) => escHtml(a.title)).join(', ')}; каждое с подтверждением «✅ Да, выполнить», итог приходит сообщением`] : []),
    '',
    '<i>Кнопки под сводкой — те же одобрения и ответы одним нажатием. Кнопки внизу чата и меню «/» — команды выше.</i>',
  ].join('\n'));
}

const VIEWS = { status: statusView, goals: goalsView, stats: statsView, last: lastView, help: helpView };
/** Куски HTML ответа на команду обзора view. */
export function renderView(view, p, cfg, opts = {}) { return VIEWS[view](p, cfg, opts); }

/** Отправляет ответ на команду обзора с постоянной клавиатурой внизу чата. */
export async function sendView(tg, chatId, view, p, cfg, opts = {}) {
  for (const part of renderView(view, p, cfg, opts)) await tg.sendMessage(chatId, part, { html: true, replyKeyboard: mainKeyboard(cfg) });
  // «где мы» с действиями: отдельным сообщением кнопки того, что можно сделать сейчас (offer вернул 0) — у одного сообщения одна клавиатура
  if (view === 'status' && hasActions(cfg)) {
    const rows = (opts.offerKeyboard || offerKeyboard)(p, cfg);
    if (rows.length) await tg.sendMessage(chatId, '🛠 <b>Можно сделать кнопкой</b> — сначала бот покажет, что будет сделано', { html: true, keyboard: rows });
  }
}

/**
 * Меню команд и клавиатура — один раз на ревизию меню: задание answers обновляет меню бота (setMyCommands)
 * и присылает объявление с клавиатурой. Метка — после успеха, сбой повторится в следующем цикле. true — обновлено сейчас.
 */
export async function ensureBotMenu(p, cfg, tg) {
  const rev = menuRev(cfg);
  if (readText(menuMark(p), '').trim() === rev) return false;
  await tg.setMyCommands(botCommands(cfg));
  const text = hasActions(cfg)
    ? `🆕 mcfly ${escHtml(cfg.project)}: в боте появились действия — 🛠 «действия»: ${listActions(cfg).map((a) => escHtml(a.title)).join(', ')}. Каждое с подтверждением, итог приходит сообщением; в «где мы» — кнопки того, что можно сделать сейчас.`
    : `🆕 mcfly ${escHtml(cfg.project)}: в боте появились команды обзора — 📍 «где мы», 🎯 «цели», 📊 «статистика», 📰 «последний прогон», ❓ «помощь». Кнопки — внизу чата, все команды — в меню «/».`;
  await tg.sendMessage(cfg.telegram.chat_id, text, { html: true, replyKeyboard: mainKeyboard(cfg) });
  writeText(menuMark(p), `${rev}\n`);
  return true;
}
