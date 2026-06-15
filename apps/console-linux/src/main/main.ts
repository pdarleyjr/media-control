import { app, BrowserWindow, dialog, ipcMain, Menu, session } from 'electron';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

type ConsoleConfig = {
  consoleUrl: string;
  apiUrl: string;
  wsUrl: string;
  roomId: string;
  deviceId: string;
  defaultProfile: string;
  deviceToken: string;
  allowedHosts: Set<string>;
  kioskMode: boolean;
  adminPin: string;
  enableDevTools: boolean;
};

type AdminAction = 'restart-app' | 'reconnect' | 'exit-kiosk' | 'device-info' | 'reboot-device' | 'disable-kiosk';
type RendererEntry = { url: string } | { file: string; query: Record<string, string> };

let mainWindow: BrowserWindow | null = null;
let config: ConsoleConfig;
let retryTimer: NodeJS.Timeout | null = null;
const unlockedAdminWebContents = new Map<number, number>();

function loadEnvFile(filePath: string) {
  if (!fs.existsSync(filePath)) return;
  const raw = fs.readFileSync(filePath, 'utf8');
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || !trimmed.includes('=')) continue;
    const [key, ...rest] = trimmed.split('=');
    if (!key || process.env[key] !== undefined) continue;
    process.env[key] = rest.join('=').replace(/^['"]|['"]$/g, '');
  }
}

function readConfig(): ConsoleConfig {
  loadEnvFile('/etc/mbfd/media-control-console/config.env');
  loadEnvFile(path.join(process.cwd(), 'config.env'));

  const consoleUrl = process.env.MBFD_CONSOLE_URL || 'https://media-control.mbfdhub.com/console/classroom-1';
  const parsedConsoleUrl = new URL(consoleUrl);
  const allowedHosts = new Set(
    (process.env.ALLOWED_HOSTS || 'media-control.mbfdhub.com,hub.mbfdhub.com,localhost,127.0.0.1')
      .split(',')
      .map((host) => host.trim().toLowerCase())
      .filter(Boolean),
  );
  allowedHosts.add(parsedConsoleUrl.hostname.toLowerCase());

  return {
    consoleUrl,
    apiUrl: process.env.MBFD_HUB_API_URL || 'https://hub.mbfdhub.com/api',
    wsUrl: process.env.MBFD_HUB_WS_URL || 'wss://hub.mbfdhub.com/reverb',
    roomId: process.env.ROOM_ID || 'classroom-1',
    deviceId: process.env.DEVICE_ID || 'classroom-1-podium-console',
    defaultProfile: process.env.DEFAULT_PROFILE || 'guest',
    deviceToken: process.env.DEVICE_TOKEN || '',
    allowedHosts,
    kioskMode: String(process.env.KIOSK_MODE || 'true').toLowerCase() !== 'false',
    adminPin: process.env.ADMIN_PIN || 'change-me',
    enableDevTools: String(process.env.ENABLE_DEVTOOLS || 'false').toLowerCase() === 'true',
  };
}

function log(message: string, details?: unknown) {
  const line = JSON.stringify({ timestamp: new Date().toISOString(), message, details: details ?? null });
  console.log(line);
  try {
    const logDir = path.join(app.getPath('userData'), 'logs');
    fs.mkdirSync(logDir, { recursive: true });
    fs.appendFileSync(path.join(logDir, 'console.log'), `${line}\n`);
  } catch (error) {
    console.error('failed to write console log', error);
  }
}

function rendererEntry(mode: 'splash' | 'offline'): RendererEntry {
  const devServer = process.env.VITE_DEV_SERVER_URL;
  if (devServer) return { url: `${devServer}?mode=${mode}` };
  return {
    file: path.join(__dirname, '..', 'renderer', 'index.html'),
    query: { mode },
  };
}

async function loadLocalRenderer(mode: 'splash' | 'offline') {
  if (!mainWindow) return;
  const entry = rendererEntry(mode);
  if ('url' in entry && entry.url) await mainWindow.loadURL(entry.url);
  else if ('file' in entry) await mainWindow.loadFile(entry.file, { query: entry.query });
}

function sendStatus(status: string) {
  mainWindow?.webContents.send('console:status', status);
  log('status', { status });
}

function isLocalRendererUrl(rawUrl: string) {
  if (rawUrl.startsWith('file://')) return true;
  const devServer = process.env.VITE_DEV_SERVER_URL;
  return !!devServer && rawUrl.startsWith(devServer);
}

function isAllowedUrl(rawUrl: string) {
  if (!rawUrl || rawUrl === 'about:blank') return true;
  if (isLocalRendererUrl(rawUrl)) return true;
  let parsed: URL;
  try { parsed = new URL(rawUrl); } catch { return false; }
  if (parsed.protocol === 'file:') return true;
  if (!['https:', 'http:', 'wss:', 'ws:'].includes(parsed.protocol)) return false;
  const host = parsed.hostname.toLowerCase();
  return config.allowedHosts.has(host) || [...config.allowedHosts].some((allowedHost) => host.endsWith(`.${allowedHost}`));
}

function configureSession() {
  const kioskSession = session.defaultSession;

  kioskSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  kioskSession.webRequest.onBeforeSendHeaders({ urls: ['<all_urls>'] }, (details, callback) => {
    const requestHeaders = details.requestHeaders || {};
    if (isAllowedUrl(details.url)) {
      requestHeaders['X-MBFD-Room-Id'] = config.roomId;
      requestHeaders['X-MBFD-Device-Id'] = config.deviceId;
      if (config.deviceToken) requestHeaders['X-MBFD-Device-Token'] = config.deviceToken;
    }
    callback({ requestHeaders });
  });

  kioskSession.on('will-download', (event) => {
    event.preventDefault();
    log('download blocked');
  });
}

function createWindow() {
  Menu.setApplicationMenu(null);
  mainWindow = new BrowserWindow({
    width: 1920,
    height: 1080,
    kiosk: config.kioskMode,
    fullscreen: config.kioskMode,
    frame: false,
    autoHideMenuBar: true,
    resizable: !config.kioskMode,
    backgroundColor: '#07111f',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
      devTools: config.enableDevTools,
    },
  });

  mainWindow.once('ready-to-show', () => mainWindow?.show());

  mainWindow.webContents.on('will-navigate', (event, targetUrl) => {
    if (!isAllowedUrl(targetUrl)) {
      event.preventDefault();
      log('navigation blocked', { targetUrl });
    }
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    log('window open blocked', { url });
    return { action: 'deny' };
  });

  mainWindow.webContents.on('before-input-event', (event, input) => {
    const key = input.key.toLowerCase();
    const blocked = [
      input.alt,
      input.meta,
      input.control && ['r', 'w', 'n', 'o', 'p', 'f', 'g', 'j', 'i'].includes(key),
      !config.enableDevTools && input.key === 'F12',
      !config.enableDevTools && input.control && input.shift && ['i', 'j', 'c'].includes(key),
      config.kioskMode && ['F11', 'Escape'].includes(input.key),
    ].some(Boolean);
    if (blocked) event.preventDefault();
  });

  mainWindow.webContents.on('context-menu', (event) => {
    if (!config.enableDevTools) event.preventDefault();
  });

  mainWindow.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedUrl, isMainFrame) => {
    if (!isMainFrame || isLocalRendererUrl(validatedUrl)) return;
    log('console load failed', { errorCode, errorDescription, validatedUrl });
    void showOfflineAndRetry();
  });

  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    log('renderer gone', details);
    void showOfflineAndRetry();
  });
}

