import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { readText, writeText, exists } from './util.js';

/**
 * Список предложений (0.7.0): кандидаты владельца и идеи команды в mcfly/ideas.yaml.
 * Пункт без «Берём» сам ничего не запускает; окончательный отказ — только в сессии владельца.
 */
export const IDEA_SOURCES = ['owner-backlog', 'owner-note', 'team', 'research'];
export const IDEA_SIZES = ['S', 'M', 'L'];
export const IDEA_STATUS_RU = { proposed: 'в списке', taken: 'взято', planned: 'спланировано', done: 'сделано', discuss: 'на обсуждении в сессии', rejected: 'отклонено' };
/** Кто какие переходы делает: бот — взять или отложить на обсуждение; команда — спланировать и закрыть; сессия — вернуть, взять, отказать. */
const ALLOWED = {
  bot: { proposed: ['taken', 'discuss'], taken: ['discuss'], planned: ['discuss'] },
  team: { taken: ['planned'], planned: ['done'] },
  // владелец в сессии может и отметить пункт сделанным (0.15.5): работа бывает сделана без привязки к изменению
  session: Object.fromEntries(Object.keys(IDEA_STATUS_RU).map((s) => [s, ['proposed', 'taken', 'rejected', 'done']])),
};
const IDEAS_FILE = 'mcfly/ideas.yaml';

/** { ideas } из файла; нет файла — пустой список; ошибка YAML — пустой список и error (файл не трогаем). */
export function loadIdeas(p) {
  if (!exists(p.ideas)) return { ideas: [] };
  try {
    const doc = YAML.parse(readText(p.ideas, '')) || {};
    const ideas = Array.isArray(doc.ideas) ? doc.ideas : [];
    // Кривой элемент после ручной правки — ошибка файла (как у YAML), а не падение бота и прогона на x.status
    const bad = ideas.findIndex((x) => !x || typeof x !== 'object' || !/^I\d+$/.test(String(x.id)));
    if (bad >= 0) return { ideas: [], error: `${IDEAS_FILE}: элемент ${bad + 1} без номера вида I1 (пустой или испорчен)` };
    return { ideas };
  } catch (e) {
    return { ideas: [], error: `${IDEAS_FILE}: ${String(e.message || e).split('\n')[0]}` };
  }
}
export function saveIdeas(p, data) {
  if (data.error) throw new Error(`${IDEAS_FILE} испорчен, не перезаписываю: ${data.error}`);
  writeText(p.ideas, YAML.stringify({ ideas: data.ideas }));
}
export function nextIdeaId(data) {
  const max = data.ideas.reduce((m, x) => Math.max(m, Number(String(x.id).replace(/^I/i, '')) || 0), 0);
  return `I${max + 1}`;
}
const norm = (s) => String(s || '').toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
export const findIdea = (data, id) => data.ideas.find((x) => String(x.id).toUpperCase() === String(id).toUpperCase()) || null;

/**
 * 0.23.5 (F45): похожие предложения. Точное совпадение названия ловит только повтор слово в слово, а команда пересказывает
 * тот же пункт другими словами и заводит его заново, хотя он уже взят или сделан. Сравниваем основы значимых слов названия
 * (первые 5 букв: «отвечает» и «отвечать» — одно), без чисел и служебных слов; похоже — общих основ не меньше 3
 * и доля общих (2·общие / сумма) не меньше 0,6. Порог подобран на живом списке из 340 предложений: ловит пересказ
 * сделанного пункта и пары «то же на сегодня / на завтра», почти не задевает просто соседние темы.
 */
const STOP = new Set(['что', 'как', 'для', 'при', 'без', 'это', 'или', 'так', 'там', 'тут', 'его', 'она', 'они', 'оно', 'все', 'всё', 'уже', 'ещё', 'еще', 'нет', 'над', 'под', 'про', 'чем', 'где', 'когда', 'если', 'только', 'тоже', 'также', 'после', 'перед', 'вместо', 'один', 'одним', 'одна', 'the', 'and', 'for', 'with']);
const stems = (s) => new Set(norm(s).split(' ').filter((w) => w.length >= 3 && !/^\d+$/.test(w) && !STOP.has(w)).map((w) => w.slice(0, 5)));
export function titleSimilar(a, b) {
  const x = stems(a); const y = stems(b);
  const common = [...x].filter((w) => y.has(w)).length;
  return common >= 3 && (2 * common) / (x.size + y.size) >= 0.6;
}
/** Похожие пункты (кроме отклонённых): в списке, взятые, спланированные, сделанные, на обсуждении. */
export const similarIdeas = (data, title) => data.ideas.filter((x) => x.status !== 'rejected' && titleSimilar(x.title, title));
const AUTO_SOURCES = new Set(['team', 'research']);

