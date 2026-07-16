const test = require('node:test');
const assert = require('node:assert/strict');

const {
  applyLinkTelemetry,
  classifyLinkSpeed,
  classifyInterface,
  parseLinkSpeedBps,
  summarizeNetworkInterfaces,
} = require('./network-state');

test('classifyInterface recognizes ethernet and wifi names', () => {
  assert.equal(classifyInterface('Ethernet'), 'ethernet');
  assert.equal(classifyInterface('Wi-Fi'), 'wifi');
  assert.equal(classifyInterface('wlan0'), 'wifi');
  assert.equal(classifyInterface('Loopback'), 'other');
});

test('summarizeNetworkInterfaces prefers ethernet when an ethernet adapter is up', () => {
  const state = summarizeNetworkInterfaces({
    Ethernet: [
      { address: '10.0.0.5', family: 'IPv4', internal: false, mac: 'aa:bb:cc:dd:ee:ff' },
    ],
    'Wi-Fi': [],
  });
  assert.equal(state.primary_transport, 'ethernet');
  assert.equal(state.wired_preferred, true);
  assert.equal(state.ethernet.active, true);
  assert.equal(state.wifi.active, false);
});

test('summarizeNetworkInterfaces falls back to wifi or offline when needed', () => {
  const wifiOnly = summarizeNetworkInterfaces({
    'Wi-Fi': [
      { address: '192.168.1.25', family: 'IPv4', internal: false, mac: 'aa:bb:cc:dd:ee:11' },
    ],
  });
  assert.equal(wifiOnly.primary_transport, 'wifi');
  assert.equal(wifiOnly.ethernet.active, false);
  assert.equal(wifiOnly.wifi.active, true);

  const offline = summarizeNetworkInterfaces({ Ethernet: [] });
  assert.equal(offline.primary_transport, 'offline');
  assert.equal(offline.wired_preferred, false);
});

test('parseLinkSpeedBps accepts Windows adapter speed labels', () => {
  assert.equal(parseLinkSpeedBps('100 Mbps'), 100_000_000);
  assert.equal(parseLinkSpeedBps('1 Gbps'), 1_000_000_000);
  assert.equal(parseLinkSpeedBps('2.5 Gbps'), 2_500_000_000);
  assert.equal(parseLinkSpeedBps('10 Gbps'), 10_000_000_000);
  assert.equal(parseLinkSpeedBps('0 bps'), 0);
});

test('classifyLinkSpeed marks 100 Mbps critical, 1 Gbps warning, and 2.5+ Gbps healthy', () => {
  assert.deepEqual(classifyLinkSpeed(100_000_000), {
    status: 'critical', degraded: true, degraded_reason: 'link_below_1_gbps',
  });
  assert.deepEqual(classifyLinkSpeed(1_000_000_000), {
    status: 'warning', degraded: true, degraded_reason: 'link_below_2_5_gbps_target',
  });
  assert.deepEqual(classifyLinkSpeed(2_500_000_000), {
    status: 'healthy', degraded: false, degraded_reason: null,
  });
  assert.deepEqual(classifyLinkSpeed(10_000_000_000), {
    status: 'healthy', degraded: false, degraded_reason: null,
  });
});

test('applyLinkTelemetry reports active degraded ethernet and selected server origin', () => {
  const state = summarizeNetworkInterfaces({
    'Ethernet 2': [{ address: '192.168.1.153', family: 'IPv4', cidr: '192.168.1.153/24', mac: 'aa', internal: false }],
  });
  const result = applyLinkTelemetry(state, {
    adapter_name: 'Ethernet 2',
    adapter_description: 'Cable Matters 10GbE Adapter',
    link_speed_display: '100 Mbps',
    duplex: 'Full',
    driver_version: '1.2.3',
    interface_errors: 0,
    interface_discards: 0,
  }, { server_url_category: 'lan' });

  assert.equal(result.transport, 'ethernet');
  assert.equal(result.link_speed_bps, 100_000_000);
  assert.equal(result.link_status, 'critical');
  assert.equal(result.degraded, true);
  assert.equal(result.server_origin, 'lan');
  assert.equal(result.server_url_category, 'lan');
});

test('applyLinkTelemetry preserves fallback origin reporting without adapter details', () => {
  const state = summarizeNetworkInterfaces({
    Tailscale: [{ address: '100.123.92.37', family: 'IPv4', cidr: '100.123.92.37/32', mac: '00', internal: false }],
  });
  const result = applyLinkTelemetry(state, null, { server_url_category: 'tailscale' });
  assert.equal(result.server_origin, 'tailscale');
  assert.equal(result.server_url_category, 'tailscale');
  assert.equal(result.link_speed_bps, null);
});
