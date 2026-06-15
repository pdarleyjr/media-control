import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
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
const usbMountBase = process.env.USB_MOUNT_BASE || '/mnt/mbfd-usb';
const usbStagingBase = process.env.USB_STAGING_DIR || '/var/lib/mbfd/podium-agent/usb-staging';

const allowedUsbExtensions = new Set(['.pdf', '.ppt', '.pptx', '.doc', '.docx', '.jpg', '.jpeg', '.png', '.webp', '.mp4', '.mov', '.mkv']);
const blockedUsbExtensions = new Set(['.exe', '.msi', '.bat', '.cmd', '.ps1', '.sh', '.scr', '.vbs', '.js', '.jar', '.iso']);
const scannedFiles = new Map<string, UsbFile>();
const stagedFiles = new Map<string, StagedUsbFile>();

type JsonValue = Record<string, unknown> | Array<unknown> | string | number | boolean | null;
type BlockDevice = {
  name?: string;
  rm?: number | boolean | string;
  type?: string;
  mountpoint?: string | null;
  mountpoints?: Array<string | null> | string | null;
  label?: string | null;
  size?: string | null;
  model?: string | null;
  fstype?: string | null;
  children?: BlockDevice[];
};
type UsbMount = { name: string; device: string; mountPoint: string; label: string | null; size: string | null; model: string | null; mountedByAgent: boolean };
type UsbFile = { id: string; device: string; mountPoint: string; relativePath: string; name: string; size: number; extension: string; mime_type: string; modified_at: string | null };
type StagedUsbFile = UsbFile & { stagedId: string; stagedPath: string; url: string };

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

function writeCors(req: http.IncomingMessage, res: http.ServerResponse) {
  const origin = String(req.headers.origin || '');
  const allowed = origin === 'null'
    || origin.startsWith('http://localhost')
    || origin.startsWith('http://127.0.0.1')
    || origin === 'https://media-control.mbfdhub.com';
  if (allowed && origin) res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
  res.setHeader('Access-Control-Max-Age', '600');
}

function json(req: http.IncomingMessage, res: http.ServerResponse, status: number, body: JsonValue) {
  writeCors(req, res);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(JSON.stringify(body));
}

function parseJsonBody(req: http.IncomingMessage) {
  return new Promise<Record<string, unknown>>((resolve, reject) => {
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > 64 * 1024) reject(new Error('request body too large'));
    });
    req.on('end', () => {
      if (!raw.trim()) return resolve({});
      try { resolve(JSON.parse(raw) as Record<string, unknown>); }
      catch { reject(new Error('invalid JSON body')); }
    });
    req.on('error', reject);
  });
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
    const mounts = await usbMounts(false);
    return { detected: mounts.length > 0, devices: mounts };
  } catch (error) {
    return { detected: false, devices: [], error: error instanceof Error ? error.message : String(error) };
  }
}

function isRemovable(value: unknown) {
  return value === true || value === 1 || value === '1';
}

function deviceMountpoints(device: BlockDevice) {
  const raw = device.mountpoints ?? device.mountpoint ?? [];
  const points = Array.isArray(raw) ? raw : [raw];
  return points.filter((point): point is string => typeof point === 'string' && point.length > 0);
}

function flattenDevices(devices: BlockDevice[] = [], inheritedRemovable = false): Array<BlockDevice & { removable: boolean }> {
  const result: Array<BlockDevice & { removable: boolean }> = [];
  for (const device of devices) {
    const removable = inheritedRemovable || isRemovable(device.rm);
    result.push({ ...device, removable });
    result.push(...flattenDevices(device.children || [], removable));
  }
  return result;
}

async function blockDevices() {
  const output = await command('lsblk', ['-J', '-o', 'NAME,RM,TYPE,MOUNTPOINTS,LABEL,SIZE,MODEL,FSTYPE'], 5000);
  const parsed = JSON.parse(output) as { blockdevices?: BlockDevice[] };
  return flattenDevices(parsed.blockdevices || []);
}

function safeMountName(name: string) {
  return name.replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 64);
}

