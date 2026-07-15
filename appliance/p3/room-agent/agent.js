// ============================================================
// MBFD P3 appliance room-agent (Windows).
// Connects to the Media Control server over Socket.IO (`/device` namespace)
// using a per-node token (MC_NODE_TOKEN — gitignored), joins room `node:<id>`,
// sends a node heartbeat every 15s, applies server-pushed sync manifests, and
// best-effort handles snapshot requests. No secrets are hard-coded — every
// credential/URL is read from env at runtime. Reco\Cnnects with exponential
// backoff and exits cleanly on SIGINT/SIGTERM.
//
// Only Node built-ins + `socket.io-client`. Asset sync state lives in the local
// SQLite manifest managed by sync-worker.js (requires `better-sqlite3` shipped
// in this package's node_modules — degrades to stateless if absent).
// ============================================================
'use strict';

const fs = require('fs');

const syncWorker = require('./sync-worker');
const { loadCommonModule } = require('./common-loader');
const { resolveServerUrl } = loadCommonModule('server-url');
const { detectNetworkState } = loadCommonModule('network-state');

const DEFAULT_SERVER_URL = 'http://100.81.154.123:8096'; // GMKtec Tailnet (documented default)
const HEARTBEAT_INTERVAL_MS = 15 * 1000;
const BACKOFF_MIN_MS = 2 * 1000;
const BACKOFF_MAX_MS = 5 * 60 * 1000;

// ── Config (env only) ───────────────────────────────────────
const MC_SERVER_URL = resolveServerUrl(process.env, {
  urlKeys: ['MC_SERVER_LAN_URL', 'MC_SERVER_URL'],
  defaultUrl: DEFAULT_SERVER_URL,
});
const MC_NODE_TOKEN = process.env.MC_NODE_TOKEN || '';
const MC_NODE_ID = process.env.MC_NODE_ID || '';
const NODE_TYPE = process.env.MC_NODE_TYPE || 'p3';
const SOFTWARE_VERSION = process.env.MC_SOFTWARE_VERSION || 'p3-agent-1.0.0';
const ACTIVE_DISPLAYS = (process.env.MC_ACTIVE_DISPLAYS || '').split(',').map(s => s.trim()).filter(Boolean);
const AUDIO_ENDPOINT_NAME = process.env.MC_AUDIO_ENDPOINT || 'eARC'; // Ultimea/eARC tag
const ROOM_HEARTBEAT_EVENT = 'node:heartbeat';
const SNAPSHOT_TIMEOUT_MS = parseInt(process.env.MC_SNAPSHOT_TIMEOUT_MS, 10) || 15000;

if (!MC_NODE_TOKEN || !MC_NODE_ID) {
  console.error('[room-agent] Missing MC_NODE_TOKEN or MC_NODE_ID env vars. Set them in the on-box config (never committed).');
  process.exit(2);
}

let io = null;
let heartbeatTimer = null;
let backoffMs = BACKOFF_MIN_MS;
let shuttingDown = false;

function ts() { return Math.floor(Date.now() / 1000); }

// Best-effort free-disk bytes for the cache dir. Falls back to -1 if statfs is
// unavailable (very old Node). Never throws so heartbeats stay air-worthy.
function freeDiskBytes() {
  try {
    const dir = syncWorker.getStatus().assets_dir;
    if (!dir || typeof fs.statfs !== 'function') return -1;
    const st = fs.statfsSync(dir);
    return (st.bavail || 0) * (st.bsize || 0);
  } catch { return -1; }
}

// nodeId is the node's secret; we do NOT echo the token. node_id comes from env.
function buildHeartbeat() {
  const status = syncWorker.getStatus();
  const network = detectNetworkState();
  const serverUrlCategory = process.env.MC_SERVER_LAN_URL
    ? 'lan'
    : (process.env.MC_SERVER_URL ? 'configured' : 'documented_tailnet_fallback');
  return {
    node_id: MC_NODE_ID,
    node_type: NODE_TYPE,
    ts: ts(),
    software_version: SOFTWARE_VERSION,
    free_disk: freeDiskBytes(),
    cache_size: status.cache_size,
    sync_status: status.sync_status,
    active_displays: ACTIVE_DISPLAYS,
    audio_endpoint: AUDIO_ENDPOINT_NAME, // P3-only field
    network: {
      ...network,
      selected_server_url_category: serverUrlCategory,
      effective_ip: network.ethernet?.addresses?.[0] || network.wifi?.addresses?.[0] || null,
      reachability: io && io.connected ? 'connected' : 'disconnected',
    },
    player_version: process.env.MC_PLAYER_VERSION || null,
    kiosk_version: process.env.MC_KIOSK_VERSION || null,
    build_hash: process.env.MC_BUILD_HASH || process.env.GIT_COMMIT || null,
    cache_health: status.failed > 0 ? 'degraded' : 'ok',
    cache: status,
    display_mapping: ACTIVE_DISPLAYS,
    current_asset_readiness: status.sync_status,
    current_renderer: process.env.MC_CURRENT_RENDERER || null,
    audio_track_present: process.env.MC_AUDIO_TRACK_PRESENT || null,
    audio_codec: process.env.MC_AUDIO_CODEC || null,
    last_successful_command: process.env.MC_LAST_SUCCESSFUL_COMMAND || null,
    last_command_error: process.env.MC_LAST_COMMAND_ERROR || null,
  };
}

