import { execFile } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const port = Number.parseInt(process.env.PODIUM_AGENT_PORT || '8755', 10);
const roomId = process.env.ROOM_ID || 'classroom-1';
const deviceId = process.env.DEVICE_ID || 'classroom-1-podium-console';
const appVersion = process.env.APP_VERSION || '0.1.0';

type JsonValue = Record<string, unknown> | Array<unknown> | string | number | boolean | null;

function log(message: string, details?: unknown) {
  const line = JSON.stringify({ timestamp: new Date().toISOString(), service: 'mbfd-podium-agent', message, details: details ?? null });
  console.log(line);
  try {
    fs.appendFileSync('/var/log/mbfd-podium-agent.log', `${line}\n`);
  } catch {
    try {
      const dir = path.join(os.homedir(), '.local', 'state', 'mbfd-podium-agent');
      fs.mkdirSync(dir, { recursive: true });
      fs.appendFileSync(path.join(dir, 'agent.log'), `${line}\n`);
    } catch { /* journald stdout remains available */ }
  }
}

function json(res: http.ServerResponse, status: number, body: JsonValue) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(JSON.stringify(body));
}

async function command(name: string, args: string[] = [], timeout = 5000) {
  const { stdout } = await execFileAsync(name, args, { timeout, windowsHide: true, maxBuffer: 1024 * 1024 });
  return stdout.trim();
}

function readOsRelease() {
  try {
    const raw = fs.readFileSync('/etc/os-release', 'utf8');
    const values: Record<string, string> = {};
    for (const line of raw.split(/\r?\n/)) {
      const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
      if (!match) continue;
      values[match[1]] = match[2].replace(/^"|"$/g, '');
    }
    return values.PRETTY_NAME || values.NAME || os.type();
  } catch {
    return `${os.type()} ${os.release()}`;
  }
}

function networkInterfaces() {
  const result: Array<Record<string, unknown>> = [];
  for (const [name, entries] of Object.entries(os.networkInterfaces())) {
    for (const entry of entries || []) {
      if (entry.family !== 'IPv4' || entry.internal) continue;
      result.push({ name, address: entry.address, netmask: entry.netmask, mac: entry.mac });
    }
  }
  return result;
}

async function tailscaleIp() {
  const interfaces = networkInterfaces();
  const fromInterface = interfaces.find((entry) => String(entry.name).toLowerCase().includes('tailscale'));
  if (fromInterface?.address) return String(fromInterface.address);
  try { return await command('tailscale', ['ip', '-4'], 3000); }
  catch { return null; }
}

async function displayResolution() {
  try {
    const output = await command('wlr-randr', [], 3000);
    const match = output.match(/(\d+x\d+) px/);
    if (match) return { source: 'wlr-randr', resolution: match[1], raw: output.slice(0, 2000) };
  } catch { /* fallback */ }
  try {
    const output = await command('xrandr', ['--current'], 3000);
    const match = output.match(/current\s+(\d+)\s+x\s+(\d+)/);
    if (match) return { source: 'xrandr', resolution: `${match[1]}x${match[2]}`, raw: output.slice(0, 2000) };
  } catch { /* fallback */ }
  return { source: 'unknown', resolution: null };
}

async function usbStatus() {
  try {
    const output = await command('lsblk', ['-J', '-o', 'NAME,RM,TYPE,MOUNTPOINTS,LABEL,SIZE,MODEL'], 5000);
    const parsed = JSON.parse(output) as { blockdevices?: Array<Record<string, unknown>> };
    const devices = (parsed.blockdevices || []).filter((device) => Number(device.rm) === 1 || String(device.type) === 'part');
    return { detected: devices.length > 0, devices };
  } catch (error) {
    return { detected: false, devices: [], error: error instanceof Error ? error.message : String(error) };
  }
}

