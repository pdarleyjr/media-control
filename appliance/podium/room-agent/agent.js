// ============================================================
// MBFD Kamrui podium room-agent (Linux).
// Same shape as the P3 agent minus audio enforcement. Connects to the Media
// Control server over Socket.IO `/device` namespace using a per-node token
// (MC_NODE_TOKEN — gitignored), joins room `node:<id>`, sends a node heartbeat
// every 15s, applies server-pushed sync manifests, and best-effort handles
// snapshot requests. No secrets hard-coded — all creds/URLs come from env.
//
// ALSO runs a tiny localhost-only HTTP probe (default :8097) that the Electron
// preload bridge (`appliance/electron/preload.js`) calls to ask whether a
// content-addressed asset is present in the local cache (`mcmedia://`). Bound to
// 127.0.0.1 only; never exposed. This module exports `localAssetResolver(sha)`
// so an in-process caller can resolve a cached path directly too.
//
// Only Node built-ins + `socket.io-client`. Sync state in the local SQLite
// manifest managed by sync-worker.js (`better-sqlite3` shipped here).
// ============================================================
'use strict';

const os = require('os');
const path = require('path');
const fs = require('fs');
const http = require('http');
const { URL } = require('url');

const syncWorker = require('./sync-worker');

const DEFAULT_SERVER_URL = 'http://100.81.154.123:8096'; // GMKtec Tailnet (documented default)
const HEARTBEAT_INTERVAL_MS = 15 * 1000;
const BACKOFF_MIN_MS = 2 * 1000;
const BACKOFF_MAX_MS = 5 * 60 * 1000;

// ── Config (env only) ───────────────────────────────────────
const MC_SERVER_URL = process.env.MC_SERVER_URL || DEFAULT_SERVER_URL;
const MC_NODE_TOKEN = process.env.MC_NODE_TOKEN || '';
const MC_NODE_ID = process.env.MC_NODE_ID || '';
const NODE_TYPE = process.env.MC_NODE_TYPE || 'podium';
const SOFTWARE_VERSION = process.env.MC_SOFTWARE_VERSION || 'podium-agent-1.0.0';
const ACTIVE_DISPLAYS = (process.env.MC_ACTIVE_DISPLAYS || '').split(',').map(s => s.trim()).filter(Boolean);
const ROOM_HEARTBEAT_EVENT = 'node:heartbeat';
const AGENT_PORT = parseInt(process.env.MC_AGENT_PORT, 10) || 8097;

if (!MC_NODE_TOKEN || !MC_NODE_ID) {
  console.error('[room-agent] Missing MC_NODE_TOKEN or MC_NODE_ID env vars. Set them in config.env (gitignored) on-box.');
  process.exit(2);
}

let io = null;
let heartbeatTimer = null;
let httpServer = null;
let backoffMs = BACKOFF_MIN_MS;
let shuttingDown = false;

function ts() { return Math.floor(Date.now() / 1000); }

// Exported so Electron/in-process callers can resolve a sha to the cached path
// without going over the loopback HTTP probe.
function localAssetResolver(sha256) {
  return syncWorker.localAssetResolver(sha256);
}

function freeDiskBytes() {
  try {
    const dir = syncWorker.getStatus().assets_dir;
    if (!dir || typeof fs.statfs !== 'function') return -1;
    const st = fs.statfsSync(dir);
    return (st.bavail || 0) * (st.bsize || 0);
  } catch { return -1; }
}

// Podium heartbeats omit `audio_endpoint` (no audio path on the podium).
function buildHeartbeat() {
  const status = syncWorker.getStatus();
  return {
    node_id: MC_NODE_ID,
    node_type: NODE_TYPE,
    ts: ts(),
    software_version: SOFTWARE_VERSION,
    free_disk: freeDiskBytes(),
    cache_size: status.cache_size,
    sync_status: status.sync_status,
    active_displays: ACTIVE_DISPLAYS,
  };
}

function sendHeartbeat() {
  try {
    if (!io || !io.connected) return;
    io.emit(ROOM_HEARTBEAT_EVENT, buildHeartbeat());
  } catch (e) {
    console.warn('[room-agent] heartbeat send failed (non-fatal):', e && e.message);
  }
}

function startHeartbeat() {
  stopHeartbeat();
  sendHeartbeat();
  heartbeatTimer = setInterval(sendHeartbeat, HEARTBEAT_INTERVAL_MS);
  if (typeof heartbeatTimer.unref === 'function') heartbeatTimer.unref();
}
function stopHeartbeat() {
  if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
}

// Loopback HTTP probe for the Electron preload: GET /asset-available?sha256=<hex>
// -> { ok, present } ; GET /asset?sha256=<hex> -> 302 to file:// cache path (only
// for trusted in-process use). Everything is 127.0.0.1-only.
function startHttpProbe() {
  try {
    httpServer = http.createServer((req, res) => {
      try {
        const u = new URL(req.url, `http://127.0.0.1:${AGENT_PORT}`);
        const sha = (u.searchParams.get('sha256') || '').toLowerCase();
        if (!/^[0-9a-f]{64}$/.test(sha)) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ ok: false, error: 'bad_sha' }));
        }
        if (u.pathname === '/asset-available') {
          const local = localAssetResolver(sha);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ ok: true, sha256: sha, present: !!local, path: local || null }));
        }
        if (u.pathname === '/asset') {
          const local = localAssetResolver(sha);
          if (!local) { res.writeHead(404, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ ok: false, error: 'not_cached' })); }
          // file:// redirect — Electron resolves; mcmedia:// handler also serves it.
          res.writeHead(302, { Location: `file://${local}` });
          return res.end();
        }
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'not_found' }));
      } catch (e) {
        try { res.writeHead(500); res.end('{"ok":false}'); } catch { /* ignore */ }
      }
    });
    httpServer.listen(AGENT_PORT, '127.0.0.1', () => {
      console.log('[room-agent] http probe listening on 127.0.0.1:' + AGENT_PORT);
    });
    httpServer.on('error', (e) => console.warn('[room-agent] http probe error (non-fatal):', e && e.message));
  } catch (e) {
    console.warn('[room-agent] http probe start failed (non-fatal):', e && e.message);
  }
}