async function probeConsoleUrl() {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  try {
    const response = await fetch(config.consoleUrl, {
      method: 'GET',
      redirect: 'manual',
      signal: controller.signal,
      headers: {
        'X-MBFD-Room-Id': config.roomId,
        'X-MBFD-Device-Id': config.deviceId,
        ...(config.deviceToken ? { 'X-MBFD-Device-Token': config.deviceToken } : {}),
      },
    });
    return response.status >= 200 && response.status < 400;
  } catch (error) {
    log('console probe failed', { error: error instanceof Error ? error.message : String(error) });
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

async function connectToConsole() {
  if (!mainWindow) return;
  if (retryTimer) {
    clearTimeout(retryTimer);
    retryTimer = null;
  }
  sendStatus('Checking network');
  const reachable = await probeConsoleUrl();
  if (!reachable) {
    await showOfflineAndRetry();
    return;
  }
  sendStatus('Connecting to MBFD Hub');
  log('loading console url', { consoleUrl: config.consoleUrl, roomId: config.roomId, deviceId: config.deviceId });
  await mainWindow.loadURL(config.consoleUrl);
}

async function showOfflineAndRetry() {
  if (!mainWindow) return;
  await loadLocalRenderer('offline');
  sendStatus('Offline / reconnecting');
  retryTimer = setTimeout(() => void connectToConsole(), 10000);
}

function callAgent(pathname: string, method: 'GET' | 'POST' = 'GET') {
  return new Promise<unknown>((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port: 8755, path: pathname, method, timeout: 5000 }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        try { resolve(body ? JSON.parse(body) : { ok: true }); }
        catch { resolve({ ok: res.statusCode && res.statusCode < 400, body }); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('podium agent timeout')));
    req.on('error', reject);
    req.end();
  });
}

function isAdminUnlocked(webContentsId: number) {
  const until = unlockedAdminWebContents.get(webContentsId) || 0;
  if (until > Date.now()) return true;
  unlockedAdminWebContents.delete(webContentsId);
  return false;
}

ipcMain.handle('admin:unlock', (event, pin: string) => {
  const ok = pin === config.adminPin;
  if (ok) unlockedAdminWebContents.set(event.sender.id, Date.now() + 5 * 60 * 1000);
  log('admin unlock attempted', { ok });
  return { ok };
});

ipcMain.handle('admin:action', async (event, action: AdminAction) => {
  if (!isAdminUnlocked(event.sender.id)) return { ok: false, error: 'Admin PIN required' };
  log('admin action', { action });
  if (action === 'restart-app') {
    app.relaunch();
    app.exit(0);
    return { ok: true };
  }
  if (action === 'reconnect') {
    void connectToConsole();
    return { ok: true };
  }
  if (action === 'exit-kiosk') {
    mainWindow?.setKiosk(false);
    mainWindow?.setFullScreen(false);
    return { ok: true };
  }
  if (action === 'device-info') {
    try { return { ok: true, data: await callAgent('/device') }; }
    catch (error) {
      return {
        ok: true,
        data: {
          hostname: os.hostname(),
          platform: os.platform(),
          arch: os.arch(),
          room_id: config.roomId,
          device_id: config.deviceId,
          agent_error: error instanceof Error ? error.message : String(error),
        },
      };
    }
  }
  if (action === 'reboot-device') return callAgent('/device/reboot', 'POST');
  if (action === 'disable-kiosk') return callAgent('/kiosk/disable', 'POST');
  return { ok: false, error: 'Unknown action' };
});

app.on('web-contents-created', (_event, contents) => {
  contents.setWindowOpenHandler(({ url }) => {
    if (isAllowedUrl(url)) return { action: 'deny' };
    return { action: 'deny' };
  });
  contents.on('will-navigate', (event, url) => {
    if (!isAllowedUrl(url)) event.preventDefault();
  });
});

app.whenReady().then(async () => {
  config = readConfig();
  app.commandLine.appendSwitch('disable-pinch');
  app.commandLine.appendSwitch('overscroll-history-navigation', '0');
  app.commandLine.appendSwitch('ozone-platform-hint', 'auto');
  configureSession();
  createWindow();
  await loadLocalRenderer('splash');
  sendStatus('Booting');
  setTimeout(() => void connectToConsole(), 500);
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

process.on('uncaughtException', (error) => {
  log('uncaught exception', { error: error.message, stack: error.stack });
  dialog.showErrorBox('MBFD Console Error', error.message);
});

process.on('unhandledRejection', (reason) => {
  log('unhandled rejection', { reason: String(reason) });
});
