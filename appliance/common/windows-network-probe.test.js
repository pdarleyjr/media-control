const test = require('node:test');
const assert = require('node:assert/strict');

const { createWindowsNetworkProbe, normalizeProbeResult } = require('./windows-network-probe');

test('normalizeProbeResult exposes only bounded non-secret adapter telemetry', () => {
  const result = normalizeProbeResult({
    adapter_name: 'Ethernet 2',
    adapter_description: 'Realtek USB Ethernet',
    link_speed_display: '2.5 Gbps',
    duplex: 'Full',
    driver_version: '11.1',
    interface_errors: 2,
    interface_discards: 3,
    kiosk_uptime_sec: 3600,
    ignored_secret: 'must-not-pass',
  });
  assert.deepEqual(result, {
    adapter_name: 'Ethernet 2',
    adapter_description: 'Realtek USB Ethernet',
    link_speed_display: '2.5 Gbps',
    duplex: 'Full',
    driver_version: '11.1',
    interface_errors: 2,
    interface_discards: 3,
    kiosk_uptime_sec: 3600,
  });
});

test('createWindowsNetworkProbe caches PowerShell results for the configured TTL', () => {
  let calls = 0;
  let now = 1_000;
  const probe = createWindowsNetworkProbe({
    platform: 'win32',
    ttlMs: 60_000,
    now: () => now,
    execFileSync: () => {
      calls += 1;
      return JSON.stringify({ adapter_name: 'Ethernet 2', link_speed_display: '100 Mbps' });
    },
  });

  assert.equal(probe().adapter_name, 'Ethernet 2');
  assert.equal(probe().adapter_name, 'Ethernet 2');
  assert.equal(calls, 1);
  now += 60_001;
  assert.equal(probe().adapter_name, 'Ethernet 2');
  assert.equal(calls, 2);
});

test('createWindowsNetworkProbe is inert off Windows and fails closed', () => {
  assert.equal(createWindowsNetworkProbe({ platform: 'linux' })(), null);
  const probe = createWindowsNetworkProbe({
    platform: 'win32',
    execFileSync: () => { throw new Error('probe failed'); },
  });
  assert.equal(probe(), null);
});
