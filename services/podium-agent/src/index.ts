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
const cameraDevice = process.env.PODIUM_CAMERA_DEVICE || '/dev/video2';
const consoleHealthPaths = [
  '/home/mbfdkiosk/.config/@mbfd/console-linux/console-health.json',
  '/home/mbfdkiosk/.config/mbfd-media-control-console/console-health.json',
  '/home/mbfdkiosk/.config/MBFD Media Control Console/console-health.json',
];
const maxLogBytes = 5 * 1024 * 1024;
let logWriteQueue = Promise.resolve();

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
  logWriteQueue = logWriteQueue.then(async () => {
    const primary = '/var/log/mbfd-podium-agent.log';
    const fallbackDir = path.join(os.homedir(), '.local', 'state', 'mbfd-podium-agent');
    const candidates = [primary, path.join(fallbackDir, 'agent.log')];
    for (const logFile of candidates) {
      try {
        await fs.promises.mkdir(path.dirname(logFile), { recursive: true });
        const stat = await fs.promises.stat(logFile).catch(() => null);
        if (stat && stat.size >= maxLogBytes) {
          await fs.promises.rm(`${logFile}.1`, { force: true }).catch(() => undefined);
          await fs.promises.rename(logFile, `${logFile}.1`).catch(() => undefined);
        }
        await fs.promises.appendFile(logFile, `${line}\n`, 'utf8');
        return;
      } catch { /* try the fallback; journald stdout always remains available */ }
    }
  });
}

