import { readText, fmtShort, exists, truncate } from './util.js';
import { loadQuestions, openQuestions } from './questions.js';
import { listChanges, pendingApprovals, approvedWithWork, priorityOf } from './approvals.js';
import { branchProgress, teamWorktrees } from './git.js';
import { autoDefault } from './config.js';
import { activeDayHandoff, validateHandoff } from './shift-files.js';
import { listActions } from './action-config.js';
import { loadIdeas } from './ideas.js';

export function isMcflyProject(p) { return exists(p.config); }

export function buildContext(p, cfg, { progressLines = 15, handoff = false, now = new Date() } = {}) {
  const L = [];
  const H_LIMIT = 6000;
  const h = handoff ? activeDayHandoff(p) : null;
  if (!handoff) { /* хук SessionStart дневной сессии: передача адресована ночи */ } else if (h) {
    const missing = validateHandoff(h.text);
    L.push(`## Передача смены (mcfly/shifts/${h.file}) — действуй по ней в рамках одобренного: неодобренное не трогай, при расхождении правы одобрения и спецификации${missing.length ? `; формат нарушен: нет разделов ${missing.join(', ')}` : ''}`);
    L.push(h.text.length > H_LIMIT ? `${h.text.slice(0, H_LIMIT)}\n…передача обрезана, полный текст — в файле` : h.text.trim(), '');
  } else L.push('## Передача смены: нет — работай по приоритетам одобрений', '');
  L.push(`Проект: ${cfg.project}. Каталог: ${p.projectDir}.`);
  L.push(`Лимиты: прогон ${cfg.run.max_minutes} мин, не больше ${cfg.limits.max_changes_per_run} изменений за прогон, не больше ${cfg.limits.max_tasks_per_change} задач на изменение.`);
  L.push(`Категории эскалации: ${Object.entries(cfg.escalation.categories).map(([k, v]) => `${k} (${v.label}${v.auto_default === false ? ', без ответа по умолчанию' : ''})`).join('; ')}.`);
  const changes = listChanges(p.openspecChanges);
  const work = approvedWithWork(changes);
  L.push('', `Одобренные изменения с открытыми задачами (${work.length}):`);
  for (const c of work) {
    const onBranch = branchProgress(p.projectDir, c.name);
    L.push(`- ${c.name} (приоритет ${priorityOf(c)}): ${c.tasksDone} сделано / ${c.tasksOpen} открыто${onBranch ? `; на ветке change/${c.name}: ${onBranch.done} сделано / ${onBranch.open} открыто` : ''}`);
  }
  const pend = pendingApprovals(changes);
  L.push('', `Ожидают одобрения (${pend.length}):`);
  for (const c of pend) L.push(`- ${c.name} (запрошено ${c.mcfly.requested_at ? fmtShort(new Date(c.mcfly.requested_at)) : '?'})`);
  const other = changes.filter((c) => !work.includes(c) && !pend.includes(c));
  if (other.length) { L.push('', 'Прочие изменения:'); for (const c of other) L.push(`- ${c.name}: одобрение=${c.mcfly.approval || 'не запрошено'}, задач открыто ${c.tasksOpen}`); }
  const worktrees = teamWorktrees(p.projectDir);
  const team = worktrees.filter((w) => w.team); const others = worktrees.filter((w) => !w.team);
  L.push('', `Worktree команды (${team.length}):`);
  for (const w of team) L.push(`- ${w.path}: ветка ${w.branch}, незакоммиченных файлов ${w.dirty}`);
  if (others.length) L.push(`Прочие worktree (не команды — не трогать): ${others.map((w) => `${w.path} (${w.branch})`).join(', ')}`);
  const acts = listActions(cfg);
  if (acts.length) {
    // 0.6.0: владелец делает это кнопкой в боте — в «Нужно от человека» ссылайтесь на кнопку, а не на скрипт или команду терминала
    L.push('', `Действия владельца в боте (кнопки в Telegram, задаёт только владелец; вам не запускать): ${acts.map((a) => `«${a.title}» (${a.id})${a.describe ? ` — ${a.describe}` : ''}`).join('; ')}. В «Нужно от человека» пишите «кнопка «<название>» в боте».`);
  }
  if (cfg.ideas?.enabled) {
    // 0.7.0: новые изменения — только по взятым владельцем пунктам; отложенные и отклонённые решает владелец в сессии
    const d = loadIdeas(p); const by = (s) => d.ideas.filter((x) => s.includes(x.status));
    // Названия пишут владелец и команда (в том числе по страницам из интернета): в контекст — одной строкой и коротко.
    const short = (s) => truncate(String(s || '').replace(/[\u0000-\u001f\u007f\s]+/g, ' ').trim(), 120);
    const named = (list) => (list.length ? list.map((x) => `${x.id} «${short(x.title)}»`).join(', ') : 'нет');
    L.push('', 'Предложения (mcfly/ideas.yaml):');
    if (d.error) L.push(`⚠️ ${d.error} — список не прочитан, mcfly ideas add не сработает; сообщи в отчёте`);
    else {
      const proposed = by(['proposed']); const own = proposed.filter((x) => x.source === 'owner-backlog' || x.source === 'owner-note').length;
      L.push(`Взятые владельцем — спланируй по порядку: ${named(by(['taken']))}`);
      L.push(`Спланированы: ${by(['planned']).map((x) => `${x.id} → ${x.change}`).join(', ') || 'нет'}`);
      L.push(`В списке: ${proposed.length} (ваших ${own}, команды ${proposed.length - own})`);
      L.push(`Не трогать, решение в сессии: ${named(by(['discuss', 'rejected']))}`);
    }
    L.push(`Бэклог владельца: ${cfg.ideas.backlog || 'не задан'}`);
  }
  const q = openQuestions(loadQuestions(p));
  L.push('', `Открытые вопросы к человеку (${q.length}):`);
  for (const x of q) L.push(`- ${x.id} [${x.category}] ${x.text} — ${autoDefault(cfg, x.category) ? `по умолчанию: ${x.default || '(нет)'} — срок ${fmtShort(new Date(x.deadline_at))}` : 'без ответа по умолчанию: не выполнять, ждать решения человека'}`);
  const answers = readText(p.answers, '').trim();
  const entries = answers ? answers.split(/\n(?=## )/) : [];
  const recent = entries.slice(-5);
  // Заметки владельца за 7 дней — отдельно (0.7.2): одобрения и запуски не должны вытеснять их из пяти последних записей
  const weekAgo = now.getTime() - 7 * 24 * 3600_000;
  const notes = entries.slice(0, -5).filter((e) => {
    const m = /^## (\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}) — заметка человека/.exec(e.trim());
    return m && new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]).getTime() >= weekAgo;
  });
  if (notes.length) L.push('', 'Заметки владельца за 7 дней (действуют, пока он их не отменил):', notes.map((e) => e.trim()).join('\n'));
  L.push('', 'Последние ответы и заметки человека:', recent.join('\n') || '(нет)');
  const progress = readText(p.progress, '').trim().split('\n').slice(-progressLines).join('\n');
  L.push('', `Журнал (последние ${progressLines} строк):`, progress || '(пусто)');
  return L.join('\n');
}
