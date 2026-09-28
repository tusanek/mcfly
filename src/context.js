import { readText, fmtShort, exists } from './util.js';
import { loadQuestions, openQuestions } from './questions.js';
import { listChanges, pendingApprovals, approvedWithWork } from './approvals.js';

export function isMcflyProject(p) { return exists(p.config); }

export function buildContext(p, cfg, { progressLines = 15 } = {}) {
  const L = [];
  L.push(`Проект: ${cfg.project}. Каталог: ${p.projectDir}.`);
  L.push(`Лимиты: прогон ${cfg.run.max_minutes} мин, не больше ${cfg.limits.max_changes_per_run} изменений за прогон, не больше ${cfg.limits.max_tasks_per_change} задач на изменение.`);
  L.push(`Категории эскалации: ${Object.entries(cfg.escalation.categories).map(([k, v]) => `${k} (${v.label}${v.auto_default === false ? ', без ответа по умолчанию' : ''})`).join('; ')}.`);
  const changes = listChanges(p.openspecChanges);
  const work = approvedWithWork(changes);
  L.push('', `Одобренные изменения с открытыми задачами (${work.length}):`);
  for (const c of work) L.push(`- ${c.name}: ${c.tasksDone} сделано / ${c.tasksOpen} открыто`);
  const pend = pendingApprovals(changes);
  L.push('', `Ожидают одобрения (${pend.length}):`);
  for (const c of pend) L.push(`- ${c.name} (запрошено ${c.mcfly.requested_at ? fmtShort(new Date(c.mcfly.requested_at)) : '?'})`);
  const other = changes.filter((c) => !work.includes(c) && !pend.includes(c));
  if (other.length) { L.push('', 'Прочие изменения:'); for (const c of other) L.push(`- ${c.name}: одобрение=${c.mcfly.approval || 'не запрошено'}, задач открыто ${c.tasksOpen}`); }
  const q = openQuestions(loadQuestions(p));
  L.push('', `Открытые вопросы к человеку (${q.length}):`);
  for (const x of q) L.push(`- ${x.id} [${x.category}] ${x.text} — по умолчанию: ${x.default || '(нет)'} — срок ${fmtShort(new Date(x.deadline_at))}`);
  const answers = readText(p.answers, '').trim();
  const recent = answers ? answers.split(/\n(?=## )/).slice(-5).join('\n') : '';
  L.push('', 'Последние ответы и заметки человека:', recent || '(нет)');
  const progress = readText(p.progress, '').trim().split('\n').slice(-progressLines).join('\n');
  L.push('', `Журнал (последние ${progressLines} строк):`, progress || '(пусто)');
  return L.join('\n');
}
