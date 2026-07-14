import { app, BrowserWindow, desktopCapturer, ipcMain, Menu, session } from 'electron';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

type ConsoleConfig = {
  consoleUrl: string;
  consoleUrls: string[];
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

type AdminAction = 'refresh-console' | 'restart-app' | 'reconnect' | 'exit-kiosk' | 'device-info' | 'reboot-device' | 'disable-kiosk';
type RendererEntry = { url: string } | { file: string; query: Record<string, string> };

let mainWindow: BrowserWindow | null = null;
let config: ConsoleConfig;
let retryTimer: NodeJS.Timeout | null = null;
let healthTimer: NodeJS.Timeout | null = null;
let unresponsiveTimer: NodeJS.Timeout | null = null;
let activeConsoleUrl: string | null = null;
let logWriteQueue = Promise.resolve();
let recoveryInProgress = false;
let lastRecoveryAt = 0;
let resourceBreachSamples = 0;
let healthPhase = 'starting';
let healthLastError: string | null = null;
const unlockedAdminWebContents = new Map<number, number>();

const HEALTH_SAMPLE_MS = 30000;
const UNRESPONSIVE_GRACE_MS = 15000;
const RECOVERY_COOLDOWN_MS = 60000;
const RENDERER_MEMORY_LIMIT_MB = 1200;
const TOTAL_RENDERER_MEMORY_LIMIT_MB = 3200;
const TOTAL_RENDERER_CPU_LIMIT = 240;
const MAX_LOG_BYTES = 5 * 1024 * 1024;

app.commandLine.appendSwitch('disable-pinch');
app.commandLine.appendSwitch('overscroll-history-navigation', '0');
app.commandLine.appendSwitch('ozone-platform-hint', 'auto');

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

function configuredConsoleUrls() {
  const configured = String(process.env.MBFD_CONSOLE_URLS || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  return configured.length > 0 ? configured : [
    process.env.MBFD_CONSOLE_LAN_URL || 'http://192.168.1.116:8096/console/classroom-1',
    process.env.MBFD_CONSOLE_TAILNET_URL || 'http://100.81.154.123:8096/console/classroom-1',
    process.env.MBFD_CONSOLE_URL || 'https://media-control.mbfdhub.com/console/classroom-1',
  ];
}

loadEnvFile('/etc/mbfd/media-control-console/config.env');
loadEnvFile(path.join(process.cwd(), 'config.env'));
const trustedInsecureOrigins = [...new Set(configuredConsoleUrls().flatMap((value) => {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' ? [parsed.origin] : [];
  } catch {
    return [];
  }
}))];
if (trustedInsecureOrigins.length > 0) {
  app.commandLine.appendSwitch('unsafely-treat-insecure-origin-as-secure', trustedInsecureOrigins.join(','));
}

function readConfig(): ConsoleConfig {
  loadEnvFile('/etc/mbfd/media-control-console/config.env');
  loadEnvFile(path.join(process.cwd(), 'config.env'));

  const consoleUrls = configuredConsoleUrls();
  const validConsoleUrls = [...new Set(consoleUrls)].filter((value) => {
    try { return ['http:', 'https:'].includes(new URL(value).protocol); } catch { return false; }
  });
  if (validConsoleUrls.length === 0) throw new Error('No valid Media Control console URL is configured');
  const consoleUrl = validConsoleUrls[0];
  const allowedHosts = new Set(
    (process.env.ALLOWED_HOSTS || 'media-control.mbfdhub.com,hub.mbfdhub.com,localhost,127.0.0.1')
      .split(',')
      .map((host) => host.trim().toLowerCase())
      .filter(Boolean),
  );
  for (const candidate of validConsoleUrls) allowedHosts.add(new URL(candidate).hostname.toLowerCase());

  return {
    consoleUrl,
    consoleUrls: validConsoleUrls,
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
  logWriteQueue = logWriteQueue.then(async () => {
    const logDir = path.join(app.getPath('userData'), 'logs');
    const logFile = path.join(logDir, 'console.log');
    await fs.promises.mkdir(logDir, { recursive: true });
    const stat = await fs.promises.stat(logFile).catch(() => null);
    if (stat && stat.size >= MAX_LOG_BYTES) {
      await fs.promises.rm(`${logFile}.1`, { force: true }).catch(() => undefined);
      await fs.promises.rename(logFile, `${logFile}.1`).catch(() => undefined);
    }
    await fs.promises.appendFile(logFile, `${line}\n`, 'utf8');
  }).catch((error) => console.error('failed to write console log', error));
}

function updateHealth(phase: string, error: string | null = null) {
  healthPhase = phase;
  healthLastError = error;
  void writeHealthSnapshot();
}

function processMetrics() {
  return app.getAppMetrics().map((metric) => ({
    pid: metric.pid,
    type: metric.type,
    cpu: Number(metric.cpu?.percentCPUUsage || 0),
    workingSetMb: Math.round(Number(metric.memory?.workingSetSize || 0) / 1024),
  }));
}

async function writeHealthSnapshot() {
  if (!app.isReady()) return;
  const metrics = processMetrics();
  const renderers = metrics.filter((metric) => metric.type !== 'Browser');
  const payload = {
    updatedAt: new Date().toISOString(),
    healthy: healthPhase === 'ready' && !healthLastError,
    phase: healthPhase,
    lastError: healthLastError,
    activeConsoleUrl,
    window: mainWindow && !mainWindow.isDestroyed() ? {
      responsive: !mainWindow.isDestroyed() && !mainWindow.webContents.isCrashed(),
      rendererPid: mainWindow.webContents.getOSProcessId(),
      url: mainWindow.webContents.getURL(),
    } : null,
    resources: {
      totalRendererCpu: Math.round(renderers.reduce((sum, metric) => sum + metric.cpu, 0) * 10) / 10,
      totalRendererMemoryMb: renderers.reduce((sum, metric) => sum + metric.workingSetMb, 0),
      processes: metrics,
    },
  };
  const healthPath = path.join(app.getPath('userData'), 'console-health.json');
  const tempPath = `${healthPath}.tmp`;
  try {
    await fs.promises.mkdir(path.dirname(healthPath), { recursive: true });
    await fs.promises.writeFile(tempPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    await fs.promises.rename(tempPath, healthPath);
  } catch (error) {
    log('health snapshot write failed', { error: error instanceof Error ? error.message : String(error) });
  }
}

function sampleRendererHealth() {
  const metrics = processMetrics().filter((metric) => metric.type !== 'Browser');
  const totalCpu = metrics.reduce((sum, metric) => sum + metric.cpu, 0);
  const totalMemoryMb = metrics.reduce((sum, metric) => sum + metric.workingSetMb, 0);
  const largestRendererMb = metrics.reduce((max, metric) => Math.max(max, metric.workingSetMb), 0);
  const overLimit = totalCpu > TOTAL_RENDERER_CPU_LIMIT
    || totalMemoryMb > TOTAL_RENDERER_MEMORY_LIMIT_MB
    || largestRendererMb > RENDERER_MEMORY_LIMIT_MB;
  resourceBreachSamples = overLimit ? resourceBreachSamples + 1 : 0;
  log('renderer health sample', { totalCpu, totalMemoryMb, largestRendererMb, resourceBreachSamples });
  if (resourceBreachSamples >= 3) {
    resourceBreachSamples = 0;
    void recoverConsoleWindow('sustained renderer resource limit');
  }
  void writeHealthSnapshot();
}

function startHealthMonitor() {
  if (healthTimer) clearInterval(healthTimer);
  healthTimer = setInterval(sampleRendererHealth, HEALTH_SAMPLE_MS);
  sampleRendererHealth();
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

  kioskSession.setPermissionRequestHandler((webContents, permission, callback) => {
    const allowed = permission === 'display-capture' && isAllowedUrl(webContents.getURL());
    callback(allowed);
  });
  kioskSession.setDisplayMediaRequestHandler(async (request, callback) => {
    if (!request.videoRequested || !request.userGesture || !isAllowedUrl(request.securityOrigin)) {
      log('display capture denied', {
        securityOrigin: request.securityOrigin,
        videoRequested: request.videoRequested,
        userGesture: request.userGesture,
      });
      callback({});
      return;
    }
    try {
      const sources = await desktopCapturer.getSources({
        types: ['screen'],
        thumbnailSize: { width: 1, height: 1 },
        fetchWindowIcons: false,
      });
      const source = sources[0];
      if (!source) {
        log('display capture unavailable', { securityOrigin: request.securityOrigin });
        callback({});
        return;
      }
      log('display capture granted', { securityOrigin: request.securityOrigin, source: source.name });
      if (request.audioRequested && request.frame) callback({ video: source, audio: request.frame });
      else callback({ video: source });
    } catch (error) {
      log('display capture failed', { error: error instanceof Error ? error.message : String(error) });
      callback({});
    }
  }, { useSystemPicker: false });
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
      backgroundThrottling: true,
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
    if (!isMainFrame || errorCode === -3 || isLocalRendererUrl(validatedUrl)) return;
    log('console load failed', { errorCode, errorDescription, validatedUrl });
    updateHealth('offline', errorDescription || `load failed (${errorCode})`);
    void showOfflineAndRetry();
  });

  mainWindow.webContents.on('did-finish-load', () => {
    const currentUrl = mainWindow?.webContents.getURL() || '';
    if (currentUrl && !isLocalRendererUrl(currentUrl)) updateHealth('ready');
  });

  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    log('renderer gone', details);
    updateHealth('crashed', details.reason);
    void recoverConsoleWindow(`renderer gone: ${details.reason}`);
  });

  mainWindow.on('unresponsive', () => {
    log('console window unresponsive');
    updateHealth('unresponsive', 'renderer unresponsive');
    if (unresponsiveTimer) clearTimeout(unresponsiveTimer);
    unresponsiveTimer = setTimeout(() => {
      unresponsiveTimer = null;
      void recoverConsoleWindow('renderer remained unresponsive');
    }, UNRESPONSIVE_GRACE_MS);
  });

  mainWindow.on('responsive', () => {
    if (unresponsiveTimer) clearTimeout(unresponsiveTimer);
    unresponsiveTimer = null;
    log('console window responsive');
    updateHealth('ready');
  });
}