async function devicePayload() {
  return {
    hostname: os.hostname(),
    room_id: roomId,
    device_id: deviceId,
    app_version: appVersion,
    os: readOsRelease(),
    platform: os.platform(),
    arch: os.arch(),
    uptime_seconds: Math.round(os.uptime()),
    ip_addresses: networkInterfaces(),
    tailscale_ip: await tailscaleIp(),
    display: await displayResolution(),
  };
}

async function networkPayload() {
  const github = await probe('https://github.com');
  const mbfd = await probe('https://mbfdhub.com');
  return {
    interfaces: networkInterfaces(),
    tailscale_ip: await tailscaleIp(),
    checks: { github, mbfd },
  };
}

async function probe(url: string) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    const response = await fetch(url, { method: 'GET', signal: controller.signal });
    return { ok: response.ok, status: response.status };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  } finally {
    clearTimeout(timer);
  }
}

async function restartConsole() {
  if (process.platform !== 'linux') return { ok: false, skipped: true, reason: 'systemd actions are Linux-only' };
  await command('systemctl', ['restart', 'mbfd-console.service'], 15000);
  return { ok: true };
}

async function rebootDevice() {
  if (process.platform !== 'linux') return { ok: false, skipped: true, reason: 'reboot is Linux-only' };
  await command('systemctl', ['reboot'], 15000);
  return { ok: true };
}

async function disableKiosk() {
  if (process.platform !== 'linux') return { ok: false, skipped: true, reason: 'systemd actions are Linux-only' };
  const actions = [
    ['disable', '--now', 'mbfd-console.service'],
    ['set-default', 'graphical.target'],
  ];
  const results = [];
  for (const args of actions) {
    try { results.push({ args, stdout: await command('systemctl', args, 15000) }); }
    catch (error) { results.push({ args, error: error instanceof Error ? error.message : String(error) }); }
  }
  try { results.push({ args: ['start', 'display-manager.service'], stdout: await command('systemctl', ['start', 'display-manager.service'], 15000) }); }
  catch (error) { results.push({ args: ['start', 'display-manager.service'], error: error instanceof Error ? error.message : String(error) }); }
  return { ok: true, results };
}

async function route(req: http.IncomingMessage, res: http.ServerResponse) {
  const url = new URL(req.url || '/', 'http://127.0.0.1');
  log('request', { method: req.method, path: url.pathname });
  try {
    if (req.method === 'GET' && url.pathname === '/health') return json(res, 200, { ok: true, service: 'mbfd-podium-agent', room_id: roomId, device_id: deviceId });
    if (req.method === 'GET' && url.pathname === '/device') return json(res, 200, await devicePayload());
    if (req.method === 'GET' && url.pathname === '/network') return json(res, 200, await networkPayload());
    if (req.method === 'GET' && url.pathname === '/usb/status') return json(res, 200, await usbStatus());
    if (req.method === 'POST' && url.pathname === '/app/restart') return json(res, 200, await restartConsole());
    if (req.method === 'POST' && url.pathname === '/device/reboot') return json(res, 200, await rebootDevice());
    if (req.method === 'POST' && url.pathname === '/kiosk/disable') return json(res, 200, await disableKiosk());
    return json(res, 404, { error: 'not found' });
  } catch (error) {
    log('request failed', { error: error instanceof Error ? error.message : String(error) });
    return json(res, 500, { error: error instanceof Error ? error.message : 'request failed' });
  }
}

const server = http.createServer((req, res) => {
  const remote = req.socket.remoteAddress;
  if (remote && !['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(remote)) {
    log('non-local request rejected', { remote });
    return json(res, 403, { error: 'localhost only' });
  }
  void route(req, res);
});

server.listen(port, '127.0.0.1', () => {
  log('podium agent listening', { host: '127.0.0.1', port, room_id: roomId, device_id: deviceId });
});

process.on('SIGTERM', () => {
  log('shutdown requested');
  server.close(() => process.exit(0));
});
