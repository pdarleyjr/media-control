const test = require('node:test');
const assert = require('node:assert/strict');

const {
  classifyInterface,
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
