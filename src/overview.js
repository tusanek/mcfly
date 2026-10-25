import path from 'node:path';
import fs from 'node:fs';
import { readText, writeText, fmtShort, fmtDuration, truncate, pad2, commandText } from './util.js';
import { readMetrics, aggregate } from './metrics.js';
import { loadQuestions, openQuestions } from './questions.js';
import { listChanges, pendingApprovals, approvedWithWork, approvalDeadline, isAutoApprovable } from './approvals.js';
import { autoDefault } from './config.js';
import { parseSlot } from './window.js';
import { currentRun } from './runner.js';
import { hasActions, listActions } from './action-config.js';
import { currentAction, offerKeyboard, isTrusted } from './actions.js';
import { loadIdeas, visibleIdeas, ideasBrief } from './ideas.js';
import { escHtml, inline, splitHtml, reportSections, plainWords, humanItems, approvalCovered, isNone, changeProgress, nextRunText, runsByStatus, STATUS_RU, summaryKeyboard } from './summary.js';

/**
 * Команды обзора для владельца в Telegram: «статус» (раньше «где мы»), «цели», «статистика», «последний прогон», «помощь».
 * Только читают состояние проекта — ничего не пишут в answers.md, не трогают вопросы и одобрения, не запускают прогон.
 */
const VIEW_WORDS = {
  status: ['/status', 'статус', 'где мы', 'где мы сейчас'],
  goals: ['/goals', 'цели', 'цель'],
  stats: ['/stats', 'статистика'],
  last: ['/last', 'последний прогон'],
  help: ['/help', '/start', 'помощь', 'справка'],
  ideas: ['/ideas', 'предложения', 'идеи'],
};
export { commandText };
/** Имя обзора (status, goals, stats, last, help) или null: сообщение целиком должно быть командой, «статус по X» — заметка. */
export function viewOf(text) {
  const t = commandText(text);
  return Object.keys(VIEW_WORDS).find((v) => VIEW_WORDS[v].includes(t)) || null;
}

/** Меню команд Telegram (setMyCommands): латиница в нижнем регистре, описание до 256 символов. */
export const BOT_COMMANDS = [
  { command: 'status', description: '📍 Статус: прогон, изменения, вопросы, ссылки, квота' },
  { command: 'goals', description: '🎯 Цели проекта и чек-лист до MVP' },
  { command: 'stats', description: '📊 Статистика за 7 дней и всего' },
  { command: 'last', description: '📰 Последний прогон простыми словами' },
  { command: 'ideas', description: '💡 Предложения: что команда может сделать дальше' },
  { command: 'run', description: '▶️ Запустить прогон' },
  { command: 'help', description: '❓ Все команды с примерами' },
];
const ACTIONS_COMMAND = { command: 'actions', description: '🛠 Действия: выкат, откат и другое — с подтверждением' };
/** Меню «/» проекта: с действиями — ещё /actions перед /help. */
export const botCommands = (cfg) => (hasActions(cfg) ? [...BOT_COMMANDS.slice(0, -1), ACTIONS_COMMAND, BOT_COMMANDS.at(-1)] : BOT_COMMANDS);
/** Постоянная клавиатура внизу чата: нажатие отправляет текст кнопки, как если бы его написали. */
export const MAIN_KEYBOARD = [[{ text: '📍 Статус' }, { text: '🎯 Цели' }], [{ text: '📊 Статистика' }, { text: '▶️ Запусти' }]];
/** Клавиатура проекта: третий ряд — «💡 Предложения» (ideas.enabled, 0.7.0) и «🛠 Действия» (раздел actions). */
export function mainKeyboard(cfg) {
  const third = [...(cfg.ideas?.enabled ? [{ text: '💡 Предложения' }] : []), ...(hasActions(cfg) ? [{ text: '🛠 Действия' }] : [])];
  return third.length ? [...MAIN_KEYBOARD, third] : MAIN_KEYBOARD;
}
/** Ревизия меню: другая — задание answers один раз обновит меню и пришлёт клавиатуру (метка в mcfly/logs, она вне git). */
export const MENU_REV = '0.7.0';
/** Ревизия с учётом действий: появились (и подтверждены) или пропали — меню и клавиатура обновятся один раз. */
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
  if (st === 'pending' && c.mcfly.idea) return `⏳ <b>${escHtml(c.name)}</b> — ждёт вашего решения, само не одобрится (по ${escHtml(c.mcfly.idea)})`;
  if (st === 'pending') return `⏳ <b>${escHtml(c.name)}</b> — ждёт одобрения${isAutoApprovable(c, cfg) ? ` (авто-одобрение ${fmtShort(approvalDeadline(c, cfg))})` : ''}`;
  if (st === 'rejected') return `⛔ ${escHtml(c.name)} — отклонено`;
  if (st === 'approved') return `${c.tasksOpen > 0 ? '🔧' : '🏁'} <b>${escHtml(c.name)}</b> — одобрено, задач ${changeProgress(p.projectDir, c)}`;
  return `⚪ ${escHtml(c.name)} — одобрение не запрошено, задач ${changeProgress(p.projectDir, c)}`;
};
const toParts = (html) => splitHtml(html, MAX);

