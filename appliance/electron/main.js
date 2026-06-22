// ============================================================
// MBFD Kamrui Electron kiosk shell (thin).
// Boots the redesigned Command Center (`MC_COMMAND_CENTER_URL` or, with
// `--offline-bundle=<dir>`, a baked local fallback), registers the privileged
// `mcmedia://` scheme, resolves `mcmedia://asset/<sha256>` to the Kamrui
// room-agent cache at /opt/mbfd/room-agent/cache/assets/<sha256> (verifies the
// SHA on demand + matches the filename; refuses to serve on mismatch), and
// blocks navigation away from the allowlisted GMKtec origin.
//
// Hardened: no DevTools, no nodeIntegration, contextIsolation true, fullscreen
// kiosk, auto-hidden menu bar. The renderer sees only the tiny `window.mcBridge`
// surface exposed by preload.js. Only the `electron` runtime is required.
// ============================================================
'use strict';

const { app, BrowserWindow, protocol, session, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { Readable } = require('stream');

const COMMAND_CENTER_URL =
  process.env.MC_COMMAND_CENTER_URL || 'https://media-control.mbfdhub.com/app';
const CACHE_ASSETS_DIR =
  process.env.MC_ROOM_AGENT_ASSETS_DIR || '/opt/mbfd/room-agent/cache/assets';
const PROBE_PORT = parseInt(process.env.MC_AGENT_PORT, 10) || 8097;
const OFFLINE_FALLBACK = path.join(__dirname, 'offline-fallback', 'index.html');

const HEX64 = /^[0-9a-f]{64}$/i;

// Parse --offline-bundle=<dir> (served when the remote CC is unreachable).
function offlineBundleArg() {
  for (const a of process.argv.slice(1)) {
    const m = a.match(/^--offline-bundle=(.+)$/);
    if (m) return m[1];
  }
  return process.env.MC_OFFLINE_BUNDLE || '';
}

// Allowlisted origins the kiosk may navigate to. Configured CC host + the
// GMKtec Tailnet origin + loopback (for the agent probe / local fallback).
function allowHosts() {
  const hosts = new Set();
  try { hosts.add(new URL(COMMAND_CENTER_URL).host); } catch { /* ignore */ }
  hosts.add('media-control.mbfdhub.com');
  hosts.add('127.0.0.1');
  hosts.add('localhost');
  hosts.add('100.81.154.123'); // documented GMKtec Tailnet default
  return hosts;
}

// Register `mcmedia://` BEFORE app ready so it's treated as a privileged,
// standard-scheme-like protocol (secure, supports fetch/streams, CORS-safe).
protocol.registerSchemesAsPrivileged([
  { scheme: 'mcmedia', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, bypassCSP: false } },
]);

// Verify a cached asset's filename is a 64-hex sha AND the file's actual SHA256
// matches it. Refuses (returns null) on any mismatch — never serves unchecked
// bytes. Reads on demand (full-file hash) so a replaced/renamed file is caught.
function verifyCachedAsset(sha) {
  const n = String(sha || '').toLowerCase();
  if (!HEX64.test(n)) return null;
  const file = path.join(CACHE_ASSETS_DIR, n);
  try {
    if (!fs.existsSync(file)) return null;
    if (path.basename(file).toLowerCase() !== n) return null;
  } catch { return null; }
  return new Promise((resolve) => {
    const h = crypto.createHash('sha256');
    const rs = fs.createReadStream(file);
    rs.on('data', (c) => h.update(c));
    rs.on('end', () => resolve(h.digest('hex') === n ? file : null));
    rs.on('error', () => resolve(null));
  });
}

function guessMime(file) {
  const ext = path.extname(file).toLowerCase();
  return ({
    '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime',
    '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp',
    '.gif': 'image/gif', '.pdf': 'application/pdf',
  })[ext] || 'application/octet-stream';
}

