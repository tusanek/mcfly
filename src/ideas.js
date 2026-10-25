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
  session: Object.fromEntries(Object.keys(IDEA_STATUS_RU).map((s) => [s, ['proposed', 'taken', 'rejected']])),
};
const IDEAS_FILE = 'mcfly/ideas.yaml';

/** { ideas } из файла; нет файла — пустой список; ошибка YAML — пустой список и error (файл не трогаем). */
export function loadIdeas(p) {
  if (!exists(p.ideas)) return { ideas: [] };
  try {
    const doc = YAML.parse(readText(p.ideas, '')) || {};
    return { ideas: Array.isArray(doc.ideas) ? doc.ideas : [] };
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

export function addIdea(data, { title, benefit, how = '', source, ref = '', size, needsOwner = '', newArguments = '', now = new Date(), runId = '' }) {
  if (!String(title || '').trim()) throw new Error('Нужно название предложения (--title)');
  if (!String(benefit || '').trim()) throw new Error('Нужно «что даст» (--benefit)');
  if (!IDEA_SOURCES.includes(source)) throw new Error(`Неизвестный источник "${source}". Допустимо: ${IDEA_SOURCES.join(', ')}`);
  if (!IDEA_SIZES.includes(size)) throw new Error(`Неизвестный размер "${size}". Допустимо: ${IDEA_SIZES.join(', ')}`);
  if (source === 'research' && !/^https?:\/\/\S+$/.test(String(ref))) throw new Error('Для research нужна ссылка на источник (--ref http(s)://…)');
  const twin = data.ideas.find((x) => norm(x.title) === norm(title) && !(x.status === 'rejected' && String(newArguments).trim()));
  if (twin) throw new Error(`Такое предложение уже есть: ${twin.id} (${IDEA_STATUS_RU[twin.status] || twin.status})`);
  const idea = {
    id: nextIdeaId(data), title: String(title).trim(), benefit: String(benefit).trim(), how, source, ref, size,
    needs_owner: needsOwner, status: 'proposed', created_at: now.toISOString(), run_id: runId,
    ...(String(newArguments).trim() ? { new_arguments: String(newArguments).trim() } : {}),
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
  if (to === 'planned' && !change) return { idea, error: 'нужно имя изменения' };
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
/** Спланированные пункты, чьё изменение ушло из openspec/changes (заархивировано), — сделаны. */
export function syncDoneIdeas(data, changesDir, now = new Date()) {
  const done = [];
  for (const x of data.ideas) {
    if (x.status !== 'planned' || !x.change) continue;
    let alive = false; try { alive = fs.statSync(path.join(changesDir, x.change)).isDirectory(); } catch {}
    if (!alive && !transitionIdea(data, x.id, 'done', { actor: 'team', now }).error) done.push(x);
  }
  return done;
}
/** Кратко для «Статуса» и сводки: { taken: [id], proposed, owner } или null (список выключен или файл испорчен). */
export function ideasBrief(p, cfg) {
  if (!cfg.ideas?.enabled) return null;
  const data = loadIdeas(p); if (data.error) return null;
  const proposed = data.ideas.filter((x) => x.status === 'proposed');
  return { taken: data.ideas.filter((x) => x.status === 'taken').map((x) => x.id), proposed: proposed.length, owner: proposed.filter((x) => OWNER.has(x.source)).length };
}
