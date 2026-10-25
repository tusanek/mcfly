import { appendText, fmtLocal } from './util.js';
import { loadQuestions, saveQuestions, answerQuestion } from './questions.js';
import { listChanges, setApproval } from './approvals.js';
import { viewOf } from './overview.js';
import { commandText } from './util.js';
import { parseActionText } from './action-config.js';
import { loadIdeas, saveIdeas, addIdea, transitionIdea, findIdea } from './ideas.js';

export function parseMessage(text) {
  const t = String(text || '').trim();
  let m;
  if ((m = /^#?\s*(Q\d+)\s*[:：\-–—]?\s*([\s\S]*)$/i.exec(t)) && m[2].trim()) return { type: 'answer', id: m[1].toUpperCase(), text: m[2].trim() };
  // Список предложений (0.7.0): «берём I7», «не сейчас I7 причина» — кнопки ib:/ix: под «💡 Предложения».
  if ((m = /^(?:берём|берем|беру)\s+(I\d+)\s*$/i.exec(t))) return { type: 'take', id: m[1].toUpperCase() };
  if ((m = /^не\s+сейчас\s+(I\d+)\s*([\s\S]*)$/i.exec(t))) return { type: 'defer', id: m[1].toUpperCase(), note: m[2].trim() };
  if ((m = /^(?:approve|ok|одобряю|одобрить|да)\s+([\w.-]+)\s*([\s\S]*)$/i.exec(t))) return { type: 'approve', change: m[1], note: m[2].trim() };
  if ((m = /^(?:reject|отклоняю|отклонить|нет)\s+([\w.-]+)\s*([\s\S]*)$/i.exec(t))) return { type: 'reject', change: m[1], note: m[2].trim() };
  // Действия владельца (0.6.0): «действия», «действие deploy», кнопки ac:/ax:/an: — отвечает pull.js (actions.js), сюда не пишутся.
  const action = parseActionText(t);
  if (action) return action;
  // Команды обзора («статус», /status, кнопки внизу чата) только читают состояние: их отвечает pull.js, сюда они не пишутся.
  const view = viewOf(t);
  if (view) return { type: 'view', view };
  // «предложения 2» — страница списка (кнопка «Ещё ▸», il:2)
  if ((m = /^(?:\/ideas|предложения|идеи) (\d+)$/.exec(commandText(t)))) return { type: 'view', view: 'ideas', page: Number(m[1]) };
  // «▶️ Запусти» — кнопка внизу чата, /run — меню команд.
  if (/^\/?(?:run|запусти|запуск)(?:@\w+)?(?:\s|$)/i.test(t.replace(/^[^\p{L}\p{N}/]+/u, ''))) return { type: 'run', text: t };
  // Идея владельца в список предложений: «идея: текст» или «💡 текст» (после команд обзора — кнопка «💡 Предложения» не идея).
  if ((m = /^(?:идея\s*[:：\-–—]|💡)\s*([\s\S]*)$/iu.exec(t))) return { type: 'idea', text: m[1].trim() };
  return { type: 'note', text: t };
}

/**
 * Ответ свайпом на сообщение с вопросом: текст без «Qn:» становится ответом на тот вопрос, если в исходном сообщении
 * ровно один открытый вопрос. Иначе — как раньше (заметка): Q12 прежде повторялся, потому что заметка вопрос не закрывала.
 */
export function withReplyQuestion(parsed, replyTo, qdata) {
  if (parsed.type !== 'note' || !replyTo) return parsed;
  const open = new Set(qdata.questions.filter((q) => q.status === 'open').map((q) => q.id));
  const ids = [...new Set(String(replyTo).match(/\bQ\d+\b/g) || [])].filter((id) => open.has(id));
  return ids.length === 1 ? { type: 'answer', id: ids[0], text: parsed.text } : parsed;
}

const ALREADY = {
  planned: (take) => (take ? 'уже спланирован — план ждёт решения в «Статусе»' : 'уже спланирован — «⏸ Не сейчас» под планом в «Статусе»'),
  discuss: () => 'уже отложен — обсудим в сессии',
  rejected: () => 'уже отклонён в сессии',
  done: () => 'уже сделан',
};
/** Ответ свайпом на сообщение с ровно одним отложенным пунктом (Iн) — причина «не сейчас» для него. */
export function withReplyIdea(parsed, replyTo, idata) {
  if (parsed.type !== 'note' || !replyTo) return parsed;
  const ids = [...new Set(String(replyTo).match(/\bI\d+\b/g) || [])].filter((id) => findIdea(idata, id)?.status === 'discuss');
  return ids.length === 1 ? { type: 'ideaNote', id: ids[0], text: parsed.text } : parsed;
}

/** Применяет сообщения человека к состоянию проекта; возвращает строки-подтверждения для ответа в чат. */
export function applyMessages(p, messages, { now = new Date(), by = 'human', onRun = null } = {}) {
  const acks = [];
  const qdata = loadQuestions(p);
  const changes = listChanges(p.openspecChanges);
  const stamp = fmtLocal(now);
  const idata = loadIdeas(p); let ideasDirty = false;
  const broken = `⚠️ ${idata.error} — список предложений не изменён`;
  for (const msg of messages) {
    const parsed = withReplyIdea(withReplyQuestion(parseMessage(msg.text), msg.replyTo, qdata), msg.replyTo, idata);
    switch (parsed.type) {
      case 'take': case 'defer': {
        if (idata.error) { acks.push(broken); break; }
        const take = parsed.type === 'take';
        // Старая кнопка по пункту, который уже ушёл дальше, — понятное «уже …»; «Не сейчас» по спланированному — только под планом
        const was = findIdea(idata, parsed.id);
        const already = was && ALREADY[was.status]?.(take);
        if (already) { acks.push(`ℹ️ ${was.id} ${already}`); break; }
        const { idea, error } = transitionIdea(idata, parsed.id, take ? 'taken' : 'discuss', { actor: 'bot', note: parsed.note || '', now });
        if (!idea) { acks.push(`⚠️ ${parsed.id}: такого предложения нет`); break; }
        if (error) { acks.push(`ℹ️ ${idea.id}: ${error}`); break; }
        ideasDirty = true;
        appendText(p.answers, `\n## ${stamp} — ${take ? 'взято' : 'не сейчас'} ${idea.id}\n${take ? idea.title : (parsed.note || '(без причины)')}\n`);
        acks.push(take ? `✅ ${idea.id} взято — план пришлёт ближайший прогон` : `⏸ ${idea.id} отложено — обсудим в сессии`);
        break;
      }
      case 'idea': {
        if (!parsed.text) { acks.push('⚠️ Пустая идея — напишите текст после «идея:»'); break; }
        if (idata.error) { acks.push(broken); break; }
        const [title, ...rest] = parsed.text.split('\n');
        try {
          const idea = addIdea(idata, { title, benefit: rest.join('\n').trim() || 'см. название', source: 'owner-note', size: 'M', now });
          ideasDirty = true;
          appendText(p.answers, `\n## ${stamp} — идея владельца ${idea.id}\n${parsed.text}\n`);
          acks.push(`💡 ${idea.id} записал в предложения`);
        } catch (e) { acks.push(`ℹ️ ${e.message}`); }
        break;
      }
      case 'ideaNote': {
        findIdea(idata, parsed.id).discuss_note = parsed.text; ideasDirty = true;
        appendText(p.answers, `\n## ${stamp} — причина «не сейчас» ${parsed.id}\n${parsed.text}\n`);
        acks.push(`📝 ${parsed.id}: причина записана`);
        break;
      }
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
        // План по пункту (0.7.0): «отклонить» в Telegram — «не сейчас», пункт уходит на обсуждение в сессии, команда его не перерабатывает.
        if (!approved && c.mcfly.idea && !idata.error) {
          const r = transitionIdea(idata, c.mcfly.idea, 'discuss', { actor: 'bot', note: `план отклонён в Telegram: ${c.name}${parsed.note ? `, ${parsed.note}` : ''}`, now });
          if (!r.error) {
            ideasDirty = true;
            appendText(p.answers, `\n## ${stamp} — не сейчас ${c.name} (${c.mcfly.idea})\n${parsed.note || '(без комментария)'}\n`);
            acks.push(`⏸ ${c.name}: не сейчас — пункт ${r.idea.id} ждёт обсуждения в сессии`);
            break;
          }
        }
        appendText(p.answers, `\n## ${stamp} — ${approved ? 'одобрено' : 'отклонено'} ${c.name}\n${parsed.note || '(без комментария)'}\n`);
        acks.push(`${approved ? '✅ одобрено' : '⛔ отклонено'}: ${c.name}`);
        break;
      }
      case 'run':
        appendText(p.answers, `\n## ${stamp} — запрос ручного запуска\n${parsed.text}\n`);
        acks.push(onRun ? onRun(parsed.text) : '▶️ Запрос записан. Запуск с ноутбука: mcfly run --mode day');
        break;
      case 'view': case 'actions': case 'action': case 'actionYes': case 'actionNo': break;
      default:
        appendText(p.answers, `\n## ${stamp} — заметка\n${parsed.text}\n`);
        acks.push('📝 Записал как заметку для команды');
    }
  }
  saveQuestions(p, qdata);
  if (ideasDirty) saveIdeas(p, idata);
  return acks;
}
