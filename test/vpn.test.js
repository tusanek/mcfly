import test from 'node:test';
import assert from 'node:assert/strict';
import { vpnStatus, ensureVpn } from '../src/vpn.js';
import { fakeScutil } from './helpers.js';

const noSleep = async () => {};

test('vpnStatus: состояние сервиса, null для неизвестного', () => {
  const up = fakeScutil({ service: 'Sota Connect' });
  assert.equal(vpnStatus('Sota Connect', { scutil: up.script }), 'Connected');
  assert.equal(vpnStatus('Нет такого', { scutil: up.script }), null);
  const down = fakeScutil({ state: 'Disconnected' });
  assert.equal(vpnStatus(down.service, { scutil: down.script }), 'Disconnected');
});
test('ensureVpn: без сервиса в конфигурации ничего не делает', async () => {
  assert.equal((await ensureVpn('', { sleep: noSleep })).action, 'skipped');
});
test('ensureVpn: подключённый VPN не трогает', async () => {
  const f = fakeScutil();
  const r = await ensureVpn(f.service, { scutil: f.script, sleep: noSleep });
  assert.equal(r.action, 'none');
  assert.deepEqual(f.calls(), [`status ${f.service}`]);
});
test('ensureVpn: отключённый VPN запускает и ждёт подключения', async () => {
  const f = fakeScutil({ state: 'Disconnected' });
  const r = await ensureVpn(f.service, { scutil: f.script, sleep: noSleep });
  assert.equal(r.action, 'reconnected');
  assert.ok(f.calls().includes(`start ${f.service}`));
  assert.match(r.message, /был отключён — переподключил/);
});
test('ensureVpn: VPN не поднялся за отведённое время — failed', async () => {
  const f = fakeScutil({ state: 'Disconnected', stuck: true });
  const r = await ensureVpn(f.service, { scutil: f.script, sleep: noSleep, timeoutMs: 9000, pollMs: 3000 });
  assert.equal(r.action, 'failed');
  assert.match(r.message, /не подключился/);
});
test('ensureVpn: неизвестный сервис — failed с подсказкой', async () => {
  const f = fakeScutil();
  const r = await ensureVpn('Опечатка', { scutil: f.script, sleep: noSleep });
  assert.equal(r.action, 'failed');
  assert.match(r.message, /не найден/);
});
