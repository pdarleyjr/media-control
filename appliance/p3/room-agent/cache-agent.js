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
const crypto = require('crypto');
const path = require('path');
const { createCacheServer } = require('./cache-server');
const { loadCommonModule } = require('./common-loader');
const { resolveServerUrl } = loadCommonModule('server-url');
const { applyLinkTelemetry, detectNetworkState } = loadCommonModule('network-state');
const { createWindowsNetworkProbe } = loadCommonModule('windows-network-probe');
const { runLanHealthTest } = require('./lan-health-test');

const MC_SERVER_URL = resolveServerUrl(process.env, {
  urlKeys: ['MC_SERVER_LAN_URL', 'MC_SERVER_URL'],
  defaultUrl: 'http://100.81.154.123:8096',
});
const MC_NODE_ID = process.env.MC_NODE_ID || '';
const MC_NODE_TOKEN = process.env.MC_NODE_TOKEN || '';
const NODE_TYPE = process.env.MC_NODE_TYPE || 'p3';
const PACKAGE_VERSION = (() => {
  try { return require('./package.json').version; } catch { return '1.1.0'; }
})();
const SOFTWARE_VERSION = process.env.MC_SOFTWARE_VERSION || `p3-cache-agent-${PACKAGE_VERSION}`;
const AGENT_PORT = parseInt(process.env.MC_AGENT_PORT, 10) || 8097;
const AGENT_HOST = process.env.MC_AGENT_HOST || '127.0.0.1';
const CACHE_DIR = process.env.MBFD_ROOM_AGENT_CACHE_DIR
  ? require('path').join(process.env.MBFD_ROOM_AGENT_CACHE_DIR, 'cache')
  : (process.platform === 'win32' ? 'C:\\MBFD\\RoomAgent\\cache' : '/opt/mbfd/room-agent/cache');
const ACTIVE_DISPLAYS = (process.env.MC_ACTIVE_DISPLAYS || '').split(',').map((s) => s.trim()).filter(Boolean);
const AUDIO_ENDPOINT = process.env.MC_AUDIO_ENDPOINT || 'eARC';

const HEARTBEAT_MS = 15 * 1000;
const requestedManifestRefresh = parseInt(process.env.MC_MANIFEST_REFRESH_MS, 10) || 10 * 60 * 1000;
const MANIFEST_REFRESH_MS = Math.min(15 * 60 * 1000, Math.max(5 * 60 * 1000, requestedManifestRefresh));
const probeWindowsNetwork = createWindowsNetworkProbe({ ttlMs: 60 * 1000 });
const AGENT_STARTED_AT = Date.now();

function packageVersion(filePath) {
  try { return JSON.parse(fs.readFileSync(filePath, 'utf8')).version || null; } catch { return null; }
}

function agentBuildHash() {
  try {
    const hash = crypto.createHash('sha256');
    for (const file of [__filename, path.join(__dirname, 'cache-server.js')]) {
      hash.update(fs.readFileSync(file));
    }
    return `sha256:${hash.digest('hex').slice(0, 16)}`;
  } catch { return null; }
}

const KIOSK_VERSION = process.env.MC_KIOSK_VERSION
  || packageVersion('C:\\MBFD\\FiveDisplayKiosk\\package.json');
const AGENT_BUILD_HASH = process.env.MC_BUILD_HASH || process.env.GIT_COMMIT || agentBuildHash();

function log(...a) { console.log(new Date().toISOString(), ...a); }
function warn(...a) { console.warn(new Date().toISOString(), ...a); }

if (!MC_NODE_ID || !MC_NODE_TOKEN) {
  console.error('[cache-agent] Missing MC_NODE_ID or MC_NODE_TOKEN env. Set them in the on-box config (never committed).');
  process.exit(2);
}

// 1) Start the local read-through cache immediately (independent of the socket).
const cache = createCacheServer({
  originBaseUrl: MC_SERVER_URL,
  nodeToken: MC_NODE_TOKEN,
  cacheDir: CACHE_DIR,
  port: AGENT_PORT,
  host: AGENT_HOST,
  log,
  warn,
});
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
let lastLanHealthTest = null;

function heartbeat() {
  if (!io || !io.connected) return;
  const stats = cache.getStats();
  const network = detectNetworkState();
  const windowsDiagnostics = probeWindowsNetwork();
  const serverUrlCategory = process.env.MC_SERVER_LAN_URL
    ? 'lan'
    : (process.env.MC_SERVER_URL ? 'tailscale' : 'documented_tailnet_fallback');
  const networkTelemetry = applyLinkTelemetry(network, windowsDiagnostics, {
    server_url_category: serverUrlCategory,
  });
  const effectiveIp = [...(network.ethernet?.addresses || []), ...(network.wifi?.addresses || [])]
    .find((address) => /^\d{1,3}(?:\.\d{1,3}){3}$/.test(String(address))) || null;
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
      ...networkTelemetry,
      selected_server_url_category: serverUrlCategory,
      effective_ip: effectiveIp,
      reachability: io && io.connected ? 'connected' : 'disconnected',
    },
    player_version: process.env.MC_PLAYER_VERSION || null,
    kiosk_version: KIOSK_VERSION,
    build_hash: AGENT_BUILD_HASH,
    configuration_schema_version: 1,
    cache_health: stats.failed > 0 ? 'degraded' : 'ok',
    cache: stats,
    lan_health_test: lastLanHealthTest,
    agent_uptime_sec: Math.floor((Date.now() - AGENT_STARTED_AT) / 1000),
    kiosk_uptime_sec: windowsDiagnostics && windowsDiagnostics.kiosk_uptime_sec,
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
  io.on('node:run-lan-health-test', async (request, acknowledge) => {
    const requestedAt = Math.floor(Date.now() / 1000);
    try {
      lastLanHealthTest = await runLanHealthTest({
        originBaseUrl: MC_SERVER_URL,
        nodeToken: MC_NODE_TOKEN,
        testId: request && request.test_id,
        cacheStats: cache.getStats(),
        warningMbps: process.env.MC_LAN_HEALTH_WARNING_MBPS,
        healthyMbps: process.env.MC_LAN_HEALTH_HEALTHY_MBPS,
      });
      log(`[cache-agent] admin LAN health test ${lastLanHealthTest.mbps} Mbps (${lastLanHealthTest.status})`);
    } catch (error) {
      lastLanHealthTest = {
        ok: false,
        at: requestedAt,
        error: String(error && error.message || 'health_test_failed').slice(0, 128),
      };
      warn('[cache-agent] admin LAN health test refused/failed:', lastLanHealthTest.error);
    }
    heartbeat();
    if (typeof acknowledge === 'function') acknowledge(lastLanHealthTest);
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