/** 📍 Статус: ссылки, прогон, изменения, вопросы, «Нужно от вас», следующий прогон и квота. Возвращает куски HTML ≤ 4000 символов. */
export function statusView(p, cfg, { now = new Date() } = {}) {
  const L = [`📍 <b>Статус · ${escHtml(cfg.project)}</b> · ${fmtShort(now)}`];
  const links = Object.entries(cfg.links || {});
  if (links.length) L.push(`🔗 ${links.map(([k, v]) => `<a href="${escHtml(v)}">${escHtml(k)}</a>`).join(' · ')}`);
  L.push('');
  const cur = currentRun(p);
  const last = runs(p).at(-1);
  if (cur) L.push(`▶️ <b>Идёт прогон</b> ${escHtml(cur.id || '')} с ${fmtShort(cur.since)}${cur.lastEvent ? `\nПоследнее действие: ${escHtml(truncate(cur.lastEvent, 300))}` : ''}`);
  else L.push(`💤 Прогон сейчас не идёт.${last ? ` Последний: ${escHtml(runBrief(last))}` : ' Прогонов ещё не было.'}`);
  const act = currentAction(p);
  if (hasActions(cfg) && !isTrusted(p, cfg)) L.push('⚠️ Кнопки действий выключены: раздел actions изменён — подтвердите в терминале <code>mcfly action trust</code>');
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
  const plan = nextRunText(approvedWithWork(changes), pendingApprovals(changes), (c) => changeProgress(p.projectDir, c), escHtml, ideasBrief(p, cfg));
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
    '📍 «статус» или /status (по-старому «где мы») — ссылки проекта, идёт ли прогон, изменения и их задачи, вопросы, что нужно от вас, следующий прогон, квота',
    '🎯 «цели» или /goals — цель проекта, ближайшая веха и чек-лист до MVP (файл mcfly/goals.md)',
    '📊 «статистика» или /stats — прогоны, задачи, изменения, возвраты с ревью и расход за 7 дней и всего',
    '📰 «последний прогон» или /last — пересказ простыми словами, что сделано и что нужно от вас',
    ...(cfg.ideas?.enabled ? ['💡 «предложения» или /ideas — что команда может сделать дальше: ваш бэклог и идеи команды'] : []),
    '❓ «помощь» или /help — это сообщение',
    '',
    '<b>Управлять</b>',
    start,
    '✅ «одобряю имя-изменения» — разрешить команде делать изменение, например «одобряю site-design»',
    '⛔ «отклоняю имя-изменения причина» — отказать, например «отклоняю site-design не сейчас»',
    '💬 «Q12: ответ» — ответ на вопрос команды; «Q12: по умолчанию» — согласиться с ответом по умолчанию',
    '↩️ Ответ свайпом на сообщение с одним вопросом — ответ на этот вопрос, «Q12:» писать не нужно',
    ...(cfg.ideas?.enabled ? ['✅ / ⏸ кнопки под предложениями — «Берём» (план пришлёт ближайший прогон) или «Не сейчас» (обсудим в сессии)', '💡 «идея: текст» — добавить свою идею в список предложений'] : []),
    '📝 Любой другой текст — заметка команде, её прочтёт ближайший прогон',
    ...(hasActions(cfg) ? ['', '<b>Действия</b> (раздел actions в mcfly/config.yaml)', `🛠 «действия» или /actions — ${listActions(cfg).map((a) => escHtml(a.title)).join(', ')}; каждое с подтверждением «✅ Да, выполнить», итог приходит сообщением`] : []),
    '',
    '<i>Кнопки под сводкой и под «статусом» — те же одобрения и ответы одним нажатием. Кнопки внизу чата и меню «/» — команды выше.</i>',
  ].join('\n'));
}

