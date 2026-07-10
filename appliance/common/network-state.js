'use strict';

const os = require('os');

function classifyInterface(name) {
  const label = String(name || '').toLowerCase();
  if (/(wi[- ]?fi|wireless|wlan|802\.11)/.test(label)) return 'wifi';
  if (/(ethernet|eth\d+|en\d+|lan)/.test(label)) return 'ethernet';
  return 'other';
}

function summarizeAddresses(addrs) {
  return (Array.isArray(addrs) ? addrs : [])
    .filter((addr) => addr && !addr.internal)
    .map((addr) => ({
      address: addr.address || null,
      family: addr.family || null,
      cidr: addr.cidr || null,
      mac: addr.mac || null,
    }))
    .filter((addr) => !!addr.address);
}

function summarizeNetworkInterfaces(interfaces = os.networkInterfaces()) {
  const adapters = [];
  for (const [name, addrs] of Object.entries(interfaces || {})) {
    const addresses = summarizeAddresses(addrs);
    const kind = classifyInterface(name);
    adapters.push({
      name,
      kind,
      active: addresses.length > 0,
      addresses,
    });
  }

  const ethernet = adapters.filter((adapter) => adapter.kind === 'ethernet');
  const wifi = adapters.filter((adapter) => adapter.kind === 'wifi');
  const activeEthernet = ethernet.filter((adapter) => adapter.active);
  const activeWifi = wifi.filter((adapter) => adapter.active);

  return {
    wired_preferred: activeEthernet.length > 0,
    primary_transport: activeEthernet.length > 0
      ? 'ethernet'
      : (activeWifi.length > 0 ? 'wifi' : 'offline'),
    ethernet: {
      present: ethernet.length > 0,
      active: activeEthernet.length > 0,
      adapters: ethernet.map((adapter) => adapter.name),
      active_adapters: activeEthernet.map((adapter) => adapter.name),
      addresses: activeEthernet.flatMap((adapter) => adapter.addresses.map((addr) => addr.address)),
    },
    wifi: {
      present: wifi.length > 0,
      active: activeWifi.length > 0,
      adapters: wifi.map((adapter) => adapter.name),
      active_adapters: activeWifi.map((adapter) => adapter.name),
      addresses: activeWifi.flatMap((adapter) => adapter.addresses.map((addr) => addr.address)),
    },
    adapters,
  };
}

function detectNetworkState() {
  return summarizeNetworkInterfaces(os.networkInterfaces());
}

module.exports = {
  classifyInterface,
  detectNetworkState,
  summarizeNetworkInterfaces,
};
