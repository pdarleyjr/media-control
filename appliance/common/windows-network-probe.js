'use strict';

const childProcess = require('child_process');

const PROBE_SCRIPT = [
  "$adapter=Get-NetAdapter -Physical -ErrorAction SilentlyContinue | Where-Object {$_.Status -eq 'Up'} | Sort-Object @{Expression={if($_.Name -match 'Ethernet|LAN'){0}else{1}}},Name | Select-Object -First 1",
  'if(-not $adapter){exit 0}',
  "$stats=Get-NetAdapterStatistics -Name $adapter.Name -ErrorAction SilentlyContinue",
  "$kiosk=Get-Process electron -ErrorAction SilentlyContinue | Sort-Object StartTime | Select-Object -First 1",
  '$kioskUptime=if($kiosk -and $kiosk.StartTime){[math]::Max(0,[int64]((Get-Date)-$kiosk.StartTime).TotalSeconds)}else{$null}',
  "$duplex=if($adapter.FullDuplex -eq $true){'Full'}elseif($adapter.FullDuplex -eq $false){'Half'}else{$null}",
  '[pscustomobject]@{',
  'adapter_name=$adapter.Name;',
  'adapter_description=$adapter.InterfaceDescription;',
  'link_speed_display=[string]$adapter.LinkSpeed;',
  'duplex=$duplex;',
  'driver_version=$adapter.DriverVersion;',
  'interface_errors=[int64](($stats.ReceivedPacketErrors)+($stats.OutboundPacketErrors));',
  'interface_discards=[int64](($stats.ReceivedDiscardedPackets)+($stats.OutboundDiscardedPackets));',
  'kiosk_uptime_sec=$kioskUptime',
  '} | ConvertTo-Json -Compress',
].join('\n');

function boundedString(value, max = 256) {
  if (value == null) return null;
  return String(value).slice(0, max);
}

function boundedNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function normalizeProbeResult(input) {
  if (!input || typeof input !== 'object') return null;
  return {
    adapter_name: boundedString(input.adapter_name),
    adapter_description: boundedString(input.adapter_description),
    link_speed_display: boundedString(input.link_speed_display, 64),
    duplex: boundedString(input.duplex, 32),
    driver_version: boundedString(input.driver_version, 64),
    interface_errors: boundedNumber(input.interface_errors),
    interface_discards: boundedNumber(input.interface_discards),
    kiosk_uptime_sec: boundedNumber(input.kiosk_uptime_sec),
  };
}

function createWindowsNetworkProbe(options = {}) {
  const platform = options.platform || process.platform;
  const execFileSync = options.execFileSync || childProcess.execFileSync;
  const ttlMs = Math.max(15_000, Number(options.ttlMs) || 60_000);
  const now = options.now || Date.now;
  let cached = null;
  let cachedAt = 0;

  return function probeWindowsNetwork() {
    if (platform !== 'win32') return null;
    const current = now();
    if (cachedAt && current - cachedAt < ttlMs) return cached;
    cachedAt = current;
    try {
      const raw = execFileSync('powershell.exe', [
        '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', PROBE_SCRIPT,
      ], { encoding: 'utf8', timeout: 5_000, windowsHide: true, maxBuffer: 256 * 1024 });
      cached = normalizeProbeResult(JSON.parse(String(raw || '').trim()));
    } catch (_) {
      cached = null;
    }
    return cached;
  };
}

module.exports = { createWindowsNetworkProbe, normalizeProbeResult };
