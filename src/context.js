import path from 'node:path';
import { readText, fmtShort, exists, truncate } from './util.js';
import { loadQuestions, openQuestions } from './questions.js';
import { listChanges, pendingApprovals, approvedWithWork, pausedChanges, priorityOf } from './approvals.js';
import { branchProgress, teamWorktrees } from './git.js';
import { autoDefault } from './config.js';
import { activeDayHandoff, validateHandoff, pruneHandoff } from './shift-files.js';
import { listActions } from './action-config.js';
import { loadIdeas, takenInOrder } from './ideas.js';
import { loadFindings, newFindings } from './findings.js';

export function isMcflyProject(p) { return exists(p.config); }

const PRODUCT_MAX = 15000; const GOALS_MAX = 3000;
const ownerDoc = (file) => readText(file, '').replace(/<!--[\s\S]*?-->/g, '').trim();
/** Описание продукта (mcfly/product.md, 0.10.0) без комментариев-подсказок; пустая строка — файла нет или в нём только шаблон. */
export const productText = (p) => ownerDoc(path.join(p.root, 'product.md'));
/** Есть описание продукта — включаются шаги удобства: образцы до одобрения и проход «пользователя». */
export const hasProduct = (p) => productText(p).length > 0;

export function buildContext(p, cfg, { progressLines = 15, handoff = false, now = new Date(), limit = cfg.limits.max_changes_per_run } = {}) {
  const L = [];
  const H_LIMIT = 6000;
  const h = handoff ? activeDayHandoff(p) : null;
  if (!handoff) { /* хук SessionStart дневной сессии: передача адресована ночи */ } else if (h) {
    const missing = validateHandoff(h.text);
    L.push(`## Передача смены (mcfly/shifts/${h.file}) — действуй по ней в рамках одобренного: неодобренное не трогай, при расхождении правы одобрения и спецификации${missing.length ? `; формат нарушен: нет разделов ${missing.join(', ')}` : ''}`);
    // 0.17.3: изменений, которых уже нет в openspec/changes, в передаче не показываем — иначе лид ставит их первыми в работу
    const { text, gone } = pruneHandoff(h.text, listChanges(p.openspecChanges).map((c) => c.name));
    if (gone.length) L.push(`Убрано из передачи — этих изменений уже нет в openspec/changes (завершены, удалены или переименованы), не бери их: ${gone.join(', ')}.`);
    L.push(text.length > H_LIMIT ? `${text.slice(0, H_LIMIT)}\n…передача обрезана, полный текст — в файле` : text.trim(), '');
  } else L.push('## Передача смены: нет — работай по приоритетам одобрений', '');
  L.push(`Проект: ${cfg.project}. Каталог: ${p.projectDir}.`);
  L.push(`Лимиты: прогон ${cfg.run.max_minutes} мин, не больше ${limit} изменений за прогон, не больше ${cfg.limits.max_tasks_per_change} задач на изменение.`);
  // 0.10.0: для кого делаем и что нельзя нарушать — раньше агенты этого не знали и удобство не проверял никто
  const cap = (t, n) => (t.length > n ? `${t.slice(0, n)}\n…обрезано, полный текст — в файле` : t);
  const product = productText(p);
  if (product) L.push('', '## Описание продукта (mcfly/product.md) — для кого делаем и правила, которые нельзя нарушать; файл ведёт владелец, не менять', cap(product, PRODUCT_MAX), '');
  const goals = ownerDoc(path.join(p.root, 'goals.md'));
  if (goals) L.push('', '## Цели проекта (mcfly/goals.md) — файл ведёт владелец, не менять (галочку у сделанного пункта бэклога mcfly ставит сам в конце прогона)', cap(goals, GOALS_MAX), '');
  const shared = cfg.worktree?.shared || [];
  if (shared.length) L.push(`Общие папки (worktree.shared): ${shared.join(', ')} — стоят в основном каталоге; разработчик первым шагом в своём worktree запускает \`mcfly worktree link\`. Нет папки в основном каталоге — поставить зависимости там до раздачи задач.`);
  const skills = cfg.design?.skills || [];
  if (skills.length) L.push(`Навыки дизайна (design.skills): ${skills.join(', ')} — в задачах с интерфейсом дизайнер и разработчик вызывают их инструментом Skill до начала работы; навык недоступен — сказать лиду, это попадёт в отчёт.`);
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
  for (const c of pend) L.push(`- ${c.name} (запрошено ${c.mcfly.requested_at ? fmtShort(new Date(c.mcfly.requested_at)) : '?'})${c.mcfly.held ? ' — возвращено владельцу командой, ждёт его решения: не реализовывать' : ''}`);
  const paused = pausedChanges(changes);
  if (paused.length) {
    L.push('', `Отложены владельцем до даты — не брать, не планировать заново (${paused.length}):`);
    for (const c of paused) L.push(`- ${c.name}: до ${c.mcfly.paused_until}${c.mcfly.pause_note ? ` — ${truncate(String(c.mcfly.pause_note).replace(/\s+/g, ' '), 160)}` : ''}`);
  }
  // 0.17.0: закрытые владельцем без работы — команда убирает их папки, чтобы прогоны на них не натыкались
  const closed = changes.filter((c) => c.mcfly.closed && c.mcfly.approval === 'rejected');
  if (closed.length) L.push('', `Закрыты владельцем без работы — в шаге 0 удали папку изменения (openspec/changes/<имя>) и его ветку change/<имя>, закоммить, работу по ним не веди (${closed.length}): ${closed.map((c) => c.name).join(', ')}`);
  const other = changes.filter((c) => !work.includes(c) && !pend.includes(c) && !paused.includes(c) && !closed.includes(c));
  if (other.length) { L.push('', 'Прочие изменения:'); for (const c of other) L.push(`- ${c.name}: одобрение=${c.mcfly.approval || 'не запрошено'}, задач открыто ${c.tasksOpen}`); }
  const worktrees = teamWorktrees(p.projectDir);
  const team = worktrees.filter((w) => w.team); const others = worktrees.filter((w) => !w.team);
  L.push('', `Worktree команды (${team.length}):`);
  for (const w of team) L.push(`- ${w.path}: ветка ${w.branch}, незакоммиченных файлов ${w.dirty}`);
  if (others.length) L.push(`Прочие worktree (не команды — не трогать): ${others.map((w) => `${w.path} (${w.branch})`).join(', ')}`);
  const acts = listActions(cfg);
  if (acts.length) {
    // 0.6.0: владелец делает это кнопкой в боте — в «Нужно от человека» ссылайтесь на кнопку, а не на скрипт или команду терминала
    L.push('', `Действия владельца в боте (кнопки в Telegram, задаёт только владелец; вам не запускать): ${acts.map((a) => { const b = acts.find((x) => x.id === a.after); return `«${a.title}» (${a.id})${b ? ` — только после «${b.title}»` : ''}${a.describe ? ` — ${a.describe}` : ''}`; }).join('; ')}. В «Нужно от человека» пишите «кнопка «<название>» в боте».`);
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
      // 0.10.0: жалобы владельца «неудобно: …» — раньше остальных взятых
      // 0.16.0: поднятые владельцем «⬆ Вперёд» — раньше всех; размер нужен для быстрого пути (ideas.fast_sizes)
      const taken = takenInOrder(d);
      const ux = taken.filter((x) => x.ux).map((x) => x.id); const first = taken.filter((x) => x.first_at).map((x) => x.id); const reverts = taken.filter((x) => x.revert_of).map((x) => `${x.id} — откат слияния изменения ${x.revert_of}`);
      const sized = cfg.ideas.fast_sizes?.length ? (list) => (list.length ? list.map((x) => `${x.id} [${x.size}] «${short(x.title)}»`).join(', ') : 'нет') : named;
      const marks = [first.length ? `${first.join(', ')} — владелец поднял «вперёд», планируй и делай их раньше всех` : '', ux.length ? `${ux.join(', ')} — жалобы «неудобно», планируй и делай их первыми` : '', reverts.length ? `возврат по кнопке владельца: ${reverts.join('; ')}` : ''].filter(Boolean);
      L.push(`Взятые владельцем — спланируй по порядку: ${sized(taken)}${marks.length ? ` (${marks.join('; ')})` : ''}`);
      L.push(`Спланированы: ${by(['planned']).map((x) => `${x.id} → ${x.change}`).join(', ') || 'нет'}`);
      L.push(`В списке: ${proposed.length} (ваших ${own}, команды ${proposed.length - own})`);
      L.push(`Не трогать, решение в сессии: ${named(by(['discuss', 'rejected']))}`);
    }
    L.push(`Бэклог владельца: ${cfg.ideas.backlog || 'не задан'}`);
  }
  if (cfg.findings?.enabled !== false) {
    // 0.11.0: проблемы самого mcfly команда не чинит, а регистрирует — владелец решает, передавать ли их в доработку
    const wait = newFindings(loadFindings(p));
    L.push('', `Находки для доработки самого mcfly (mcfly finding add): ждут решения владельца ${wait.length}${wait.length ? ` — не дублируй: ${wait.map((x) => `${x.id} «${truncate(x.text, 80)}»`).join(', ')}` : ''}`);
  }
  const q = openQuestions(loadQuestions(p));
  L.push('', `Открытые вопросы к человеку (${q.length}):`);
  for (const x of q) L.push(`- ${x.id} [${x.category}] ${x.text} — ${autoDefault(cfg, x.category) ? `по умолчанию: ${x.default || '(нет)'} — срок ${fmtShort(new Date(x.deadline_at))}` : 'без ответа по умолчанию: не выполнять, ждать решения человека'}`);
  const answers = readText(p.answers, '').trim();
  const entries = answers ? answers.split(/\n(?=## )/) : [];
  const recent = entries.slice(-5);
  // Заметки владельца за 3 дня — отдельно (0.7.2): одобрения и запуски не должны вытеснять их из пяти последних записей;
  // окно короткое — старые заметки обычно уже выполнены и сбивали бы приоритеты
  const since = now.getTime() - 3 * 24 * 3600_000;
  const notes = entries.slice(0, -5).filter((e) => {
    const m = /^## (\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}) — заметка( человека)?(\s|$)/.exec(e.trim()); // из Telegram — «— заметка», руками — «— заметка человека»
    return m && new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]).getTime() >= since;
  });
  if (notes.length) L.push('', 'Заметки владельца за 3 дня (новее — важнее):', notes.map((e) => e.trim()).join('\n'));
  L.push('', 'Последние ответы и заметки человека:', recent.join('\n') || '(нет)');
  const progress = readText(p.progress, '').trim().split('\n').slice(-progressLines).join('\n');
  L.push('', `Журнал (последние ${progressLines} строк):`, progress || '(пусто)');
  return L.join('\n');
}