async function recoverConsoleWindow(reason: string) {
  const now = Date.now();
  if (recoveryInProgress || now - lastRecoveryAt < RECOVERY_COOLDOWN_MS) {
    log('renderer recovery suppressed by cooldown', { reason });
    return;
  }
  recoveryInProgress = true;
  lastRecoveryAt = now;
  updateHealth('recovering', reason);
  log('recreating console window', { reason });
  try {
    if (retryTimer) clearTimeout(retryTimer);
    retryTimer = null;
    if (unresponsiveTimer) clearTimeout(unresponsiveTimer);
    unresponsiveTimer = null;
    const previous = mainWindow;
    mainWindow = null;
    if (previous && !previous.isDestroyed()) previous.destroy();
    createWindow();
    await loadLocalRenderer('splash');
    sendStatus('Recovering console');
    await connectToConsole();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log('console window recovery failed', { error: message });
    updateHealth('offline', message);
    await showOfflineAndRetry().catch(() => undefined);
  } finally {
    recoveryInProgress = false;
  }
}

async function probeConsoleUrl(consoleUrl: string) {
  const controller = new AbortController();
  const startedAt = Date.now();
  const timeout = setTimeout(() => controller.abort(), 2500);
  try {
    const response = await fetch(consoleUrl, {
      method: 'GET',
      redirect: 'manual',
      signal: controller.signal,
      headers: {
        'X-MBFD-Room-Id': config.roomId,
        'X-MBFD-Device-Id': config.deviceId,
        ...(config.deviceToken ? { 'X-MBFD-Device-Token': config.deviceToken } : {}),
      },
    });
    return { ok: response.status >= 200 && response.status < 400, status: response.status, latencyMs: Date.now() - startedAt };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error), latencyMs: Date.now() - startedAt };
  } finally {
    clearTimeout(timeout);
  }
}