function sendHeartbeat() {
  try {
    if (!io || !io.connected) return;
    const payload = buildHeartbeat();
    io.emit(ROOM_HEARTBEAT_EVENT, payload);
  } catch (e) {
    console.warn('[room-agent] heartbeat send failed (non-fatal):', e && e.message);
  }
}

function startHeartbeat() {
  stopHeartbeat();
  sendHeartbeat(); // immediate
  heartbeatTimer = setInterval(sendHeartbeat, HEARTBEAT_INTERVAL_MS);
  if (typeof heartbeatTimer.unref === 'function') heartbeatTimer.unref();
}

function stopHeartbeat() {
  if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
}

// Apply a server-pushed manifest: list of desired { sha256, canonical_url,
// size, asset_id } rows. Downloads each resumably + verifies. Never blocks the
// socket event handler — downloads run async; progress is reported in
// subsequent heartbeats.
function applyManifest(manifest) {
  if (!Array.isArray(manifest)) {
    console.warn('[room-agent] sync-manifest payload not an array; ignoring');
    return;
  }
  log(`[room-agent] sync-manifest received: ${manifest.length} assets`);
  for (const item of manifest) {
    if (!item || !item.sha256 || !item.canonical_url) continue;
    let canonicalUrl = item.canonical_url;
    try { canonicalUrl = new URL(item.canonical_url, MC_SERVER_URL).toString(); }
    catch { continue; }
    asyncDownload({ ...item, canonical_url: canonicalUrl }).catch(e => log(`[room-agent] download error ${item.sha256}:`, e && e.message));
  }
  // Prune the cache after kicking off a manifest apply.
  Promise.resolve(syncWorker.pruneCache()).catch(() => {});
}

// fireAndForget wrapper around syncWorker.downloadAsset so list iteration above
// can stay synchronous and report per-asset outcomes without rejecting the loop.
function asyncDownload(item) {
  return new Promise((resolve) => {
    (async () => {
      try {
        const res = await syncWorker.downloadAsset(item);
        log(`[room-agent] ${item.sha256.slice(0, 10)} → ${res.status}${res.error ? ' err=' + res.error : ''}`);
      } catch (e) {
        log(`[room-agent] ${item.sha256.slice(0, 10)} threw:`, e && e.message);
      } finally { resolve(); }
    })();
  });
}

// Best-effort snapshot capture. Stub for now: the P3 player windows render in a
// separate process we don't yet have a capture IPC into. Acknowledge politely
// so the server can stop retrying.
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
    const namespace = '/device';
    io = SocketIOClient.connect(new URL(namespace, urlObj).toString(), {
      transports: ['websocket', 'polling'],
      reconnection: true,
      reconnectionAttempts: Infinity,
      reconnectionDelay: BACKOFF_MIN_MS,
      reconnectionDelayMax: BACKOFF_MAX_MS,
      auth: { token: MC_NODE_TOKEN, node_id: MC_NODE_ID, node_type: NODE_TYPE, role: 'node' },
      // Don't leak the token on querystring logs; carried in auth.
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

  io.on('connect_error', (err) => {
    log('[room-agent] connect_error:', err && err.message);
  });

  io.on('disconnect', (reason) => {
    log('[room-agent] disconnected:', reason);
    stopHeartbeat();
  });

  io.io.on('reconnect_attempt', () => { log('[room-agent] reconnect attempt…'); });
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
  setTimeout(() => {
    if (!io || !io.connected) connect();
  }, delay).unref();
}

function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  log(`[room-agent] ${signal} received, shutting down`);
  stopHeartbeat();
  try { if (io) io.close(); } catch { /* ignore */ }
  try { syncWorker.close && syncWorker.close(); } catch { /* ignore */ }
  setTimeout(() => process.exit(0), 500);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('uncaughtException', (e) => {
  console.error('[room-agent] uncaughtException:', e && e.stack);
});
process.on('unhandledRejection', (e) => {
  console.error('[room-agent] unhandledRejection:', e && e.message);
});

connect();
