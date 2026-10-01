import YAML from 'yaml';
import { readText } from './util.js';

export const DEFAULT_CONFIG = {
  project: 'project',
  schedule: { slots: ['00:00', '04:00'], tolerance_minutes: 30, summary_at: '08:00', answers_every_minutes: 10 },
  run: { max_minutes: 180, permission_mode: 'auto', model: '', max_budget_usd: 0, claude_bin: 'claude', lead_agent: 'mcfly:lead', extra_args: [], network_retries: 6, network_retry_minutes: 10, vpn_service: '', scutil_bin: 'scutil' },
  escalation: {
    answer_deadline_hours: 24,
    approval_deadline_hours: 24,
    categories: {
      spec: { label: 'Спецификация и критерии приёмки', auto_default: true },
      deps: { label: 'Внешние зависимости и платные ресурсы', auto_default: true },
      prod: { label: 'Прод-сервер, секреты, доступы', auto_default: false },
      budget: { label: 'Бюджет и расписание', auto_default: true },
      stuck: { label: 'Два неудачных подхода подряд', auto_default: true },
    },
  },
  telegram: { chat_id: '', token_env: 'MCFLY_TELEGRAM_TOKEN' },
  limits: { max_changes_per_run: 2, max_tasks_per_change: 10 },
};

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
  if (!(Number.isInteger(cfg.schedule.answers_every_minutes) && cfg.schedule.answers_every_minutes >= 0)) errors.push('schedule.answers_every_minutes: целое число от 0');
  if (!(cfg.run.max_minutes > 0)) errors.push('run.max_minutes: должно быть больше 0');
  if (!(Number.isInteger(cfg.run.network_retries) && cfg.run.network_retries >= 0)) errors.push('run.network_retries: целое число от 0');
  if (!(cfg.run.network_retry_minutes > 0)) errors.push('run.network_retry_minutes: должно быть больше 0');
  const modes = ['acceptEdits', 'auto', 'bypassPermissions', 'default', 'dontAsk', 'plan'];
  if (!modes.includes(cfg.run.permission_mode)) errors.push(`run.permission_mode: одно из ${modes.join(', ')}`);
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