async function ensureMounted(device: BlockDevice & { removable: boolean }, shouldMount: boolean): Promise<UsbMount[]> {
  const name = device.name || '';
  if (!name || !device.removable || !['part', 'disk'].includes(String(device.type))) return [];
  const existingMounts = deviceMountpoints(device);
  if (existingMounts.length > 0) {
    return existingMounts.map((mountPoint) => ({
      name,
      device: `/dev/${name}`,
      mountPoint,
      label: device.label || null,
      size: device.size || null,
      model: device.model || null,
      mountedByAgent: false,
    }));
  }
  if (!shouldMount || process.platform !== 'linux') return [];
  const mountPoint = path.join(usbMountBase, safeMountName(name));
  fs.mkdirSync(mountPoint, { recursive: true });
  try {
    await command('mount', ['-o', 'ro,noexec,nodev,nosuid', `/dev/${name}`, mountPoint], 10000);
    return [{ name, device: `/dev/${name}`, mountPoint, label: device.label || null, size: device.size || null, model: device.model || null, mountedByAgent: true }];
  } catch (error) {
    log('usb mount failed', { name, error: error instanceof Error ? error.message : String(error) });
    return [];
  }
}

async function usbMounts(shouldMount: boolean) {
  if (process.platform !== 'linux') return [];
  const devices = await blockDevices();
  const mounts: UsbMount[] = [];
  for (const device of devices) mounts.push(...await ensureMounted(device, shouldMount));
  return mounts;
}

function extensionFor(filePath: string) {
  return path.extname(filePath).toLowerCase();
}

function mimeForExtension(ext: string) {
  const map: Record<string, string> = {
    '.pdf': 'application/pdf', '.ppt': 'application/vnd.ms-powerpoint', '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    '.doc': 'application/msword', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp',
    '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.mkv': 'video/x-matroska',
  };
  return map[ext] || 'application/octet-stream';
}

function isAllowedUsbFile(filePath: string) {
  const ext = extensionFor(filePath);
  return allowedUsbExtensions.has(ext) && !blockedUsbExtensions.has(ext);
}

function usbFileId(mountPoint: string, relativePath: string) {
  return crypto.createHash('sha256').update(`${mountPoint}\0${relativePath}`).digest('hex');
}

function safeRelativePath(base: string, absolutePath: string) {
  const resolvedBase = path.resolve(base);
  const resolved = path.resolve(absolutePath);
  if (resolved !== resolvedBase && !resolved.startsWith(`${resolvedBase}${path.sep}`)) return null;
  return path.relative(resolvedBase, resolved).replace(/\\/g, '/');
}

async function walkUsbFiles(mount: UsbMount, dir: string, depth: number, files: UsbFile[]) {
  if (depth > 5 || files.length >= 1000) return;
  let entries: fs.Dirent[];
  try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); }
  catch { return; }
  for (const entry of entries) {
    if (files.length >= 1000) return;
    if (entry.name.startsWith('.')) continue;
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await walkUsbFiles(mount, abs, depth + 1, files);
      continue;
    }
    if (!entry.isFile() || !isAllowedUsbFile(entry.name)) continue;
    const relativePath = safeRelativePath(mount.mountPoint, abs);
    if (!relativePath) continue;
    const stat = await fs.promises.stat(abs).catch(() => null);
    if (!stat || stat.size <= 0) continue;
    const ext = extensionFor(entry.name);
    files.push({
      id: usbFileId(mount.mountPoint, relativePath),
      device: mount.name,
      mountPoint: mount.mountPoint,
      relativePath,
      name: entry.name,
      size: stat.size,
      extension: ext,
      mime_type: mimeForExtension(ext),
      modified_at: stat.mtime ? stat.mtime.toISOString() : null,
    });
  }
}

async function usbFilesPayload() {
  scannedFiles.clear();
  const mounts = await usbMounts(true);
  const files: UsbFile[] = [];
  for (const mount of mounts) await walkUsbFiles(mount, mount.mountPoint, 0, files);
  for (const file of files) scannedFiles.set(file.id, file);
  return { detected: mounts.length > 0, mounts, files };
}