async function selectReachableConsoleUrl() {
  for (const candidate of config.consoleUrls) {
    const result = await probeConsoleUrl(candidate);
    log('console route probe', { candidate, ...result });
    if (result.ok) return candidate;
  }
  return null;
}

async function connectToConsole() {
  if (!mainWindow) return;
  if (retryTimer) {
    clearTimeout(retryTimer);
    retryTimer = null;
  }
  sendStatus('Checking network');
  updateHealth('connecting');
  const selectedUrl = await selectReachableConsoleUrl();
  if (!selectedUrl) {
    updateHealth('offline', 'no configured console route is reachable');
    await showOfflineAndRetry();
    return;
  }
  activeConsoleUrl = selectedUrl;
  config.consoleUrl = selectedUrl;
  sendStatus('Connecting to MBFD Hub');
  log('loading console url', { consoleUrl: activeConsoleUrl, roomId: config.roomId, deviceId: config.deviceId });
  await mainWindow.loadURL(activeConsoleUrl);
}

async function refreshConsoleContent() {
  if (!mainWindow) return { ok: false, error: 'Console window is not ready' };
  if (retryTimer) {
    clearTimeout(retryTimer);
    retryTimer = null;
  }
  sendStatus('Refreshing console');
  let cacheCleared = false;
  let serviceWorkerUpdated = false;
  try {
    await session.defaultSession.clearCache();
    cacheCleared = true;
  } catch (error) {
    log('cache clear failed during refresh', { error: error instanceof Error ? error.message : String(error) });
  }

  const currentUrl = mainWindow.webContents.getURL();
  if (!currentUrl || currentUrl === 'about:blank' || isLocalRendererUrl(currentUrl) || !isAllowedUrl(currentUrl)) {
    await connectToConsole();
    return { ok: true, mode: 'connect', cacheCleared, serviceWorkerUpdated };
  }

  try {
    await mainWindow.webContents.executeJavaScript(`
      (async () => {
        if (!('serviceWorker' in navigator)) return false;
        const registrations = await navigator.serviceWorker.getRegistrations();
        await Promise.all(registrations.map((registration) => registration.update().catch(() => null)));
        return registrations.length > 0;
      })()
    `, true);
    serviceWorkerUpdated = true;
  } catch (error) {
    log('service worker update failed during refresh', { error: error instanceof Error ? error.message : String(error) });
  }

  mainWindow.webContents.reloadIgnoringCache();
  return { ok: true, mode: 'reloadIgnoringCache', cacheCleared, serviceWorkerUpdated };
}

