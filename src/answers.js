import { appendText, fmtLocal } from './util.js';
import { loadQuestions, saveQuestions, answerQuestion } from './questions.js';
import { listChanges, setApproval, moveFirst, closeChange } from './approvals.js';
import { viewOf } from './overview.js';
import { commandText } from './util.js';
import { parseActionText } from './action-config.js';
import { loadIdeas, saveIdeas, addIdea, transitionIdea, findIdea, markFirst, closeIdea, isArchived } from './ideas.js';
import path from 'node:path';
import { loadFindings, saveFindings, addFinding, decideFinding, newFindings } from './findings.js';
import { parseReminder, addReminder, cancelReminder, snoozeReminder, whenText } from './reminders.js';

export function parseMessage(text) {
  const t = String(text || '').trim();
  let m;
  if ((m = /^#?\s*(Q\d+)\s*[:：\-–—]?\s*([\s\S]*)$/i.exec(t)) && m[2].trim()) return { type: 'answer', id: m[1].toUpperCase(), text: m[2].trim() };
  // Список предложений (0.7.0): «берём I7», «не сейчас I7 причина» — кнопки ib:/ix: под «💡 Предложения».
  if ((m = /^(?:берём|берем|беру)\s+(I\d+)\s*$/i.exec(t))) return { type: 'take', id: m[1].toUpperCase() };
  if ((m = /^не\s+сейчас\s+(I\d+)\s*([\s\S]*)$/i.exec(t))) return { type: 'defer', id: m[1].toUpperCase(), note: m[2].trim() };
  // «⬆ Вперёд» (0.16.0): «вперёд I7» или «вперёд имя-изменения» — первым в очереди; кнопка up:
  if ((m = /^впер[её]д\s+([\w.-]+)\s*$/i.exec(t))) return { type: 'first', target: m[1] };
  // 0.17.0: «закрыть I7» / «закрыть имя» — закрыть без работы (кнопка cl:); «вернуть имя» — отменить сделанное без одобрения (кнопка rv:).
  // Обычная фраза с этими словами («закрыть вопрос») остаётся заметкой: applyMessages проверяет, что такое изменение или пункт есть.
  if ((m = /^закрыть\s+([\w.-]+)\s*$/i.exec(t))) return { type: 'close', target: m[1], text: t };
  if ((m = /^вернуть\s+([\w.-]+)\s*$/i.exec(t))) return { type: 'revert', change: m[1], text: t };
  if ((m = /^(?:approve|ok|одобряю|одобрить|да)\s+([\w.-]+)\s*([\s\S]*)$/i.exec(t))) return { type: 'approve', change: m[1], note: m[2].trim() };
  if ((m = /^(?:reject|отклоняю|отклонить|нет)\s+([\w.-]+)\s*([\s\S]*)$/i.exec(t))) return { type: 'reject', change: m[1], note: m[2].trim() };
  // Образцы (0.10.0): «образец имя» (кнопка sh:) — отвечает pull.js; «образец кнопка» — нажатие ненастоящей кнопки под образцом.
  if (/^образец кнопка$/i.test(t)) return { type: 'sampleTap' };
  if ((m = /^образец\s+([\w.-]+)\s*$/i.exec(t))) return { type: 'sample', change: m[1] };
  // Жалоба на удобство (0.10.0): «неудобно: текст» — пункт списка сразу взят и планируется раньше остальных.
  if ((m = /^неудобно\s*[:：\-–—]\s*([\s\S]*)$/iu.exec(t))) return { type: 'ux', text: m[1].trim() };
  // Находки для доработки mcfly (0.11.0): «mcfly: текст» — находка владельца, сразу в общий ящик; кнопки fb:/fx: — «передать Fн», «не надо Fн».
  if ((m = /^mcfly\s*[:：]\s*([\s\S]*)$/i.exec(t))) return { type: 'finding', text: m[1].trim() };
  if ((m = /^передать\s+(F\d+|все|всё)\s*$/i.exec(t))) return { type: 'findingSend', id: m[1].toUpperCase() };
  if ((m = /^не\s+надо\s+(F\d+)\s*$/i.exec(t))) return { type: 'findingDrop', id: m[1].toUpperCase() };
  // Напоминания (0.8.0): «напомни 19:00 текст», «напоминания» (список — отвечает pull.js), кнопки rs:/rx: — «отложить Rн», «отменить Rн».
  if ((m = /^напомни(?:те|ть)?(?=[\s,:]|$)[\s,:]*([\s\S]*)$/i.exec(t))) return { type: 'remind', text: m[1].trim() };
  if ((m = /^(?:отменить|отмени)\s+(R\d+)\s*$/i.exec(t))) return { type: 'remindCancel', id: m[1].toUpperCase() };
  if ((m = /^отложить\s+(R\d+)\s*$/i.exec(t))) return { type: 'remindSnooze', id: m[1].toUpperCase() };
  if (/^(?:\/reminders|напоминания)$/.test(commandText(t))) return { type: 'reminders' };
  // Действия владельца (0.6.0): «действия», «действие deploy», кнопки ac:/ax:/an: — отвечает pull.js (actions.js), сюда не пишутся.
  const action = parseActionText(t);
  if (action) return action;
  // Команды обзора («статус», /status, кнопки внизу чата) только читают состояние: их отвечает pull.js, сюда они не пишутся.
  const view = viewOf(t);
  if (view) return { type: 'view', view };
  // «предложения 2» — страница списка (кнопка «Ещё ▸», il:2)
  if ((m = /^(?:\/ideas|предложения|идеи) (\d+)$/.exec(commandText(t)))) return { type: 'view', view: 'ideas', page: Number(m[1]) };
  // «▶️ Запусти» — кнопка внизу чата, /run — меню команд.
  if (/^\/?(?:run|запусти|запуск)(?:@\w+)?(?:\s|$)/i.test(t.replace(/^[^\p{L}\p{N}/]+/u, ''))) {
    // 0.16.0: «запусти 3» — сколько изменений взять за прогон (кнопки rn:3)
    const n = /\s(\d{1,2})\s*$/.exec(t); // число — последним словом: «запусти в 19 часов» числом изменений не считается
    return { type: 'run', text: t, ...(n && Number(n[1]) >= 1 ? { changes: Number(n[1]) } : {}) };
  }
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
export function applyMessages(p, messages, { now = new Date(), by = 'human', onRun = null, cfg = null } = {}) {
  const fcfg = cfg || { project: path.basename(p.projectDir), findings: {} };
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
      case 'ux': {
        if (!parsed.text) { acks.push('⚠️ Напишите после «неудобно:», что именно неудобно'); break; }
        if (idata.error) { acks.push(broken); break; }
        const [title, ...rest] = parsed.text.split('\n');
        try {
          const idea = addIdea(idata, { title, benefit: rest.join('\n').trim() || 'жалоба владельца на удобство — исправить раньше новых функций', source: 'owner-note', size: 'S', now });
          // Без кнопки «Берём»: жалоба владельца — уже решение; ux — команда планирует её первой
          transitionIdea(idata, idea.id, 'taken', { actor: 'bot', note: 'жалоба «неудобно»', now });
          idea.ux = true; ideasDirty = true;
          appendText(p.answers, `\n## ${stamp} — неудобно ${idea.id}\n${parsed.text}\n`);
          acks.push(`😖 ${idea.id} принял — команда займётся этим первым делом, раньше новых функций`);
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
      case 'first': {
        // 0.16.0: поднять взятый пункт или изменение в начало очереди — решение владельца, команда его не меняет
        const isIdea = /^I\d+$/i.test(parsed.target);
        let name = parsed.target; let label = parsed.target;
        if (isIdea) {
          if (idata.error) { acks.push(broken); break; }
          const it = findIdea(idata, parsed.target);
          if (!it) { acks.push(`⚠️ ${parsed.target.toUpperCase()}: такого предложения нет`); break; }
          label = it.id;
          if (it.status === 'taken') {
            markFirst(idata, it.id, now); ideasDirty = true;
            appendText(p.answers, `\n## ${stamp} — вперёд ${it.id}\n${it.title}\n`);
            acks.push(`⬆ ${it.id} — первым в очереди: ближайший прогон начнёт с него`); break;
          }
          if (it.status !== 'planned' || !it.change) { acks.push(`ℹ️ ${it.id}: поднять можно взятый или спланированный пункт`); break; }
          name = it.change;
        }
        const r = moveFirst(changes, name);
        if (!r.change) { acks.push(`⚠️ ${label}: такого изменения нет`); break; }
        if (r.error) { acks.push(`ℹ️ ${label}: ${r.error}`); break; }
        appendText(p.answers, `\n## ${stamp} — вперёд ${r.change.name}\n`);
        acks.push(`⬆ ${label} — первым в очереди${r.change.mcfly.approval === 'pending' ? ' (план ещё ждёт вашего одобрения)' : ''}`);
        break;
      }
      case 'close': {
        // 0.17.0: закрыть без работы — решение владельца: изменение отклоняется с пометкой closed, его пункты закрываются окончательно
        const isIdea = /^I\d+$/i.test(parsed.target);
        const it = isIdea && !idata.error ? findIdea(idata, parsed.target) : null;
        const c = changes.find((x) => x.name === (it?.change || parsed.target) && x.mcfly.approval !== 'rejected') || null;
        if (!c && !(it && ['taken', 'planned', 'discuss'].includes(it.status))) {
          if (it) { acks.push(`ℹ️ ${it.id}: закрыть можно взятый, спланированный или отложенный пункт`); break; }
          appendText(p.answers, `\n## ${stamp} — заметка\n${parsed.text}\n`); acks.push('📝 Записал как заметку для команды'); break;
        }
        const ids = c ? (c.mcfly.ideas || (c.mcfly.idea ? [c.mcfly.idea] : [])) : [it.id];
        if (c) closeChange(c, by, '', now);
        const closed = [];
        if (!idata.error) for (const id of ids) { const r = closeIdea(idata, id, c ? `закрыто без работы вместе с планом ${c.name}` : '', now); if (!r.error) { closed.push(r.idea.id); ideasDirty = true; } }
        const what = [c ? c.name : '', ...closed].filter(Boolean).join(', ');
        appendText(p.answers, `\n## ${stamp} — закрыто без работы ${what}\n`);
        acks.push(`🗑 ${what}: закрыто без работы${c ? ' — команда уберёт план в ближайшем прогоне' : ''}`);
        break;
      }
      case 'revert': {
        // 0.17.0: «↩ Вернуть» — взятый пункт «вернуть изменение», поднятый вперёд; его план идёт быстрым путём (revert_of)
        if (!isArchived(p.openspecChanges, parsed.change)) { appendText(p.answers, `\n## ${stamp} — заметка\n${parsed.text}\n`); acks.push('📝 Записал как заметку для команды'); break; }
        if (idata.error) { acks.push(broken); break; }
        if (cfg && !cfg.ideas?.enabled) { acks.push('ℹ️ Список предложений выключен — напишите команде заметкой, что вернуть'); break; }
        const had = idata.ideas.find((x) => x.revert_of === parsed.change && ['taken', 'planned'].includes(x.status));
        if (had) { acks.push(`ℹ️ ${parsed.change}: возврат уже в очереди (${had.id})`); break; }
        try {
          const idea = addIdea(idata, { title: `Вернуть изменение ${parsed.change}`, benefit: 'владелец нажал «Вернуть»: отменить это изменение и вернуть прежнее поведение (откат его слияния), с тестами', source: 'owner-note', size: 'S', now, newArguments: 'повторный возврат' });
          transitionIdea(idata, idea.id, 'taken', { actor: 'bot', note: 'кнопка «Вернуть»', now });
          idea.revert_of = parsed.change; idea.first_at = now.toISOString(); ideasDirty = true;
          appendText(p.answers, `\n## ${stamp} — вернуть ${parsed.change} (${idea.id})\n`);
          acks.push(`↩ Принял: ближайший прогон вернёт ${parsed.change} как было (${idea.id}, первым в очереди)`);
        } catch (e) { acks.push(`ℹ️ ${e.message}`); }
        break;
      }
      case 'run':
        appendText(p.answers, `\n## ${stamp} — запрос ручного запуска\n${parsed.text}\n`);
        acks.push(onRun ? onRun(parsed.text, parsed.changes || null) : '▶️ Запрос записан. Запуск с ноутбука: mcfly run --mode day');
        break;
      // Напоминания живут в mcfly/logs/reminders.json, в answers.md не пишутся: команде они не нужны.
      case 'remind': {
        const r = parseReminder(parsed.text, now);
        if (r.error) { acks.push(r.error); break; }
        const x = addReminder(p, { at: r.at, text: r.text, now });
        acks.push(`🔔 ${x.id}: напомню ${whenText(r.at, now)} — ${x.text}`);
        break;
      }
      case 'finding': {
        if (!parsed.text) { acks.push('⚠️ Напишите после «mcfly:», что не так в самом mcfly'); break; }
        const fdata = loadFindings(p);
        if (fdata.error) { acks.push(`⚠️ ${fdata.error} — находка не записана`); break; }
        try {
          // Своё сообщение владельца одобрения не ждёт — сразу в ящик
          const item = addFinding(fdata, { text: parsed.text, source: 'owner', now });
          const r = decideFinding(fdata, fcfg, item.id, 'send', { now });
          saveFindings(p, fdata);
          acks.push(r.error ? `⚠️ ${item.id} записал, но ${r.error}. Повторите кнопкой в «находки»` : `📮 ${item.id} передал в ящик доработки mcfly`);
        } catch (e) { acks.push(`ℹ️ ${e.message}`); }
        break;
      }
      case 'findingSend': case 'findingDrop': {
        const fdata = loadFindings(p);
        if (fdata.error) { acks.push(`⚠️ ${fdata.error} — решение не записано`); break; }
        const send = parsed.type === 'findingSend';
        const ids = /^F\d+$/.test(parsed.id) ? [parsed.id] : newFindings(fdata).map((x) => x.id);
        if (!ids.length) { acks.push('ℹ️ Новых находок нет'); break; }
        for (const id of ids) {
          const r = decideFinding(fdata, fcfg, id, send ? 'send' : 'drop', { now });
          if (!r.item) acks.push(`⚠️ ${id}: такой находки нет`);
          else if (r.error) acks.push(`${r.item.status === 'new' ? '⚠️' : 'ℹ️'} ${r.item.id}: ${r.error}`);
          else acks.push(send ? `📮 ${r.item.id} передал в ящик доработки mcfly` : `🚫 ${r.item.id} убрал — передавать не буду`);
        }
        saveFindings(p, fdata);
        break;
      }
      case 'remindCancel': acks.push(cancelReminder(p, parsed.id, now)); break;
      case 'remindSnooze': acks.push(snoozeReminder(p, parsed.id, now)); break;
      case 'sample': case 'sampleTap': case 'reminders': case 'view': case 'actions': case 'action': case 'actionYes': case 'actionNo': break;
      default:
        appendText(p.answers, `\n## ${stamp} — заметка\n${parsed.text}\n`);
        acks.push('📝 Записал как заметку для команды');
    }
  }
  saveQuestions(p, qdata);
  if (ideasDirty) saveIdeas(p, idata);
  return acks;
}
