import path from 'node:path';
import { readText, writeText } from './util.js';

/**
 * Галочки в целях (0.11.0). Решение владельца 15.11.2026: когда команда закрывает пункт его бэклога, mcfly сам ставит «[x]»
 * у этого пункта в mcfly/goals.md и пишет об этом в итоге прогона. Исключение из «goals.md ведёт владелец»: меняется только
 * галочка, текст пункта не трогается. Раньше экран «🎯 Цели» отставал («0 из 13» при сделанном пункте).
 */
const ITEM = /^(\s*[-*+]\s+\[) (\]\s+)(.+?)\s*$/;
const norm = (s) => String(s || '').toLowerCase().replace(/ё/g, 'е').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const stems = (n) => new Set(n.split(' ').filter((w) => w.length >= 4).map((w) => w.slice(0, 5)));

/** Насколько пункт целей — тот же, что название предложения: 1 — совпал или один входит в другой, иначе доля общих основ слов. */
function likeness(a, b) {
  if (!a || !b) return 0;
  if (a === b) return 1;
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  if (short.length >= 15 && ` ${long} `.includes(` ${short} `)) return 1;
  const x = stems(a); const y = stems(b); const common = [...x].filter((w) => y.has(w)).length;
  return common >= 3 ? common / (x.size + y.size - common) : 0;
}

/**
 * Ставит «[x]» у открытых пунктов mcfly/goals.md, совпавших со сделанными предложениями ideas (по названию; неточное совпадение —
 * только если такой пункт один). Каждому отмеченному предложению ставит goal_checked: второй раз галочку не ставим, даже если
 * владелец её снял. Возвращает тексты отмеченных пунктов.
 */
export function tickGoals(p, ideas) {
  const file = path.join(p.root, 'goals.md');
  const text = readText(file, '');
  if (!text.trim() || !ideas.length) return [];
  const lines = text.split('\n'); const ticked = [];
  for (const idea of ideas) {
    const title = norm(idea.title);
    const scored = lines.map((line, i) => { const m = ITEM.exec(line); return m ? { i, m, score: likeness(title, norm(m[3])) } : null; }).filter((x) => x && x.score >= 0.6);
    if (!scored.length) continue;
    const best = Math.max(...scored.map((x) => x.score));
    const top = scored.filter((x) => x.score === best);
    if (top.length !== 1) continue; // непонятно, какой из пунктов — не гадаем
    const { i, m } = top[0];
    lines[i] = lines[i].replace(ITEM, `${m[1]}x${m[2]}${m[3]}`);
    idea.goal_checked = true;
    ticked.push(m[3].replace(/[`*_]/g, ''));
  }
  if (ticked.length) writeText(file, lines.join('\n'));
  return ticked;
}