async function registerMcMedia() {
  try {
    // Electron 25+ protocol.handle returns a fetch Response.
    protocol.handle('mcmedia', async (request) => {
      try {
        const u = new URL(request.url);
        // mcmedia://asset/<sha256>: host is 'asset', sha is first path segment.
        const sha = decodeURIComponent((u.pathname || '').replace(/^\/+/, '')).split('/')[0];
        if (u.host !== 'asset' || !sha) return new Response('bad request', { status: 400 });
        const file = await verifyCachedAsset(sha);
        if (!file) return new Response('not available / sha mismatch', { status: 404 });
        const stat = fs.statSync(file);
        const stream = fs.createReadStream(file);
        const web = Readable.toWeb(stream);
        return new Response(web, {
          status: 200,
          headers: {
            'Content-Type': guessMime(file),
            'Content-Length': String(stat.size),
            'Cache-Control': 'public, immutable',
          },
        });
      } catch (e) {
        return new Response('mcmedia error', { status: 500 });
      }
    });
  } catch (e) {
    // Older Electron: fall back to registerFileProtocol with the same verify.
    try {
      protocol.registerFileProtocol('mcmedia', async (request, callback) => {
        const u = new URL(request.url);
        const sha = decodeURIComponent((u.pathname || '').replace(/^\/+/, '')).split('/')[0];
        const file = await verifyCachedAsset(sha);
        callback(file ? { path: file } : { statusCode: 404 });
      });
    } catch (e2) { console.error('[electron] mcmedia protocol registration failed:', e2 && e2.message); }
  }
}

async function isAssetAvailable(sha) {
  // Ask the podium room-agent loopback probe first; fall back to a direct
  // filesystem check. Used by preload via IPC.
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 1500);
    const r = await fetch(`http://127.0.0.1:${PROBE_PORT}/asset-available?sha256=${encodeURIComponent(sha)}`);
    clearTimeout(t);
    if (r.ok) { const j = await r.json(); return !!j.present; }
  } catch { /* fall through */ }
  return !!(await verifyCachedAsset(sha));
}

function loadTarget(win) {
  const bundle = offlineBundleArg();
  return bundle && fs.existsSync(path.join(bundle, 'index.html'))
    ? `file://${path.join(bundle, 'index.html').replace(/\\/g, '/')}`
    : COMMAND_CENTER_URL;
}

let mainWindow = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    fullscreen: true,
    autoHideMenuBar: true,
    kiosk: true,
    webPreferences: {
      devtools: false,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  const target = loadTarget(mainWindow);
  mainWindow.loadURL(target);

  const allowed = allowHosts();
  mainWindow.webContents.on('will-navigate', (e, url) => {
    try {
      const h = new URL(url).host;
      if (!allowed.has(h)) e.preventDefault();
    } catch { e.preventDefault(); }
  });
  // New windows/tabs only allowed to the same allowlisted hosts.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    try {
      const h = new URL(url).host;
      if (allowed.has(h)) return { action: 'allow' };
    } catch { /* ignore */ }
    return { action: 'deny' };
  });

  // External (non-http mcmedia) links → hand to the OS browser? No — kiosk: deny.
  mainWindow.webContents.on('will-attach-webview', (e, wcProps) => {
    delete wcProps.preloadURL;
  });

  // If the remote CC fails to load, fall back to the offline reconnect screen.
  mainWindow.webContents.on('did-fail-load', (_e, errorCode, errorDesc, validatedURL) => {
    if (String(validatedURL).startsWith('file://')) return; // already the fallback
    console.warn('[electron] did-fail-load', errorCode, errorDesc, '-> offline fallback');
    mainWindow.loadURL(`file://${OFFLINE_FALLBACK.replace(/\\/g, '/')}`);
  });
}

// ----------------------------------------------------------------------------
// IPC surface used by preload.js (contextBridge-safe): the renderer's mcBridge
// only sees these names; no Node surface.
// ----------------------------------------------------------------------------
const { ipcMain } = require('electron');
ipcMain.handle('mc:reconnect-state', async () => {
  try {
    const r = await fetch(COMMAND_CENTER_URL, { method: 'HEAD', signal: AbortSignal.timeout(2000) });
    return { online: r.ok, target: COMMAND_CENTER_URL };
  } catch {
    return { online: false, target: COMMAND_CENTER_URL };
  }
});
ipcMain.handle('mc:asset-available', async (_e, sha) => ({ present: await isAssetAvailable(String(sha || '')) }));
ipcMain.handle('mc:launch-whiteboard', async () => {
  // Whiteboard is a route inside the CC route; in kiosk mode just route there.
  try { mainWindow && mainWindow.loadURL(`${COMMAND_CENTER_URL.split('#')[0]}#/control/whiteboard`); return { ok: true }; }
  catch (e) { return { ok: false, error: String(e && e.message) }; }
});

app.whenReady().then(async () => {
  await registerMcMedia();
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });