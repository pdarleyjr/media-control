// cache-agent.js — classroom P3 room-agent (read-through cache model).
//
// Starts the local read-through content cache (cache-server.js) for the on-box
// player windows, then connects to the Media Control server's /device namespace
// as a node (handshake role:'node') to: send heartbeats, receive the content
// pre-warm manifest, and periodically re-pull it so newly-uploaded library
// content is staged without waiting for a broadcast.
//
// Dependencies: ONLY `socket.io-client` (no native modules), so Windows install
// is `npm install` with no build toolchain. Every credential/URL is read from
// env at runtime; nothing is hard-coded or committed.
'use strict';

const fs = require('fs');
const { createCacheServer } = require('./cache-server');
const { resolveServerUrl } = require('../../common/server-url');
const { detectNetworkState } = require('../../common/network-state');

const MC_SERVER_URL = resolveServerUrl(process.env, {
  urlKeys: ['MC_SERVER_LAN_URL', 'MC_SERVER_URL'],
  defaultUrl: 'http://100.81.154.123:8096',
});
const MC_NODE_ID = process.env.MC_NODE_ID || '';
const MC_NODE_TOKEN = process.env.MC_NODE_TOKEN || '';
const NODE_TYPE = process.env.MC_NODE_TYPE || 'p3';
const SOFTWARE_VERSION = process.env.MC_SOFTWARE_VERSION || 'p3-cache-agent-1.0.0';
const AGENT_PORT = parseInt(process.env.MC_AGENT_PORT, 10) || 8097;
const AGENT_HOST = process.env.MC_AGENT_HOST || '127.0.0.1';
const CACHE_DIR = process.env.MBFD_ROOM_AGENT_CACHE_DIR
  ? require('path').join(process.env.MBFD_ROOM_AGENT_CACHE_DIR, 'cache')
  : (process.platform === 'win32' ? 'C:\\MBFD\\RoomAgent\\cache' : '/opt/mbfd/room-agent/cache');
const ACTIVE_DISPLAYS = (process.env.MC_ACTIVE_DISPLAYS || '').split(',').map((s) => s.trim()).filter(Boolean);
const AUDIO_ENDPOINT = process.env.MC_AUDIO_ENDPOINT || 'eARC';

const HEARTBEAT_MS = 15 * 1000;
const MANIFEST_REFRESH_MS = 15 * 1000; // new uploads enter the local cache before an instructor selects them

function log(...a) { console.log(new Date().toISOString(), ...a); }
function warn(...a) { console.warn(new Date().toISOString(), ...a); }

if (!MC_NODE_ID || !MC_NODE_TOKEN) {
  console.error('[cache-agent] Missing MC_NODE_ID or MC_NODE_TOKEN env. Set them in the on-box config (never committed).');
  process.exit(2);
}

// 1) Start the local read-through cache immediately (independent of the socket).
const cache = createCacheServer({ originBaseUrl: MC_SERVER_URL, cacheDir: CACHE_DIR, port: AGENT_PORT, host: AGENT_HOST, log, warn });
cache.listen();

function freeDiskBytes() {
  try {
    if (typeof fs.statfsSync !== 'function') return -1;
    const st = fs.statfsSync(CACHE_DIR);
    return (st.bavail || 0) * (st.bsize || 0);
  } catch { return -1; }
}

let io = null;
let hbTimer = null;
let manifestTimer = null;
let shuttingDown = false;

function heartbeat() {
  if (!io || !io.connected) return;
  const stats = cache.getStats();
  const network = detectNetworkState();
  const serverUrlCategory = process.env.MC_SERVER_LAN_URL
    ? 'lan'
    : (process.env.MC_SERVER_URL ? 'configured' : 'documented_tailnet_fallback');
  io.emit('node:heartbeat', {
    node_id: MC_NODE_ID,
    node_type: NODE_TYPE,
    ts: Math.floor(Date.now() / 1000),
    software_version: SOFTWARE_VERSION,
    free_disk: freeDiskBytes(),
    cache_size: stats.cache_size,
    sync_status: stats.sync_status || 'idle',
    active_displays: ACTIVE_DISPLAYS,
    audio_endpoint: AUDIO_ENDPOINT,
    network: {
      ...network,
      selected_server_url_category: serverUrlCategory,
      effective_ip: network.ethernet?.addresses?.[0] || network.wifi?.addresses?.[0] || null,
      reachability: io && io.connected ? 'connected' : 'disconnected',
    },
    player_version: process.env.MC_PLAYER_VERSION || null,
    kiosk_version: process.env.MC_KIOSK_VERSION || null,
    build_hash: process.env.MC_BUILD_HASH || process.env.GIT_COMMIT || null,
    cache_health: stats.failed > 0 ? 'degraded' : 'ok',
    cache: stats,
    display_mapping: ACTIVE_DISPLAYS,
    current_asset_readiness: stats.failed > 0 ? 'failed' : 'ready',
    current_renderer: process.env.MC_CURRENT_RENDERER || null,
    audio_track_present: process.env.MC_AUDIO_TRACK_PRESENT || null,
    audio_codec: process.env.MC_AUDIO_CODEC || null,
    last_successful_command: process.env.MC_LAST_SUCCESSFUL_COMMAND || null,
    last_command_error: process.env.MC_LAST_COMMAND_ERROR || null,
  });
}

function connect() {
  if (shuttingDown) return;
  let ioClient;
  try { ioClient = require('socket.io-client'); }
  catch (e) { console.error('[cache-agent] socket.io-client not installed. Run `npm install` in this dir.'); setTimeout(connect, 5000); return; }

  io = ioClient.connect(`${MC_SERVER_URL}/device`, {
    transports: ['websocket', 'polling'],
    reconnection: true,
    reconnectionAttempts: Infinity,
    reconnectionDelay: 2000,
    reconnectionDelayMax: 5 * 60 * 1000,
    auth: { token: MC_NODE_TOKEN, node_id: MC_NODE_ID, node_type: NODE_TYPE, role: 'node' },
  });

  io.on('connect', () => {
    log('[cache-agent] connected to', MC_SERVER_URL, '/device as node', MC_NODE_ID);
    try { io.emit('join', { room: 'node:' + MC_NODE_ID, node_id: MC_NODE_ID }); } catch (_) {}
    heartbeat();
    if (hbTimer) clearInterval(hbTimer);
    hbTimer = setInterval(heartbeat, HEARTBEAT_MS);
    if (hbTimer.unref) hbTimer.unref();
    // Ask for the manifest now and on a slow cadence so new uploads pre-warm.
    try { io.emit('node:request-manifest'); } catch (_) {}
    if (manifestTimer) clearInterval(manifestTimer);
    manifestTimer = setInterval(() => { try { io.emit('node:request-manifest'); } catch (_) {} }, MANIFEST_REFRESH_MS);
    if (manifestTimer.unref) manifestTimer.unref();
  });

  io.on('node:joined', () => log('[cache-agent] node join acked'));
  io.on('node:auth-error', (e) => warn('[cache-agent] node auth error:', e && e.error));
  io.on('node:sync-manifest', (manifest) => {
    const n = Array.isArray(manifest) ? manifest.length : 0;
    log(`[cache-agent] manifest received: ${n} items — pre-warming`);
    cache.prewarmManifest(manifest).catch((err) => warn('[cache-agent] prewarm error:', err && err.message));
  });
  io.on('node:prewarm-content', async (item, acknowledge) => {
    const contentId = item && (item.content_id || item.id);
    const startedAt = Date.now();
    const ok = await cache.prewarmPriority(item).catch((err) => {
      warn('[cache-agent] priority prewarm error:', err && err.message);
      return false;
    });
    const result = {
      ok,
      content_id: contentId || null,
      elapsed_ms: Date.now() - startedAt,
      cache: cache.getStats(),
    };
    log(`[cache-agent] priority prewarm ${contentId || 'unknown'} ${ok ? 'ready' : 'failed'} in ${result.elapsed_ms}ms`);
    if (typeof acknowledge === 'function') acknowledge(result);
    try { io.emit('node:prewarm-result', result); } catch (_) {}
  });
  io.on('connect_error', (err) => warn('[cache-agent] connect_error:', err && err.message));
  io.on('disconnect', (reason) => { log('[cache-agent] disconnected:', reason); if (hbTimer) { clearInterval(hbTimer); hbTimer = null; } });
}

function shutdown(sig) {
  if (shuttingDown) return;
  shuttingDown = true;
  log(`[cache-agent] ${sig} — shutting down`);
  if (hbTimer) clearInterval(hbTimer);
  if (manifestTimer) clearInterval(manifestTimer);
  try { if (io) io.close(); } catch (_) {}
  try { cache.close(); } catch (_) {}
  setTimeout(() => process.exit(0), 400);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('uncaughtException', (e) => console.error('[cache-agent] uncaughtException:', e && e.stack));
process.on('unhandledRejection', (e) => console.error('[cache-agent] unhandledRejection:', e && e.message));

connect();