const SIZE_RU = { S: 'S', M: 'M', L: 'L' };
const IDEA_TEXT_MAX = 1500;
const oneLine = (s) => String(s || '').replace(/\s+/g, ' ').trim();
const ideaOwner = (x) => (x.source === 'owner-backlog' || x.source === 'owner-note' ? 'ваш' : 'команда');
/** Пункт списка: заголовок, название, что даст, откуда, что понадобится от владельца. */
function ideaLines(x) {
  return [
    `💡 ${escHtml(x.id)} · ${ideaOwner(x)} · ${SIZE_RU[x.size] || escHtml(String(x.size || '?'))}`,
    `<b>${escHtml(x.title)}</b>`,
    // Описание целиком (0.7.1): владелец выбирает по нему; потолок — только чтобы строка влезла в сообщение Telegram
    `Что даст: ${escHtml(truncate(oneLine(x.benefit), IDEA_TEXT_MAX))}`,
    ...(x.how ? [`Как: ${escHtml(truncate(oneLine(x.how), IDEA_TEXT_MAX))}`] : []),
    ...(x.ref ? [`Откуда: ${escHtml(x.ref)}`] : []),
    ...(x.needs_owner ? [`🙋 От вас понадобится: ${escHtml(x.needs_owner)}`] : []),
  ];
}
const ideasPage = (data, cfg, page) => {
  const all = visibleIdeas(data, Number.MAX_SAFE_INTEGER);
  const from = (Math.max(1, page) - 1) * cfg.ideas.show;
  return { ...all, shown: all.proposed.slice(from, from + cfg.ideas.show), more: Math.max(0, all.proposed.length - from - cfg.ideas.show) };
};
/** 💡 Предложения (0.7.0): взятые и спланированные, лучшие пункты списка, отложенные на обсуждение. */
export function ideasView(p, cfg, { page = 1 } = {}) {
  const head = [`💡 <b>Предложения · ${escHtml(cfg.project)}</b>`];
  if (!cfg.ideas?.enabled) return toParts([...head, '', 'Список предложений выключен (ideas.enabled: false)'].join('\n'));
  const data = loadIdeas(p);
  if (data.error) return toParts([...head, '', `⚠️ ${escHtml(data.error)} — список не прочитан, исправьте файл`].join('\n'));
  const v = ideasPage(data, cfg, page);
  const L = [...head];
  if (v.active.length) {
    const approval = Object.fromEntries(listChanges(p.openspecChanges).map((c) => [c.name, c.mcfly.approval]));
    L.push('', ...v.active.map((x) => (x.status === 'taken'
      ? `⏳ ${escHtml(x.id)} — ждёт прогона: ${escHtml(x.title)}`
      : approval[x.change] === 'approved'
        ? `🔧 ${escHtml(x.id)} → изменение ${escHtml(x.change || '?')}, одобрено — команда делает`
        : `📝 ${escHtml(x.id)} → изменение ${escHtml(x.change || '?')}, ждёт вашего решения в «Статусе»`)));
  }
  if (v.shown.length) for (const x of v.shown) L.push('', ...ideaLines(x));
  else if (!v.active.length) L.push('', 'Предложений пока нет: команда добавит их в следующем прогоне, или напишите «идея: …»');
  if (v.more) L.push('', `… ещё ${v.more} — кнопка «Ещё ▸»`);
  if (v.discuss) L.push('', `🗣 Обсудить в сессии: ${v.discuss}`);
  return toParts(L.join('\n'));
}
/** Кнопки под «Предложениями»: «Берём» / «Не сейчас» для каждого показанного пункта и «Ещё ▸». */
export function ideasKeyboard(p, cfg, { page = 1 } = {}) {
  if (!cfg.ideas?.enabled) return [];
  const data = loadIdeas(p); if (data.error) return [];
  const v = ideasPage(data, cfg, page);
  const rows = v.shown.map((x) => [{ text: `✅ Берём ${x.id}`, callback_data: `ib:${x.id}` }, { text: '⏸ Не сейчас', callback_data: `ix:${x.id}` }]);
  if (v.more) rows.push([{ text: 'Ещё ▸', callback_data: `il:${Math.max(1, page) + 1}` }]);
  return rows;
}

