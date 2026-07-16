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

function parseLinkSpeedBps(value) {
  if (Number.isFinite(value)) return Math.max(0, Number(value));
  const text = String(value || '').trim();
  const match = /^([0-9]+(?:\.[0-9]+)?)\s*([kmgt]?)(?:bps|b\/s)$/i.exec(text);
  if (!match) return null;
  const scale = { '': 1, k: 1e3, m: 1e6, g: 1e9, t: 1e12 }[match[2].toLowerCase()];
  return Math.round(Number(match[1]) * scale);
}

function classifyLinkSpeed(linkSpeedBps) {
  const speed = Number(linkSpeedBps);
  if (!Number.isFinite(speed) || speed <= 0) {
    return { status: 'unknown', degraded: true, degraded_reason: 'link_speed_unknown' };
  }
  if (speed < 1e9) {
    return { status: 'critical', degraded: true, degraded_reason: 'link_below_1_gbps' };
  }
  if (speed < 2.5e9) {
    return { status: 'warning', degraded: true, degraded_reason: 'link_below_2_5_gbps_target' };
  }
  return { status: 'healthy', degraded: false, degraded_reason: null };
}

function applyLinkTelemetry(state, adapterDetails, options = {}) {
  const network = state && typeof state === 'object' ? state : {};
  const details = adapterDetails && typeof adapterDetails === 'object' ? adapterDetails : {};
  const speed = parseLinkSpeedBps(details.link_speed_bps ?? details.link_speed_display);
  const classification = network.primary_transport === 'ethernet'
    ? classifyLinkSpeed(speed)
    : { status: 'not_applicable', degraded: false, degraded_reason: null };
  const serverCategory = String(options.server_url_category || 'unknown');

  return {
    ...network,
    adapter_name: details.adapter_name || null,
    adapter_description: details.adapter_description || null,
    transport: network.primary_transport || 'offline',
    link_speed_bps: speed,
    link_speed_display: details.link_speed_display || null,
    link_status: classification.status,
    duplex: details.duplex || null,
    driver_version: details.driver_version || null,
    interface_errors: Number.isFinite(Number(details.interface_errors)) ? Number(details.interface_errors) : null,
    interface_discards: Number.isFinite(Number(details.interface_discards)) ? Number(details.interface_discards) : null,
    server_origin: serverCategory,
    server_url_category: serverCategory,
    degraded: classification.degraded,
    degraded_reason: classification.degraded_reason,
  };
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
  applyLinkTelemetry,
  classifyLinkSpeed,
  classifyInterface,
  detectNetworkState,
  parseLinkSpeedBps,
  summarizeNetworkInterfaces,
};
