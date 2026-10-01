import { appendText, fmtLocal } from './util.js';
import { loadQuestions, saveQuestions, answerQuestion } from './questions.js';
import { listChanges, setApproval } from './approvals.js';

export function parseMessage(text) {
  const t = String(text || '').trim();
  let m;
  if ((m = /^#?\s*(Q\d+)\s*[:：\-–—]?\s*([\s\S]*)$/i.exec(t)) && m[2].trim()) return { type: 'answer', id: m[1].toUpperCase(), text: m[2].trim() };
  if ((m = /^(?:approve|ok|одобряю|одобрить|да)\s+([\w.-]+)\s*([\s\S]*)$/i.exec(t))) return { type: 'approve', change: m[1], note: m[2].trim() };
  if ((m = /^(?:reject|отклоняю|отклонить|нет)\s+([\w.-]+)\s*([\s\S]*)$/i.exec(t))) return { type: 'reject', change: m[1], note: m[2].trim() };
  if (/^(?:run|запусти|запуск)(?:\s|$)/i.test(t)) return { type: 'run', text: t };
  if (/^\/start\b/.test(t)) return { type: 'ignore' };
  return { type: 'note', text: t };
}

/** Применяет сообщения человека к состоянию проекта; возвращает строки-подтверждения для ответа в чат. */
export function applyMessages(p, messages, { now = new Date(), by = 'human' } = {}) {
  const acks = [];
  const qdata = loadQuestions(p);
  const changes = listChanges(p.openspecChanges);
  const stamp = fmtLocal(now);
  for (const msg of messages) {
    const parsed = parseMessage(msg.text);
    switch (parsed.type) {
      case 'answer': {
        // «по умолчанию» (кнопка сводки или текст) — ответ по умолчанию самого вопроса.
        const asked = qdata.questions.find((x) => x.id === parsed.id);
        const text = /^по умолчанию$/i.test(parsed.text) && asked?.default ? asked.default : parsed.text;
        const q = answerQuestion(qdata, parsed.id, text, by, now);
        appendText(p.answers, `\n## ${stamp} — ответ на ${parsed.id}\n${text}\n`);
        acks.push(q ? `✅ ${parsed.id}: ответ записан` : `⚠️ ${parsed.id}: вопрос не найден, записал как заметку`);
        break;
      }
      case 'approve': case 'reject': {
        const c = changes.find((x) => x.name === parsed.change);
        if (!c) { appendText(p.answers, `\n## ${stamp} — заметка\n${msg.text}\n`); acks.push(`⚠️ изменение ${parsed.change} не найдено, записал как заметку`); break; }
        const approved = parsed.type === 'approve';
        setApproval(c, approved ? 'approved' : 'rejected', by, parsed.note, now);
        appendText(p.answers, `\n## ${stamp} — ${approved ? 'одобрено' : 'отклонено'} ${c.name}\n${parsed.note || '(без комментария)'}\n`);
        acks.push(`${approved ? '✅ одобрено' : '⛔ отклонено'}: ${c.name}`);
        break;
      }
      case 'run':
        appendText(p.answers, `\n## ${stamp} — запрос ручного запуска\n${parsed.text}\n`);
        acks.push('▶️ Запрос записан. Запуск с ноутбука: mcfly run --mode day');
        break;
      case 'ignore': break;
      default:
        appendText(p.answers, `\n## ${stamp} — заметка\n${parsed.text}\n`);
        acks.push('📝 Записал как заметку для команды');
    }
  }
  saveQuestions(p, qdata);
  return acks;
}