const VIEWS = { status: statusView, goals: goalsView, stats: statsView, last: lastView, help: helpView, ideas: ideasView };
/** Куски HTML ответа на команду обзора view. */
export function renderView(view, p, cfg, opts = {}) { return VIEWS[view](p, cfg, opts); }

/** Отправляет ответ на команду обзора с постоянной клавиатурой внизу чата. */
export async function sendView(tg, chatId, view, p, cfg, opts = {}) {
  for (const part of renderView(view, p, cfg, opts)) await tg.sendMessage(chatId, part, { html: true, replyKeyboard: mainKeyboard(cfg) });
  // «статус»: отдельным сообщением кнопки решений, как под сводкой, — одобрить/отклонить изменение, ответ по умолчанию на вопрос
  if (view === 'ideas') {
    const rows = ideasKeyboard(p, cfg, { page: opts.page || 1 });
    if (rows.length) await tg.sendMessage(chatId, 'Выберите:', { html: true, keyboard: rows });
  }
  if (view === 'status') {
    const rows = summaryKeyboard(p, cfg);
    if (rows.length) await tg.sendMessage(chatId, '🗳 <b>Ждут вашего решения</b>', { html: true, keyboard: rows });
  }
  // «статус» с действиями: отдельным сообщением кнопки того, что можно сделать сейчас (offer вернул 0) — у одного сообщения одна клавиатура
  if (view === 'status' && hasActions(cfg) && opts.offers !== false) {
    const rows = await (opts.offerKeyboard || offerKeyboard)(p, cfg);
    if (rows.length) await tg.sendMessage(chatId, '🛠 <b>Можно сделать кнопкой</b> — сначала бот покажет, что будет сделано', { html: true, keyboard: rows });
  }
}

/**
 * Меню команд и клавиатура — один раз на ревизию меню: задание answers обновляет меню бота (setMyCommands)
 * и присылает объявление с клавиатурой. Метка — после успеха, сбой повторится в следующем цикле. true — обновлено сейчас.
 */
export async function ensureBotMenu(p, cfg, tg) {
  // Действия есть, но не подтверждены (mcfly action trust) — меню не трогаем: объявим кнопки, когда они заработают.
  if (hasActions(cfg) && !isTrusted(p, cfg)) return false;
  const rev = menuRev(cfg);
  if (readText(menuMark(p), '').trim() === rev) return false;
  await tg.setMyCommands(botCommands(cfg));
  const text = rev.endsWith('+actions')
    ? `🆕 mcfly ${escHtml(cfg.project)}: «Где мы» теперь 📍 «Статус» (со ссылками проекта); 🛠 «действия»: ${listActions(cfg).map((a) => escHtml(a.title)).join(', ')}. Действия с подтверждением, итог приходит сообщением; в «статус» — кнопки того, что можно сделать сейчас.`
    : `🆕 mcfly ${escHtml(cfg.project)}: команды обзора — 📍 «статус» (раньше «где мы»), 🎯 «цели», 📊 «статистика», 📰 «последний прогон», ❓ «помощь». Кнопки — внизу чата, все команды — в меню «/».`;
  await tg.sendMessage(cfg.telegram.chat_id, text, { html: true, replyKeyboard: mainKeyboard(cfg) });
  writeText(menuMark(p), `${rev}\n`);
  return true;
}
