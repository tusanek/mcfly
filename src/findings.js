import os from 'node:os';
import path from 'node:path';
import YAML from 'yaml';
import { readText, writeText, exists, readJson, fmtDay, fmtShort, truncate, withFileLock } from './util.js';
import { maskSecrets } from './claude.js';
import { MCFLY_ROOT } from './prompt.js';
import { escHtml } from './summary.js';

/**
 * Находки для доработки самого mcfly (0.11.0): проблемы комплекта, а не проекта, которые заметили агенты прогона, сессии
 * Claude Code или владелец. Раньше владелец собирал их руками из сессий и прогонов.
 * - регистрация: `mcfly finding add` (агенты и сессии) или сообщение боту «mcfly: текст» (владелец);
 * - одобрение: экран «📮 Находки» в боте с кнопками «Передать» / «Не надо»; своё сообщение владельца одобрения не ждёт;
 * - передача: одобренное дописывается в общий ящик (findings.inbox, по умолчанию ~/mcfly-inbox.md) с проектом, датой
 *   и версией mcfly — оттуда его берёт сессия доработки mcfly.
 * Хранение — mcfly/findings.yaml: [{ id: F1, text, evidence, source: run|session|owner, status: new|sent|dropped, … }].
 */
export const FINDING_STATUS_RU = { new: 'ждёт решения', sent: 'передано', dropped: 'не надо' };
const FILE = 'mcfly/findings.yaml';
const TEXT_MAX = 1500; const EVIDENCE_MAX = 600;

export function loadFindings(p) {
  if (!exists(p.findings)) return { findings: [] };
  try {
    const doc = YAML.parse(readText(p.findings, '')) || {};
    const findings = Array.isArray(doc.findings) ? doc.findings : [];
    const bad = findings.findIndex((x) => !x || typeof x !== 'object' || !/^F\d+$/.test(String(x.id)));
    if (bad >= 0) return { findings: [], error: `${FILE}: элемент ${bad + 1} без номера вида F1 (пустой или испорчен)` };
    return { findings };
  } catch (e) {
    return { findings: [], error: `${FILE}: ${String(e.message || e).split('\n')[0]}` };
  }
}
export function saveFindings(p, data) {
  if (data.error) throw new Error(`${FILE} испорчен, не перезаписываю: ${data.error}`);
  writeText(p.findings, YAML.stringify({ findings: data.findings }));
}
export const findFinding = (data, id) => data.findings.find((x) => String(x.id).toUpperCase() === String(id).toUpperCase()) || null;
export const newFindings = (data) => data.findings.filter((x) => x.status === 'new');
/** Сколько находок ждёт решения владельца: 0 — раздел выключен, файла нет или он испорчен. */
export function pendingFindings(p, cfg) {
  if (cfg.findings?.enabled === false) return 0;
  return newFindings(loadFindings(p)).length;
}
/** Версия установленного mcfly — по ней сессия доработки понимает, не исправлено ли уже. */
export const mcflyVersion = () => readJson(path.join(MCFLY_ROOT, 'package.json'), {})?.version || '?';

const norm = (s) => String(s || '').toLowerCase().replace(/ё/g, 'е').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
/** Текст одной строкой, без секретов (ключи и токены из вывода команд) и не длиннее max. */
const clean = (s, max) => truncate(maskSecrets(String(s || '')).replace(/\s+/g, ' ').trim(), max);

export function addFinding(data, { text, evidence = '', source = 'session', now = new Date(), runId = '' }) {
  const t = clean(text, TEXT_MAX);
  if (!t) throw new Error('Нужен текст находки (--text): что не так в самом mcfly');
  if (!['run', 'session', 'owner'].includes(source)) throw new Error(`Неизвестный источник "${source}"`);
  const twin = data.findings.find((x) => norm(x.text) === norm(t));
  if (twin) throw new Error(`Такая находка уже есть: ${twin.id} (${FINDING_STATUS_RU[twin.status] || twin.status})`);
  const max = data.findings.reduce((m, x) => Math.max(m, Number(String(x.id).slice(1)) || 0), 0);
  const item = { id: `F${max + 1}`, text: t, evidence: clean(evidence, EVIDENCE_MAX), source, status: 'new', created_at: now.toISOString(), run_id: runId, mcfly_version: mcflyVersion() };
  data.findings.push(item);
  return item;
}

/** Путь общего ящика: findings.inbox из настроек; «~» — домашний каталог. */
export function inboxPath(cfg) {
  const raw = String(cfg.findings?.inbox || '~/mcfly-inbox.md');
  return raw === '~' || raw.startsWith('~/') ? path.join(os.homedir(), raw.slice(1)) : path.resolve(raw);
}
const INBOX_HEAD = `# Входящие для доработки mcfly

Находки из проектов, где работает mcfly. Каждая одобрена владельцем к передаче.
Сессия доработки mcfly читает этот файл первым; взятое в работу переносит в \`docs/BACKLOG.md\` mcfly или в изменение и отмечает здесь \`[x]\` с версией.
`;
/**
 * Дописывает находку в общий ящик. Заголовок «## дата · проект · mcfly версия» — один на день, проект и версию: следующие находки
 * того же дня идут под ним. Пишут боты разных проектов — под короткой блокировкой файла.
 */
export function appendToInbox(cfg, item, { now = new Date() } = {}) {
  const file = inboxPath(cfg);
  const head = `## ${fmtDay(now)} · ${cfg.project} · mcfly ${item.mcfly_version || mcflyVersion()}`;
  const first = item.text.split(/(?<=[.!?])\s/)[0];
  const rest = item.text.slice(first.length).trim();
  const from = { run: 'заметила команда в прогоне', session: 'заметила сессия Claude Code', owner: 'написал владелец' }[item.source] || '';
  const line = `- [ ] **${first}**${rest ? ` ${rest}` : ''}${item.evidence ? ` Что видели: ${item.evidence}` : ''} _(${[item.id, from].filter(Boolean).join(', ')})_`;
  withFileLock(`${file}.lock`, () => {
    const cur = exists(file) ? readText(file, '') : INBOX_HEAD;
    const lastHead = cur.split('\n').filter((l) => /^## /.test(l)).at(-1);
    const body = cur.endsWith('\n') ? cur : `${cur}\n`;
    writeText(file, lastHead === head ? `${body}${line}\n` : `${body}\n${head}\n\nОдобрено владельцем ${fmtDay(now)}.\n\n${line}\n`);
  });
  return file;
}

/**
 * Решение владельца по находке: send — передать в ящик, drop — не надо. { item, error }; повтор и неизвестный номер ничего не меняют.
 * Не удалось записать ящик — находка остаётся ждать решения.
 */
export function decideFinding(data, cfg, id, to, { now = new Date() } = {}) {
  const item = findFinding(data, id);
  if (!item) return { item: null, error: 'такой находки нет' };
  if (item.status !== 'new') return { item, error: `уже ${FINDING_STATUS_RU[item.status] || item.status}` };
  if (to === 'send') {
    try { item.inbox = appendToInbox(cfg, item, { now }); } catch (e) { return { item, error: `не удалось записать в ящик ${inboxPath(cfg)}: ${String(e.message || e).split('\n')[0]}` }; }
  }
  Object.assign(item, { status: to === 'send' ? 'sent' : 'dropped', decided_at: now.toISOString() });
  return { item, error: null };
}

const SOURCE_RU = { run: 'заметила команда в прогоне', session: 'заметила сессия Claude Code', owner: 'ваше сообщение' };
/** 📮 Находки: что ждёт решения владельца. Возвращает { text (HTML), keyboard }. */
export function findingsView(p, cfg) {
  const head = `📮 <b>Находки для доработки mcfly · ${escHtml(cfg.project)}</b>`;
  if (cfg.findings?.enabled === false) return { text: `${head}\n\nСбор находок выключен в настройках проекта`, keyboard: [] };
  const data = loadFindings(p);
  if (data.error) return { text: `${head}\n\n⚠️ ${escHtml(data.error)} — список не прочитан, исправьте файл`, keyboard: [] };
  const list = newFindings(data);
  if (!list.length) return { text: `${head}\n\nНовых находок нет. Заметили проблему самого mcfly — напишите «mcfly: что не так», передам сразу.`, keyboard: [] };
  const L = [head, '<i>Это проблемы самого mcfly, а не вашего проекта. «Передать» — запишу в общий ящик доработки mcfly; «Не надо» — уберу.</i>'];
  const shown = list.slice(0, 8);
  for (const x of shown) {
    L.push('', `<b>${escHtml(x.id)}</b> · ${SOURCE_RU[x.source] || ''}${x.created_at ? ` ${fmtShort(new Date(x.created_at))}` : ''}`, escHtml(truncate(x.text, 700)));
    if (x.evidence) L.push(`<i>Что видели: ${escHtml(truncate(x.evidence, 300))}</i>`);
  }
  if (list.length > shown.length) L.push('', `… ещё ${list.length - shown.length} — покажу после решения по этим`);
  const keyboard = shown.map((x) => [{ text: `📮 Передать ${x.id}`, callback_data: `fb:${x.id}` }, { text: '🚫 Не надо', callback_data: `fx:${x.id}` }]);
  if (shown.length > 1) keyboard.push([{ text: `📮 Передать все (${list.length})`, callback_data: 'fb:все' }]);
  return { text: L.join('\n'), keyboard };
}
