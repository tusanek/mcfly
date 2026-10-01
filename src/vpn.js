import { spawnSync } from 'node:child_process';

const realSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Состояние системного VPN-сервиса macOS (`scutil --nc status`): Connected, Disconnected, Connecting… или null, если сервиса нет. */
export function vpnStatus(service, { scutil = 'scutil' } = {}) {
  const r = spawnSync(scutil, ['--nc', 'status', service], { encoding: 'utf8' });
  if (r.status !== 0) return null;
  return String(r.stdout || '').split('\n')[0].trim() || null;
}

/**
 * Поднимает VPN перед запросами к API: ночью туннель падает вместе с интернетом и сам не возвращается,
 * а без него Anthropic отвечает 403 «Request not allowed». action: skipped | none | reconnected | failed.
 */
export async function ensureVpn(service, { scutil = 'scutil', sleep = realSleep, timeoutMs = 60_000, pollMs = 3_000 } = {}) {
  if (!service) return { action: 'skipped', message: '' };
  const name = `VPN «${service}»`;
  const before = vpnStatus(service, { scutil });
  if (before === null) return { action: 'failed', message: `${name} не найден (scutil --nc list)` };
  if (before === 'Connected') return { action: 'none', message: '' };
  spawnSync(scutil, ['--nc', 'start', service], { encoding: 'utf8' });
  for (let waited = 0; ; waited += pollMs) {
    if (vpnStatus(service, { scutil }) === 'Connected') return { action: 'reconnected', message: `${name} был отключён — переподключил` };
    if (waited >= timeoutMs) return { action: 'failed', message: `${name} не подключился за ${Math.round(timeoutMs / 1000)} с (был ${before})` };
    await sleep(pollMs);
  }
}