export function addIdea(data, { title, benefit, how = '', source, ref = '', size, needsOwner = '', newArguments = '', differs = '', now = new Date(), runId = '' }) {
  if (!String(title || '').trim()) throw new Error('Нужно название предложения (--title)');
  if (!String(benefit || '').trim()) throw new Error('Нужно «что даст» (--benefit)');
  if (!IDEA_SOURCES.includes(source)) throw new Error(`Неизвестный источник "${source}". Допустимо: ${IDEA_SOURCES.join(', ')}`);
  if (!IDEA_SIZES.includes(size)) throw new Error(`Неизвестный размер "${size}". Допустимо: ${IDEA_SIZES.join(', ')}`);
  if (source === 'research' && !/^https?:\/\/\S+$/.test(String(ref))) throw new Error('Для research нужна ссылка на источник (--ref http(s)://…)');
  const twin = data.ideas.find((x) => norm(x.title) === norm(title) && !(x.status === 'rejected' && String(newArguments).trim()));
  if (twin) throw new Error(`Такое предложение уже есть: ${twin.id} (${IDEA_STATUS_RU[twin.status] || twin.status})`);
  // Похожее заводит только команда пересказом — слова владельца (бэклог, заметка, кнопки бота) не останавливаем
  if (AUTO_SOURCES.has(source) && !String(differs).trim()) {
    const like = similarIdeas(data, title).slice(0, 3);
    if (like.length) throw new Error(`Похоже на уже заведённое: ${like.map((x) => `${x.id} «${x.title}» (${IDEA_STATUS_RU[x.status] || x.status})`).join('; ')}. Не заводи его заново. Если это другое — повтори с --differs "чем отличается от ${like[0].id}".`);
  }
  const idea = {
    id: nextIdeaId(data), title: String(title).trim(), benefit: String(benefit).trim(), how, source, ref, size,
    needs_owner: needsOwner, status: 'proposed', created_at: now.toISOString(), run_id: runId,
    ...(String(newArguments).trim() ? { new_arguments: String(newArguments).trim() } : {}),
    ...(String(differs).trim() ? { differs: String(differs).trim() } : {}),
  };
  data.ideas.push(idea);
  return idea;
}

/** Переход статуса от имени actor (bot | team | session): { idea, error }; запрещённый или повторный переход ничего не меняет. */
export function transitionIdea(data, id, to, { actor, note = '', change = '', now = new Date() }) {
  const idea = findIdea(data, id);
  if (!idea) return { idea: null, error: 'такого предложения нет' };
  if (idea.status === to) return { idea, error: `уже ${IDEA_STATUS_RU[to] || to}` };
  if (!(ALLOWED[actor]?.[idea.status] || []).includes(to)) return { idea, error: `нельзя: ${IDEA_STATUS_RU[idea.status] || idea.status} → ${IDEA_STATUS_RU[to] || to}` };
  if (to === 'planned' && !/^[a-z0-9][a-z0-9-]*$/.test(String(change))) return { idea, error: 'нужно имя изменения (латиница, цифры, дефис)' };
  Object.assign(idea, { status: to, decided_at: now.toISOString() });
  if (to === 'planned') idea.change = change;
  if (to === 'discuss' && note) idea.discuss_note = note;
  if (to === 'rejected' && note) idea.reject_note = note;
  return { idea, error: null };
}

const OWNER = new Set(['owner-backlog', 'owner-note']);
const rank = (x) => [OWNER.has(x.source) ? 0 : 1, x.needs_owner ? 1 : 0, IDEA_SIZES.indexOf(x.size), Number(String(x.id).slice(1)) || 0];
const byRank = (a, b) => { const ra = rank(a); const rb = rank(b); for (let i = 0; i < ra.length; i++) if (ra[i] !== rb[i]) return ra[i] - rb[i]; return 0; };
/** Что показать на экране «Предложения»: взятые и спланированные, лучшие show из списка, остаток и число отложенных. */
export function visibleIdeas(data, show) {
  const proposed = data.ideas.filter((x) => x.status === 'proposed').sort(byRank);
  return {
    active: data.ideas.filter((x) => x.status === 'taken' || x.status === 'planned'),
    proposed: proposed.slice(0, show), more: Math.max(0, proposed.length - show),
    discuss: data.ideas.filter((x) => x.status === 'discuss').length,
  };
}
/**
 * Взятые пункты в порядке планирования (0.16.0): сначала поднятые владельцем «⬆ Вперёд» (позже поднятый — раньше),
 * затем жалобы «неудобно», затем остальные по порядку в списке.
 */
export function takenInOrder(data) {
  const taken = data.ideas.filter((x) => x.status === 'taken');
  const first = taken.filter((x) => x.first_at).sort((a, b) => String(b.first_at).localeCompare(String(a.first_at)));
  const rest = taken.filter((x) => !x.first_at);
  return [...first, ...rest.filter((x) => x.ux), ...rest.filter((x) => !x.ux)];
}
/** «⬆ Вперёд» по взятому пункту (0.16.0): { idea, error }; спланированный пункт поднимают через его изменение (idea.change). */
export function markFirst(data, id, now = new Date()) {
  const idea = findIdea(data, id);
  if (!idea) return { idea: null, error: 'такого предложения нет' };
  if (idea.status !== 'taken') return { idea, error: `поднять можно взятый пункт (сейчас: ${IDEA_STATUS_RU[idea.status] || idea.status})` };
  idea.first_at = now.toISOString();
  return { idea, error: null };
}
/**
 * Спланированные пункты, чьё изменение ушло из openspec/changes (заархивировано), — сделаны.
 * 0.18.8: пункт, который делается частями (parts), после части не закрывается, а снова становится взятым — команда
 * планирует следующую часть (`approval request --idea <Iн> --part`) или закрывает его после последней (`mcfly ideas done`).
 */