function applyManifest(manifest) {
  if (!Array.isArray(manifest)) {
    console.warn('[room-agent] sync-manifest payload not an array; ignoring');
    return;
  }
  log(`[room-agent] sync-manifest received: ${manifest.length} assets`);
  for (const item of manifest) {
    if (!item || !item.sha256 || !item.canonical_url) continue;
    asyncDownload(item).catch(e => log(`[room-agent] download error ${item.sha256}:`, e && e.message));
  }
  Promise.resolve(syncWorker.pruneCache()).catch(() => {});
}

function asyncDownload(item) {
  return new Promise((resolve) => {
    (async () => {
      try {
        const res = await syncWorker.downloadAsset(item);
        log(`[room-agent] ${item.sha256.slice(0, 10)} -> ${res.status}${res.error ? ' err=' + res.error : ''}`);
      } catch (e) {
        log(`[room-agent] ${item.sha256.slice(0, 10)} threw:`, e && e.message);
      } finally { resolve(); }
    })();
  });
}

function handleSnapshotRequest(payload, ack) {
  log('[room-agent] snapshot-request received (stub: not_supported)');
  if (typeof ack === 'function') {
    try { ack({ node_id: MC_NODE_ID, ok: false, error: 'not_supported' }); } catch { /* ignore */ }
  }
}

function log(...args) { console.log(new Date().toISOString(), ...args); }

function connect() {
  if (shuttingDown) return;
  let SocketIOClient;
  try {
    SocketIOClient = require('socket.io-client');
  } catch (e) {
    console.error('[room-agent] socket.io-client is not installed. Run `npm install` in the room-agent dir.');
    scheduleReconnect();
    return;
  }

  try {
    const urlObj = new URL(MC_SERVER_URL);
    io = SocketIOClient.connect(new URL('/device', urlObj).toString(), {
      transports: ['websocket', 'polling'],
      reconnection: true,
      reconnectionAttempts: Infinity,
      reconnectionDelay: BACKOFF_MIN_MS,
      reconnectionDelayMax: BACKOFF_MAX_MS,
      auth: { token: MC_NODE_TOKEN, node_id: MC_NODE_ID, node_type: NODE_TYPE, role: 'node' },
    });
  } catch (e) {
    console.error('[room-agent] invalid MC_SERVER_URL:', e && e.message);
    scheduleReconnect();
    return;
  }

  io.on('connect', () => {
    backoffMs = BACKOFF_MIN_MS;
    log('[room-agent] connected to', MC_SERVER_URL, '/device');
    joinNodeRoom();
    startHeartbeat();
  });

  io.on('node:joined', () => { /* server ack of the join, optional */ });

  io.on('node:sync-manifest', (manifest) => {
    try { applyManifest(manifest); } catch (e) { log('[room-agent] manifest apply threw:', e && e.message); }
  });

  io.on('node:snapshot-request', (payload, ack) => {
    try { handleSnapshotRequest(payload, ack); } catch { /* ignore */ }
  });

  io.on('connect_error', (err) => log('[room-agent] connect_error:', err && err.message));
  io.on('disconnect', (reason) => { log('[room-agent] disconnected:', reason); stopHeartbeat(); });
  io.io.on('reconnect_attempt', () => log('[room-agent] reconnect attempt...'));
}

function joinNodeRoom() {
  try {
    if (io && io.connected) io.emit('join', { room: `node:${MC_NODE_ID}`, node_id: MC_NODE_ID, token: MC_NODE_TOKEN });
  } catch (e) { log('[room-agent] join failed:', e && e.message); }
}

function scheduleReconnect() {
  if (shuttingDown) return;
  const delay = backoffMs;
  backoffMs = Math.min(BACKOFF_MAX_MS, backoffMs * 2);
  setTimeout(() => { if (!io || !io.connected) connect(); }, delay).unref();
}

function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  log(`[room-agent] ${signal} received, shutting down`);
  stopHeartbeat();
  try { if (httpServer) httpServer.close(); } catch { /* ignore */ }
  try { if (io) io.close(); } catch { /* ignore */ }
  try { syncWorker.close && syncWorker.close(); } catch { /* ignore */ }
  setTimeout(() => process.exit(0), 500);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('uncaughtException', (e) => console.error('[room-agent] uncaughtException:', e && e.stack));
process.on('unhandledRejection', (e) => console.error('[room-agent] unhandledRejection:', e && e.message));

startHttpProbe();
connect();

// Exported surface for in-process callers (Electron preload reuses the resolver).
module.exports = { localAssetResolver, getStatus: () => syncWorker.getStatus() };