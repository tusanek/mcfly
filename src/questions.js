import YAML from 'yaml';
import { readText, writeText } from './util.js';
import { autoDefault } from './config.js';

export function loadQuestions(p) {
  const doc = YAML.parse(readText(p.questions, '')) || {};
  return { questions: Array.isArray(doc.questions) ? doc.questions : [] };
}
export function saveQuestions(p, data) { writeText(p.questions, YAML.stringify(data)); }
export function nextId(data) {
  const max = data.questions.reduce((m, q) => Math.max(m, Number(String(q.id).replace(/^Q/i, '')) || 0), 0);
  return `Q${max + 1}`;
}
export function addQuestion(data, { category, text, defaultAnswer = '', hours, now = new Date(), runId = '' }, cfg) {
  if (!cfg.escalation.categories[category]) throw new Error(`Неизвестная категория "${category}". Допустимо: ${Object.keys(cfg.escalation.categories).join(', ')}`);
  if (!text) throw new Error('Нужен текст вопроса (--text)');
  if (autoDefault(cfg, category) && !defaultAnswer) throw new Error(`Нужен ответ по умолчанию (--default): по истечении срока команда действует по нему. Без него — только категории, которые ждут человека: ${Object.keys(cfg.escalation.categories).filter((k) => !autoDefault(cfg, k)).join(', ')}`);
  const deadline = new Date(now.getTime() + (hours ?? cfg.escalation.answer_deadline_hours) * 3600_000);
  const q = { id: nextId(data), category, text, default: defaultAnswer || '', status: 'open', created_at: now.toISOString(), deadline_at: deadline.toISOString(), run_id: runId, answer: '', answered_by: '', answered_at: '' };
  data.questions.push(q);
  return q;
}
export function answerQuestion(data, id, answer, by, now = new Date()) {
  const q = data.questions.find((x) => String(x.id).toUpperCase() === String(id).toUpperCase());
  if (!q) return null;
  Object.assign(q, { status: 'answered', answer, answered_by: by, answered_at: now.toISOString() });
  return q;
}
/** Закрывает просроченные открытые вопросы ответом по умолчанию (кроме категорий с auto_default: false). */
export function expireQuestions(data, cfg, now = new Date()) {
  const defaulted = [];
  for (const q of data.questions) {
    if (q.status !== 'open' || !autoDefault(cfg, q.category)) continue;
    if (new Date(q.deadline_at) <= now) {
      Object.assign(q, { status: 'defaulted', answer: q.default, answered_by: 'default', answered_at: now.toISOString() });
      defaulted.push(q);
    }
  }
  return defaulted;
}
export const openQuestions = (data) => data.questions.filter((q) => q.status === 'open');