function safeStagingName(name: string) {
  return [...name]
    .map((char) => (char.charCodeAt(0) < 32 || '\\/:*?"<>|'.includes(char)) ? '_' : char)
    .join('')
    .slice(0, 180) || 'usb-import';
}

async function stageUsbFiles(req: http.IncomingMessage) {
  const body = await parseJsonBody(req);
  const ids = Array.isArray(body.file_ids) ? body.file_ids.map(String) : [];
  if (ids.length === 0) return { staged: [], error: 'No files selected' };
  if (ids.length > 25) return { staged: [], error: 'Select 25 files or fewer per import' };
  if (scannedFiles.size === 0) await usbFilesPayload();
  fs.mkdirSync(usbStagingBase, { recursive: true });
  const staged: StagedUsbFile[] = [];
  for (const id of ids) {
    const file = scannedFiles.get(id);
    if (!file) continue;
    const source = path.resolve(file.mountPoint, file.relativePath);
    const rel = safeRelativePath(file.mountPoint, source);
    if (!rel || rel !== file.relativePath) continue;
    const stagedId = crypto.randomUUID();
    const stagedPath = path.join(usbStagingBase, `${stagedId}-${safeStagingName(file.name)}`);
    await fs.promises.copyFile(source, stagedPath, fs.constants.COPYFILE_EXCL);
    const row = { ...file, stagedId, stagedPath, url: `http://127.0.0.1:${port}/usb/staged/${stagedId}` };
    stagedFiles.set(stagedId, row);
    staged.push(row);
    log('usb file staged', { name: file.name, relativePath: file.relativePath, size: file.size });
  }
  return { staged };
}

function serveStagedFile(req: http.IncomingMessage, res: http.ServerResponse, stagedId: string) {
  const staged = stagedFiles.get(stagedId);
  if (!staged || !fs.existsSync(staged.stagedPath)) return json(req, res, 404, { error: 'staged file not found' });
  writeCors(req, res);
  res.writeHead(200, {
    'Content-Type': staged.mime_type,
    'Content-Length': String(fs.statSync(staged.stagedPath).size),
    'Content-Disposition': `attachment; filename="${staged.name.replace(/"/g, '')}"`,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  fs.createReadStream(staged.stagedPath).pipe(res);
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
    if (req.method === 'OPTIONS') { writeCors(req, res); res.writeHead(204); return res.end(); }
    if (req.method === 'GET' && url.pathname === '/health') return json(req, res, 200, { ok: true, service: 'mbfd-podium-agent', room_id: roomId, device_id: deviceId });
    if (req.method === 'GET' && url.pathname === '/device') return json(req, res, 200, await devicePayload());
    if (req.method === 'GET' && url.pathname === '/network') return json(req, res, 200, await networkPayload());
    if (req.method === 'GET' && url.pathname === '/usb/status') return json(req, res, 200, await usbStatus());
    if (req.method === 'GET' && url.pathname === '/usb/files') return json(req, res, 200, await usbFilesPayload());
    if (req.method === 'POST' && url.pathname === '/usb/stage') return json(req, res, 200, await stageUsbFiles(req));
    if (req.method === 'GET' && url.pathname.startsWith('/usb/staged/')) return serveStagedFile(req, res, url.pathname.split('/').pop() || '');
    if (req.method === 'POST' && url.pathname === '/app/restart') return json(req, res, 200, await restartConsole());
    if (req.method === 'POST' && url.pathname === '/device/reboot') return json(req, res, 200, await rebootDevice());
    if (req.method === 'POST' && url.pathname === '/kiosk/disable') return json(req, res, 200, await disableKiosk());
    return json(req, res, 404, { error: 'not found' });
  } catch (error) {
    log('request failed', { error: error instanceof Error ? error.message : String(error) });
    return json(req, res, 500, { error: error instanceof Error ? error.message : 'request failed' });
  }
}

const server = http.createServer((req, res) => {
  const remote = req.socket.remoteAddress;
  if (remote && !['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(remote)) {
    log('non-local request rejected', { remote });
    return json(req, res, 403, { error: 'localhost only' });
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