async function showOfflineAndRetry() {
  if (!mainWindow) return;
  await loadLocalRenderer('offline');
  sendStatus('Offline / reconnecting');
  retryTimer = setTimeout(() => void connectToConsole(), 5000);
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
  if (action === 'refresh-console') return refreshConsoleContent();
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

ipcMain.handle('console:refresh-content', async () => {
  log('renderer requested console refresh');
  return refreshConsoleContent();
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
  configureSession();
  createWindow();
  startHealthMonitor();
  await loadLocalRenderer('splash');
  sendStatus('Booting');
  setTimeout(() => void connectToConsole(), 500);
});

app.on('child-process-gone', (_event, details) => {
  log('electron child process gone', details);
  if (details.type === 'GPU') updateHealth('degraded', `GPU process gone: ${details.reason}`);
});

app.on('before-quit', () => {
  if (retryTimer) clearTimeout(retryTimer);
  if (healthTimer) clearInterval(healthTimer);
  if (unresponsiveTimer) clearTimeout(unresponsiveTimer);
  retryTimer = null;
  healthTimer = null;
  unresponsiveTimer = null;
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

process.on('uncaughtException', (error) => {
  log('uncaught exception', { error: error.message, stack: error.stack });
  updateHealth('degraded', error.message);
  void recoverConsoleWindow('uncaught exception');
});

process.on('unhandledRejection', (reason) => {
  log('unhandled rejection', { reason: String(reason) });
});
