/**
 * Раздел actions в mcfly/config.yaml (0.6.0): проверка и умолчания. Отдельно от actions.js — без импортов,
 * чтобы config.js не тянул runner.js по кругу.
 */
export const ACTION_ID_RE = /^[a-z0-9-]{1,20}$/;

export const ACTION_DEFAULTS = { title: '', describe: '', run: '', prepare: '', offer: '', followups: [], timeout_minutes: 60, confirm: true, during_run: false, vpn: false };

/** Ошибки раздела actions для validate (config.js). */
export function actionErrors(actions) {
  if (actions == null) return [];
  if (typeof actions !== 'object' || Array.isArray(actions)) return ['actions: словарь «идентификатор: настройки действия»'];
  const errors = [];
  for (const [id, a] of Object.entries(actions)) {
    const at = `actions.${id}`;
    if (!ACTION_ID_RE.test(id)) errors.push(`${at}: идентификатор — латиница в нижнем регистре, цифры и «-», до 20 знаков`);
    if (!a || typeof a !== 'object') { errors.push(`${at}: нужны настройки (title, run)`); continue; }
    if (!a.title || typeof a.title !== 'string') errors.push(`${at}.title: обязательная строка`);
    if (!a.run || typeof a.run !== 'string') errors.push(`${at}.run: обязательная команда`);
    for (const k of ['describe', 'prepare', 'offer']) if (a[k] != null && typeof a[k] !== 'string') errors.push(`${at}.${k}: строка`);
    if (a.timeout_minutes != null && !(a.timeout_minutes > 0)) errors.push(`${at}.timeout_minutes: больше 0`);
    for (const k of ['confirm', 'during_run', 'vpn']) if (a[k] != null && typeof a[k] !== 'boolean') errors.push(`${at}.${k}: true или false`);
    if (a.followups != null && !Array.isArray(a.followups)) errors.push(`${at}.followups: список идентификаторов`);
    for (const f of a.followups || []) if (!Object.hasOwn(actions, f)) errors.push(`${at}.followups: нет действия «${f}»`);
  }
  return errors;
}

/** Действие с умолчаниями или null. */
export function getAction(cfg, id) {
  const a = cfg.actions?.[id];
  return a && ACTION_ID_RE.test(id) ? { ...ACTION_DEFAULTS, ...a, id } : null;
}
export function listActions(cfg) { return Object.keys(cfg.actions || {}).map((id) => getAction(cfg, id)).filter(Boolean); }
export const hasActions = (cfg) => listActions(cfg).length > 0;

/** Разбор: «действия», «действие <id>», «действие <id> да <код>», «действие <id> отмена» (кнопки ac:/ax:/an: дают те же тексты). */
export function parseActionText(t) {
  const s = String(t || '').trim().replace(/^[^\p{L}\p{N}/]+/u, '').replace(/^(\/\w+)@\w+/, '$1').toLowerCase().replace(/ё/g, 'е').replace(/[\s?!.]+$/u, '');
  if (s === '/actions' || s === 'действия') return { type: 'actions' };
  const m = /^действие\s+([a-z0-9-]{1,20})(?:\s+(?:да\s+([0-9a-f]{6})|(отмена)))?$/.exec(s);
  if (!m) return null;
  if (m[2]) return { type: 'actionYes', id: m[1], code: m[2] };
  if (m[3]) return { type: 'actionNo', id: m[1] };
  return { type: 'action', id: m[1] };
}
