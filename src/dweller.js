import fs from 'node:fs';
import path from 'node:path';
import { appendMetric, readMetrics } from './metrics.js';
import { readText } from './util.js';
import { hasProduct } from './context.js';

/**
 * 0.23.0 (F28): «житель» — проживает продукт как владелец, сквозь все части разом. Проверка «глазами пользователя» идёт по одному
 * изменению и сверяется со спецификацией — неудобную задумку она не замечает. Житель зовётся раз в dweller.every_runs удачных прогонов
 * (0 — только по просьбе) или по просьбе владельца («проживи» в боте, mcfly dweller request): тогда — полная проверка всего сделанного.
 */
export const requestPath = (p) => path.join(p.root, 'dweller-request.md');
const EVENT = 'dweller_walk';

export function dwellerDue(p, cfg) {
  if (!hasProduct(p)) return null; // без описания продукта жить не за кого
  const req = requestPath(p);
  if (fs.existsSync(req)) return { why: 'owner', note: readText(req, '').trim() };
  const every = cfg.dweller?.every_runs || 0;
  if (!every) return null;
  const recs = readMetrics(p);
  const lastAt = recs.filter((r) => r.type === 'event' && r.key === EVENT).map((r) => r.at).sort().at(-1) || '';
  const ok = recs.filter((r) => r.type === 'run' && r.status === 'ok' && (r.started_at || '') > lastAt).length;
  return ok >= every ? { why: 'schedule', runs: ok } : null;
}

export function dwellerRequest(p, note = '', now = new Date()) {
  fs.writeFileSync(requestPath(p), `${now.toISOString()}\n${String(note).trim()}\n`);
}

/** Проход жителя закончен: событие в метриках (отсчёт следующего), просьба владельца снята. */
export function dwellerDone(p, now = new Date()) {
  appendMetric(p, { type: 'event', key: EVENT, value: 1, at: now.toISOString() });
  fs.rmSync(requestPath(p), { force: true });
}

const STEP = `
5c. Житель (mcfly:dweller). {{WHY}} Если до дедлайна не меньше 60 минут, после реализации (до шага 6) вызови mcfly:dweller: он проживает продукт как владелец, сквозь все части разом, и вправе предлагать пересмотр задумки и спецификаций. Передай ему каталог прогона {{RUN_DIR}} и режим: {{MODE_TEXT}}. Его отчёт он кладёт в {{RUN_DIR}}/dweller.md; крупные предложения он сам заносит в список предложений. Выжимку (три главных вывода) включи в отчёт прогона отдельным разделом «Житель». После его ответа выполни \`mcfly dweller done\`. Времени меньше 60 минут — не зови, проход останется на следующий прогон.
`;

export function dwellerStep(due, runDir) {
  if (!due) return '';
  const why = due.why === 'owner' ? `Владелец попросил прожить продукт${due.note.split('\n').slice(1).join(' ').trim() ? ` («${due.note.split('\n').slice(1).join(' ').trim()}»)` : ''}.` : `Прошло ${due.runs} удачных прогонов с прошлого прохода.`;
  const mode = due.why === 'owner' ? 'полная проверка всего уже сделанного, отчёт с пожеланиями по убыванию того, насколько мешает пользоваться' : 'проживание нескольких дней подряд по сквозным сценариям';
  return STEP.replace('{{WHY}}', why).replace('{{MODE_TEXT}}', mode).replaceAll('{{RUN_DIR}}', runDir);
}