export function syncDoneIdeas(data, changesDir, now = new Date()) {
  const done = [];
  for (const x of data.ideas) {
    if (x.status !== 'planned' || !x.change) continue;
    let alive = false; try { alive = fs.statSync(path.join(changesDir, x.change)).isDirectory(); } catch {}
    if (alive) continue;
    if (x.parts?.length) { Object.assign(x, { status: 'taken', decided_at: now.toISOString() }); continue; }
    if (!transitionIdea(data, x.id, 'done', { actor: 'team', now }).error) done.push(x);
  }
  return done;
}
/**
 * План одной части большого пункта (0.18.8, `approval request --idea <Iн> --part`): взятый или уже спланированный пункт
 * становится спланированным по этой части, а изменения всех частей копятся в idea.parts. Такой пункт не закрывается
 * сам при архивации части — только командой `mcfly ideas done <Iн> --change <последняя часть>`. Возвращает { idea, error }.
 */
export function planIdeaPart(data, id, change, now = new Date()) {
  const idea = findIdea(data, id);
  if (!idea) return { idea: null, error: 'такого предложения нет' };
  if (!['taken', 'planned'].includes(idea.status)) return { idea, error: `пункт не взят владельцем (статус: ${IDEA_STATUS_RU[idea.status] || idea.status})` };
  if (!/^[a-z0-9][a-z0-9-]*$/.test(String(change))) return { idea, error: 'нужно имя изменения (латиница, цифры, дефис)' };
  const parts = [...new Set([...(idea.parts || []), ...(idea.change && !idea.parts ? [idea.change] : []), change])];
  Object.assign(idea, { status: 'planned', change, parts, decided_at: now.toISOString() });
  return { idea, error: null };
}
/** Кратко для «Статуса» и сводки: { taken: [id], proposed, owner } или null (список выключен или файл испорчен). */
export function ideasBrief(p, cfg) {
  if (!cfg.ideas?.enabled) return null;
  const data = loadIdeas(p); if (data.error) return null;
  const proposed = data.ideas.filter((x) => x.status === 'proposed');
  return { taken: data.ideas.filter((x) => x.status === 'taken').map((x) => x.id), proposed: proposed.length, owner: proposed.filter((x) => OWNER.has(x.source)).length };
}

/** Лежит ли изменение в архиве (папка `<имя>` или `<дата>-<имя>`). */
export function isArchived(changesDir, name) {
  let archived = []; try { archived = fs.readdirSync(path.join(changesDir, 'archive'), { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name); } catch { /* архива нет */ }
  return archived.some((d) => d === name || d.replace(/^\d{4}-\d{2}-\d{2}-/, '') === name);
}
/**
 * «Закрыть без работы» (0.17.0): владелец в боте окончательно закрывает взятый, спланированный или отложенный пункт —
 * например, когда команда выяснила, что работа не нужна. Это решение владельца, а не команды. Возвращает { idea, error }.
 */
export function closeIdea(data, id, note = '', now = new Date()) {
  const idea = findIdea(data, id);
  if (!idea) return { idea: null, error: 'такого предложения нет' };
  if (!['taken', 'planned', 'discuss'].includes(idea.status)) return { idea, error: `закрыть можно взятый, спланированный или отложенный пункт (сейчас: ${IDEA_STATUS_RU[idea.status] || idea.status})` };
  Object.assign(idea, { status: 'rejected', decided_at: now.toISOString(), reject_note: note || 'закрыто владельцем без работы' });
  return { idea, error: null };
}
/**
 * Закрыть пункт по завершённому изменению (0.15.5): взятый или спланированный пункт становится сделанным, если названное
 * изменение лежит в архиве (папка `<имя>` или `<дата>-<имя>`). Так команда закрывает пункт, сделанный в рамках чужого плана,
 * не трогая решений владельца: без изменения в архиве — отказ. Возвращает { idea, error }.
 */
export function closeIdeaByChange(data, id, change, changesDir, now = new Date()) {
  const idea = findIdea(data, id);
  if (!idea) return { idea: null, error: 'такого предложения нет' };
  if (idea.status === 'done') return { idea, error: 'уже сделано' };
  if (!['taken', 'planned'].includes(idea.status)) return { idea, error: `пункт не взят владельцем (статус: ${IDEA_STATUS_RU[idea.status] || idea.status})` };
  const name = String(change || '');
  if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) return { idea, error: 'нужно имя изменения (латиница, цифры, дефис)' };
  if (!isArchived(changesDir, name)) return { idea, error: `изменения ${name} нет в архиве: закрыть пункт можно только по завершённому изменению` };
  Object.assign(idea, { status: 'done', change: name, decided_at: now.toISOString() });
  return { idea, error: null };
}
