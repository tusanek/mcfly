import YAML from 'yaml';
import { readText } from './util.js';
import { actionErrors } from './action-config.js';
import { sharedErrors } from './worktree.js';

export const DEFAULT_CONFIG = {
  project: 'project',
  schedule: { slots: ['00:00', '04:00'], tolerance_minutes: 30, summary_at: '08:00', answers_every_minutes: 10, weekly_day: 7, weekly_at: '19:00', weekly_list: 'widget' },
  run: { max_minutes: 180, permission_mode: 'auto', model: '', max_budget_usd: 0, claude_bin: 'claude', lead_agent: 'mcfly:lead', extra_args: [], network_retries: 6, network_retry_minutes: 10, min_retry_minutes: 30, api_stall_minutes: 10, api_retry_span_minutes: 20, chain_max_weekly: 0.7, chain_max_five_hour: 0.9, chain_max_runs: 8, vpn_service: '', scutil_bin: 'scutil', telegram_start: true },
  escalation: {
    answer_deadline_hours: 24,
    approval_deadline_hours: 24,
    small_change_max_tasks: 6, // мелкое изменение — до 6 задач; 0 — мелких нет
    small_approval_deadline_hours: 4,
    categories: {
      spec: { label: 'Спецификация и критерии приёмки', auto_default: true },
      deps: { label: 'Внешние зависимости и платные ресурсы', auto_default: true },
      prod: { label: 'Прод-сервер, секреты, доступы', auto_default: false },
      budget: { label: 'Бюджет и расписание', auto_default: true },
      stuck: { label: 'Два неудачных подхода подряд', auto_default: true },
    },
  },
  telegram: { chat_id: '', token_env: 'MCFLY_TELEGRAM_TOKEN', owner_id: '' }, // owner_id — кто может запускать действия (0.6.0); пусто — личный чат chat_id
  // 0.16.0: max_changes_night — предел ночного прогона (0 — как max_changes_per_run); run_choices — кнопки «сколько берём» на «запусти» (пусто — без вопроса)
  limits: { max_changes_per_run: 2, max_changes_night: 0, max_tasks_per_change: 10, run_choices: [], followups_per_run: 0 }, // followups_per_run (0.17.0): доделок без одобрения за прогон, 0 — выключено
  // Ссылки в «статус» (0.6.1): { <подпись>: <адрес http(s)> }, например сайт продукта
  links: {},
  // Действия владельца из Telegram (0.6.0): { <id>: { title, run, describe?, prepare?, offer?, followups?, timeout_minutes?, confirm?, during_run?, vpn? } }
  actions: {},
  // Список предложений (0.7.0): enabled false — прежнее поведение (команда без одобренной работы планирует сама)
  ideas: { enabled: true, backlog: '', per_run: 2, per_idle_run: 4, show: 7, research: true, plan_ahead: 1, fast_sizes: [], fast_edits: false }, // fast_edits (0.17.0): мелкая правка существующего видимого по пункту S — тоже быстрым путём; // fast_sizes (0.16.0): размеры взятых пунктов, чей план без видимых изменений одобряется сразу
  // Навыки Claude Code для задач с интерфейсом (0.10.0), например ['impeccable']: их вызывают дизайнер и разработчик
  design: { skills: [] },
  // Общие папки в worktree команды (0.18.0), например ['miniapp/node_modules']: ставятся в основном каталоге, разработчик подключает ссылками (mcfly worktree link)
  worktree: { shared: [] },
  // Находки для доработки самого mcfly (0.11.0): агенты и сессии регистрируют, владелец одобряет в боте, одобренное — в общий ящик inbox
  findings: { enabled: true, inbox: '~/mcfly-inbox.md' },
  // Сводка коротким роликом с голосом (0.12.0): после текста сводки, отдельным сообщением; pronounce — { слово: как прочитать }
  video: { enabled: false, voice: 'eugene', voice_speed: 1.1, max_seconds: 60, weekly_max_seconds: 120, timeout_minutes: 15, director: 'review', director_minutes: 8, viewer_model: 'claude-haiku-5-5', pronounce: {} },
};

/** Потолок числа изменений за один прогон, заданного при запуске (флаг --changes, кнопка в боте). */
export const MAX_RUN_CHANGES = 20;
/** Сколько изменений берёт прогон (0.16.0): число, заданное при запуске → ночью limits.max_changes_night → limits.max_changes_per_run. */
export function maxChanges(cfg, mode = 'day', override = null) {
  const n = Number(override);
  if (Number.isInteger(n) && n >= 1) return Math.min(n, MAX_RUN_CHANGES);
  return mode === 'night' && cfg.limits.max_changes_night > 0 ? cfg.limits.max_changes_night : cfg.limits.max_changes_per_run;
}

function merge(base, over) {
  if (over === undefined || over === null) return base;
  if (Array.isArray(base) || Array.isArray(over)) return over;
  if (base && typeof base === 'object' && typeof over === 'object') {
    const out = { ...base };
    for (const [k, v] of Object.entries(over)) out[k] = merge(base[k], v);
    return out;
  }
  return over;
}

