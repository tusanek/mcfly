import { spawnSync } from 'node:child_process';

// 0.11.3: launchd не будит спящий Mac. Если он засыпает от сети при погасшем экране, работает от аккумулятора
// или закрыт, ночные прогоны, опрос кнопок бота и «запусти» с телефона молча не срабатывают.

/** `pmset -g custom` → через сколько минут Mac засыпает от сети и от аккумулятора (0 — никогда, null — неизвестно). */
export function parsePmsetCustom(text) {
  const out = { acSleep: null, battSleep: null };
  let section = null;
  for (const line of String(text || '').split('\n')) {
    const head = line.match(/^(\S.*):\s*$/);
    if (head) { section = head[1] === 'AC Power' ? 'acSleep' : head[1] === 'Battery Power' ? 'battSleep' : null; continue; }
    const m = line.match(/^\s+sleep\s+(\d+)/); // «Sleep On Power Button» — другая настройка
    if (m && section) out[section] = Number(m[1]);
  }
  return out;
}

/** `pmset -g batt` → true, если сейчас питание от аккумулятора; null — не удалось понять. */
export function parseOnBattery(text) {
  const m = String(text || '').match(/Now drawing from '([^']+)'/);
  return m ? m[1] === 'Battery Power' : null;
}

/** `ioreg -r -k AppleClamshellState -d 1` → true, если крышка закрыта; null — крышки нет или не удалось понять. */
export function parseLidClosed(text) {
  const m = String(text || '').match(/"AppleClamshellState"\s*=\s*(Yes|No)/);
  return m ? m[1] === 'Yes' : null;
}

function runCmd(bin, args) {
  try { const r = spawnSync(bin, args, { encoding: 'utf8', timeout: 10_000 }); return r.status === 0 ? r.stdout : null; } catch { return null; }
}

/** Состояние питания Mac. Команда не сработала — соответствующее поле null. */
export function readPower({ run = runCmd } = {}) {
  return {
    ...parsePmsetCustom(run('pmset', ['-g', 'custom'])),
    onBattery: parseOnBattery(run('pmset', ['-g', 'batt'])),
    lidClosed: parseLidClosed(run('ioreg', ['-r', '-k', 'AppleClamshellState', '-d', '1'])),
  };
}

/** Проверки для `mcfly doctor`: [{ ok, label, hint }]. О том, чего узнать не удалось, молчим. */
export function powerChecks({ acSleep, battSleep, onBattery, lidClosed }) {
  const checks = [];
  const stops = 'ночные прогоны, кнопки бота и «запусти» с телефона молча не сработают';
  if (acSleep === 0) checks.push({ ok: true, label: 'Mac не засыпает от сети (pmset: sleep 0)', hint: '' });
  else if (acSleep > 0) checks.push({ ok: false, label: `Mac засыпает от сети через ${acSleep} мин без действий — ${stops}`, hint: 'выполните: sudo pmset -c sleep 0 (или включите в «Системные настройки → Аккумулятор → Параметры» запрет сна от сети при выключенном дисплее)' });
  if (onBattery) checks.push({ ok: false, label: `ноутбук сейчас работает от аккумулятора${battSleep > 0 ? ` и заснёт через ${battSleep} мин без действий` : ''} — ${stops}`, hint: 'подключите зарядку' });
  if (lidClosed) checks.push({ ok: false, label: `крышка ноутбука закрыта: без зарядки и внешнего экрана Mac спит — ${stops}`, hint: 'откройте крышку или держите подключёнными зарядку и внешний экран' });
  return checks;
}