function writeCors(req: http.IncomingMessage, res: http.ServerResponse) {
  const origin = String(req.headers.origin || '');
  const allowedOrigins = new Set([
    'https://media-control.mbfdhub.com',
    'http://192.168.1.116:8096',
    'http://100.81.154.123:8096',
    ...String(process.env.PODIUM_AGENT_ALLOWED_ORIGINS || '').split(',').map((value) => value.trim()).filter(Boolean),
  ]);
  const allowed = origin === 'null'
    || origin.startsWith('http://localhost')
    || origin.startsWith('http://127.0.0.1')
    || allowedOrigins.has(origin);
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
  const output = await command('lsblk', ['-J', '-e', '7', '-o', 'NAME,RM,TYPE,MOUNTPOINTS,LABEL,SIZE,MODEL,FSTYPE'], 5000);
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

async function captureCameraSnapshot() {
  if (process.platform !== 'linux') throw new Error('camera capture is Linux-only');
  if (!fs.existsSync(cameraDevice)) throw new Error(`camera device not found: ${cameraDevice}`);

  const snapshotPath = path.join('/tmp', `mbfd-podium-camera-${crypto.randomUUID()}.jpg`);
  try {
    await command('gst-launch-1.0', [
      '-q',
      'v4l2src',
      `device=${cameraDevice}`,
      'num-buffers=1',
      '!',
      'image/jpeg,width=1920,height=1080,framerate=30/1',
      '!',
      'filesink',
      `location=${snapshotPath}`,
    ], 15000);
    const image = await fs.promises.readFile(snapshotPath);
    if (image.length < 1024) throw new Error('camera returned an empty frame');
    return image;
  } finally {
    await fs.promises.rm(snapshotPath, { force: true }).catch(() => undefined);
  }
}

async function serveCameraSnapshot(req: http.IncomingMessage, res: http.ServerResponse) {
  const image = await captureCameraSnapshot();
  writeCors(req, res);
  res.writeHead(200, {
    'Content-Type': 'image/jpeg',
    'Content-Length': String(image.length),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(image);
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

function readTextFile(filePath: string, maxLength = 256 * 1024) {
  try { return fs.readFileSync(filePath, 'utf8').slice(0, maxLength).trim(); }
  catch { return null; }
}

function readJsonFile(filePath: string) {
  const raw = readTextFile(filePath, 2 * 1024 * 1024);
  if (!raw) return null;
  try { return JSON.parse(raw) as JsonValue; } catch { return null; }
}

function filesystemDiagnostics() {
  return ['/', '/mnt/data'].filter((mountPoint) => fs.existsSync(mountPoint)).map((mountPoint) => {
    const stat = fs.statfsSync(mountPoint);
    const blockSize = Number(stat.bsize || 0);
    const totalBytes = Number(stat.blocks || 0) * blockSize;
    const availableBytes = Number(stat.bavail || 0) * blockSize;
    return {
      mountPoint,
      totalBytes,
      availableBytes,
      usedPercent: totalBytes > 0 ? Math.round((1 - availableBytes / totalBytes) * 1000) / 10 : null,
    };
  });
}

function pressureDiagnostics() {
  return {
    cpu: readTextFile('/proc/pressure/cpu'),
    memory: readTextFile('/proc/pressure/memory'),
    io: readTextFile('/proc/pressure/io'),
  };
}

function thermalDiagnostics() {
  if (!fs.existsSync('/sys/class/thermal')) return [];
  return fs.readdirSync('/sys/class/thermal')
    .filter((name) => name.startsWith('thermal_zone'))
    .map((name) => {
      const root = path.join('/sys/class/thermal', name);
      const rawTemp = Number(readTextFile(path.join(root, 'temp')) || NaN);
      return {
        zone: name,
        type: readTextFile(path.join(root, 'type')),
        celsius: Number.isFinite(rawTemp) ? rawTemp / 1000 : null,
      };
    });
}

function networkLinkDiagnostics() {
  if (!fs.existsSync('/sys/class/net')) return [];
  return fs.readdirSync('/sys/class/net').map((name) => ({
    name,
    operstate: readTextFile(path.join('/sys/class/net', name, 'operstate')),
    carrier: readTextFile(path.join('/sys/class/net', name, 'carrier')),
    speedMbps: readTextFile(path.join('/sys/class/net', name, 'speed')),
  }));
}

async function diskInventoryDiagnostics() {
  try {
    const output = await command('lsblk', ['-J', '-e', '7', '-o', 'NAME,PATH,TYPE,SIZE,MODEL,SERIAL,ROTA,TRAN,FSTYPE,MOUNTPOINTS'], 5000);
    return JSON.parse(output) as JsonValue;
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

async function smartDiagnostics() {
  try { await command('smartctl', ['--version'], 3000); }
  catch {
    return { available: false, reason: 'smartctl is not installed; no SMART pass/fail result is claimed', devices: [] };
  }
  const devices: Array<Record<string, unknown>> = [];
  let scan: { devices?: Array<{ name?: string }> } = {};
  try { scan = JSON.parse(await command('smartctl', ['--scan-open', '--json'], 10000)) as typeof scan; }
  catch (error) { return { available: true, error: error instanceof Error ? error.message : String(error), devices }; }
  for (const device of scan.devices || []) {
    if (!device.name) continue;
    try {
      const raw = await command('smartctl', ['--json', '-H', '-A', device.name], 15000);
      devices.push({ path: device.name, report: JSON.parse(raw) });
    } catch (error) {
      devices.push({ path: device.name, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return { available: true, devices };
}

async function journalDiagnostics() {
  const current = await command('journalctl', ['--no-pager', '-b', '-p', 'warning..alert', '-n', '200', '-o', 'short-iso'], 10000)
    .catch((error) => `unavailable: ${error instanceof Error ? error.message : String(error)}`);
  const previous = await command('journalctl', ['--no-pager', '-b', '-1', '-p', 'warning..alert', '-n', '200', '-o', 'short-iso'], 10000)
    .catch((error) => `unavailable: ${error instanceof Error ? error.message : String(error)}`);
  return { currentBoot: current, previousBoot: previous };
}

function consoleHealthDiagnostics() {
  for (const healthPath of consoleHealthPaths) {
    const value = readJsonFile(healthPath);
    if (value) return { path: healthPath, value };
  }
  return { path: null, value: null };
}

function coreDumpDiagnostics() {
  const corePath = '/opt/mbfd/media-control-console/core';
  try {
    const stat = fs.statSync(corePath);
    return { path: corePath, exists: true, size: stat.size, modifiedAt: stat.mtime.toISOString() };
  } catch { return { path: corePath, exists: false }; }
}

async function systemDiagnosticsPayload() {
  const [disks, smart, journals, processes] = await Promise.all([
    diskInventoryDiagnostics(),
    smartDiagnostics(),
    journalDiagnostics(),
    command('ps', ['-eo', 'pid,ppid,comm,%cpu,%mem,rss,etime,args', '--sort=-%cpu'], 5000)
      .then((output) => output.split('\n').slice(0, 31).join('\n'))
      .catch((error) => `unavailable: ${error instanceof Error ? error.message : String(error)}`),
  ]);
  return {
    capturedAt: new Date().toISOString(),
    hostname: os.hostname(),
    uptimeSeconds: Math.round(os.uptime()),
    loadAverage: os.loadavg(),
    memory: { totalBytes: os.totalmem(), freeBytes: os.freemem() },
    filesystems: filesystemDiagnostics(),
    pressure: pressureDiagnostics(),
    thermal: thermalDiagnostics(),
    networkLinks: networkLinkDiagnostics(),
    disks,
    smart,
    journals,
    consoleHealth: consoleHealthDiagnostics(),
    coreDump: coreDumpDiagnostics(),
    processes,
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
    if (req.method === 'GET' && url.pathname === '/diagnostics/system') return json(req, res, 200, await systemDiagnosticsPayload());
    if (req.method === 'GET' && url.pathname === '/camera/status') {
      return json(req, res, 200, {
        available: process.platform === 'linux' && fs.existsSync(cameraDevice),
        device: cameraDevice,
      });
    }
    if (req.method === 'GET' && url.pathname === '/camera/snapshot') return serveCameraSnapshot(req, res);
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