export function validate(cfg) {
  const errors = [];
  if (!cfg.project || typeof cfg.project !== 'string') errors.push('project: обязательное строковое поле');
  for (const s of cfg.schedule.slots) if (!/^\d{2}:\d{2}$/.test(String(s))) errors.push(`schedule.slots: неверный слот "${s}" (нужно HH:MM)`);
  if (!/^\d{2}:\d{2}$/.test(String(cfg.schedule.summary_at))) errors.push('schedule.summary_at: нужно HH:MM');
  if (!(Number.isInteger(cfg.schedule.weekly_day) && cfg.schedule.weekly_day >= 0 && cfg.schedule.weekly_day <= 7)) errors.push('schedule.weekly_day: день недельной сводки от 1 (понедельник) до 7 (воскресенье), 0 — без неё');
  if (!['widget', 'rich', 'text', 'off'].includes(cfg.schedule.weekly_list)) errors.push('schedule.weekly_list: widget (виджетом Telegram), rich (расширенным сообщением), text (текстом) или off (не присылать полный список)');
  if (!/^\d{2}:\d{2}$/.test(String(cfg.schedule.weekly_at))) errors.push('schedule.weekly_at: нужно HH:MM');
  if (!(Number.isInteger(cfg.schedule.answers_every_minutes) && cfg.schedule.answers_every_minutes >= 0)) errors.push('schedule.answers_every_minutes: целое число от 0');
  if (!(cfg.run.max_minutes > 0)) errors.push('run.max_minutes: должно быть больше 0');
  if (!(Number.isInteger(cfg.run.network_retries) && cfg.run.network_retries >= 0)) errors.push('run.network_retries: целое число от 0');
  if (!(cfg.run.network_retry_minutes > 0)) errors.push('run.network_retry_minutes: должно быть больше 0');
  if (!(cfg.run.min_retry_minutes >= 0)) errors.push('run.min_retry_minutes: число от 0');
  if (!(cfg.run.api_stall_minutes > 0)) errors.push('run.api_stall_minutes: должно быть больше 0');
  if (!(cfg.run.api_retry_span_minutes > 0)) errors.push('run.api_retry_span_minutes: должно быть больше 0');
  if (!(cfg.run.chain_max_weekly >= 0 && cfg.run.chain_max_weekly <= 1)) errors.push('run.chain_max_weekly: доля от 0 до 1 (0 — без цепочки)');
  if (!(cfg.run.chain_max_five_hour > 0 && cfg.run.chain_max_five_hour <= 1)) errors.push('run.chain_max_five_hour: доля больше 0 и не больше 1');
  if (!(Number.isInteger(cfg.run.chain_max_runs) && cfg.run.chain_max_runs >= 0)) errors.push('run.chain_max_runs: целое число от 0');
  if (!(Number.isInteger(cfg.escalation.small_change_max_tasks) && cfg.escalation.small_change_max_tasks >= 0)) errors.push('escalation.small_change_max_tasks: целое число от 0');
  if (!(cfg.escalation.small_approval_deadline_hours > 0)) errors.push('escalation.small_approval_deadline_hours: должно быть больше 0');
  const modes = ['acceptEdits', 'auto', 'bypassPermissions', 'default', 'dontAsk', 'plan'];
  if (!modes.includes(cfg.run.permission_mode)) errors.push(`run.permission_mode: одно из ${modes.join(', ')}`);
  errors.push(...actionErrors(cfg.actions));
  const ideas = cfg.ideas || {};
  if (typeof ideas.enabled !== 'boolean') errors.push('ideas.enabled: true или false');
  if (typeof ideas.research !== 'boolean') errors.push('ideas.research: true или false');
  if (typeof ideas.backlog !== 'string') errors.push('ideas.backlog: строка — где бэклог владельца');
  for (const k of ['per_run', 'per_idle_run']) if (!(Number.isInteger(ideas[k]) && ideas[k] >= 0)) errors.push(`ideas.${k}: целое число от 0`);
  if (!(Number.isInteger(ideas.show) && ideas.show >= 1)) errors.push('ideas.show: целое число от 1');
  if (!(Number.isInteger(ideas.plan_ahead) && ideas.plan_ahead >= 1)) errors.push('ideas.plan_ahead: целое число от 1 — сколько планов держать на одобрении');
  if (!(Array.isArray(ideas.fast_sizes) && ideas.fast_sizes.every((x) => ['S', 'M', 'L'].includes(x)))) errors.push('ideas.fast_sizes: список размеров S, M, L — планы по таким взятым пунктам без видимых изменений одобряются сразу; [] — выключено');
  if (typeof ideas.fast_edits !== 'boolean') errors.push('ideas.fast_edits: true или false — мелкая правка существующего видимого без второго одобрения');
  const limits = cfg.limits || {};
  if (!(Number.isInteger(limits.followups_per_run) && limits.followups_per_run >= 0)) errors.push('limits.followups_per_run: целое число от 0 — сколько доделок без одобрения за прогон (0 — выключено)');
  for (const k of ['max_changes_per_run', 'max_tasks_per_change']) if (!(Number.isInteger(limits[k]) && limits[k] >= 1)) errors.push(`limits.${k}: целое число от 1`);
  if (!(Number.isInteger(limits.max_changes_night) && limits.max_changes_night >= 0)) errors.push('limits.max_changes_night: целое число от 0 (0 — как max_changes_per_run)');
  if (!(Array.isArray(limits.run_choices) && limits.run_choices.length <= 4 && limits.run_choices.every((x) => Number.isInteger(x) && x >= 1 && x <= MAX_RUN_CHANGES))) errors.push(`limits.run_choices: до четырёх целых чисел от 1 до ${MAX_RUN_CHANGES}, например [1, 3, 5]; [] — бот не спрашивает, сколько брать`);
  errors.push(...sharedErrors(cfg.worktree?.shared));
  const skills = cfg.design?.skills;
  if (!Array.isArray(skills) || skills.some((x) => typeof x !== 'string' || !/^[\w:.-]+$/.test(x))) errors.push('design.skills: список названий навыков, например [impeccable]');
  if (typeof cfg.findings?.enabled !== 'boolean') errors.push('findings.enabled: true или false');
  if (typeof cfg.findings?.inbox !== 'string' || !cfg.findings.inbox.trim()) errors.push('findings.inbox: путь к файлу общего ящика, например ~/mcfly-inbox.md');
  const video = cfg.video || {};
  if (typeof video.enabled !== 'boolean') errors.push('video.enabled: true или false');
  if (!['aidar', 'baya', 'kseniya', 'eugene', 'xenia'].includes(video.voice)) errors.push('video.voice: один из голосов aidar, baya, kseniya, eugene, xenia');
  if (!(typeof video.voice_speed === 'number' && video.voice_speed >= 0.9 && video.voice_speed <= 1.3)) errors.push('video.voice_speed: скорость голоса от 0.9 до 1.3');
  if (!(video.max_seconds >= 20 && video.max_seconds <= 180)) errors.push('video.max_seconds: от 20 до 180');
  if (!(video.weekly_max_seconds >= 30 && video.weekly_max_seconds <= 300)) errors.push('video.weekly_max_seconds: от 30 до 300');
  if (!(video.timeout_minutes > 0 && video.timeout_minutes <= 60)) errors.push('video.timeout_minutes: больше 0 и не больше 60');
  if (!['off', 'on', 'review'].includes(video.director)) errors.push('video.director: off (сцены ролика собирает код), on (сценарий пишет режиссёр) или review (режиссёр и зритель)');
  if (!(typeof video.director_minutes === 'number' && video.director_minutes >= 1 && video.director_minutes <= 30)) errors.push('video.director_minutes: число от 1 до 30');
  else if (video.director !== 'off' && !(video.director_minutes < video.timeout_minutes)) errors.push('video.director_minutes: меньше video.timeout_minutes — иначе на сборку ролика не останется времени');
  if (typeof video.viewer_model !== 'string' || !/^[\w.:-]*$/.test(video.viewer_model)) errors.push('video.viewer_model: название модели зрителя или пустая строка — модель роли');
  if (!video.pronounce || typeof video.pronounce !== 'object' || Array.isArray(video.pronounce) || Object.values(video.pronounce).some((v) => typeof v !== 'string')) errors.push('video.pronounce: словарь «слово: как прочитать»');
  if (!cfg.links || typeof cfg.links !== 'object' || Array.isArray(cfg.links)) errors.push('links: словарь «подпись: адрес»');
  else for (const [k, v] of Object.entries(cfg.links)) if (!/^https?:\/\/[^\s"<>]+$/.test(String(v))) errors.push(`links.${k}: адрес http:// или https:// без пробелов, кавычек и <>`);
  if (errors.length) throw new Error('Ошибки в mcfly/config.yaml:\n- ' + errors.join('\n- '));
  return cfg;
}

export function parseConfig(text) {
  const raw = text.trim() ? YAML.parse(text) : {};
  return validate(merge(DEFAULT_CONFIG, raw || {}));
}
export function loadConfig(configPath) { return parseConfig(readText(configPath, '')); }
/** Решает ли категория эскалации сама по истечении срока. Неизвестная категория — нет: молчание не должно одобрять то, чего нет в списке. */
export function autoDefault(cfg, category) {
  return isCategory(cfg, category) && cfg.escalation.categories[category].auto_default !== false;
}
/** Категория эскалации из конфигурации (только собственные ключи: «toString» и прочее унаследованное — не категории). */
export const isCategory = (cfg, category) => Object.hasOwn(cfg.escalation.categories, String(category));
