const path = require('path');
const os = require('os');
const { localContentBaseUrlFromEnv } = require('./lib/local-asset-url');

// Parse a human-friendly cache-quota string ("60G", "60GB", "6000000000", 60).
// Used by roomAgentCacheQuotaBytes below + the backfill/agent scripts. Returns
// bytes as an integer; on any parse failure the caller's fallback is used.
function parseCacheQuota(raw) {
  if (raw == null) return null;
  if (typeof raw === 'number') return Math.max(0, Math.floor(raw));
  const s = String(raw).trim().toLowerCase().replace(/_+/g, '');
  if (!s) return null;
  const m = s.match(/^(\d+(?:\.\d+)?)\s*([kmgt]?i?b?)$/);
  if (!m) return null;
  const num = parseFloat(m[1]);
  if (!Number.isFinite(num)) return null;
  const unit = m[2] || '';
  const factors = {
    '': 1, b: 1,
    k: 1024, kb: 1024, kib: 1024,
    m: 1024 ** 2, mb: 1024 ** 2, mib: 1024 ** 2,
    g: 1024 ** 3, gb: 1024 ** 3, gib: 1024 ** 3,
    t: 1024 ** 4, tb: 1024 ** 4, tib: 1024 ** 4,
  };
  const factor = factors[unit];
  if (!factor) return null;
  return Math.max(0, Math.floor(num * factor));
}

module.exports = {
  appName: process.env.APP_NAME || 'Media Control',
  port: process.env.PORT || 3001,
  httpsPort: process.env.HTTPS_PORT || 3443,
  // DB_PATH lets the SQLite file live OUTSIDE the code dir. In Docker the data
  // volume must NOT mount over server/db or it shadows database.js/schema.sql
  // (the volume is seeded once from the first image and never refreshes the code).
  dbPath: process.env.DB_PATH || path.join(__dirname, 'db', 'remote_display.db'),
  uploadsDir: path.join(__dirname, 'uploads'),
  contentDir: path.join(__dirname, 'uploads', 'content'),
  screenshotsDir: path.join(__dirname, 'uploads', 'screenshots'),
  frontendDir: path.join(__dirname, '..', 'frontend'),
  // Optional LAN delivery base for classroom displays. When set, playlist
  // payloads include per-item asset_url values that point at the local GMKtec
  // origin instead of the public Cloudflare hostname, so large media fan-out
  // rides the training-room LAN. Leave empty to preserve direct/public URLs.
  localContentBaseUrl: localContentBaseUrlFromEnv(process.env),
  // Room-agent asset cache (P3 + Kamrui). Quota is parsed from
  // MBFD_ROOM_AGENT_CACHE_Q (e.g. "60G"); defaults to 60 GiB. The cache dir
  // defaults to a platform-appropriate path but is normally overridden on-box
  // via env: Windows → C:\MBFD\RoomAgent, Linux → /opt/mbfd/room-agent. These
  // are read by the appliance agents + backfill tooling; the server itself does
  // not populate the cache, so a missing dir is non-fatal.
  roomAgentCacheQuotaBytes: parseCacheQuota(process.env.MBFD_ROOM_AGENT_CACHE_Q) || (60 * 1024 ** 3),
  roomAgentCacheDir: process.env.MBFD_ROOM_AGENT_CACHE_DIR
    || (os.platform() === 'win32' ? 'C:\\MBFD\\RoomAgent' : '/opt/mbfd/room-agent'),
  // App-level heartbeat. Checker runs every heartbeatInterval and marks
  // devices offline if last_heartbeat is older than heartbeatTimeout.
  // Env override for self-hosters on slow/jittery networks (issue #3:
  // reporter found raising HEARTBEAT_TIMEOUT to 60s reduced false offlines).
  heartbeatInterval: parseInt(process.env.HEARTBEAT_INTERVAL) || 10000,
  heartbeatTimeout:  parseInt(process.env.HEARTBEAT_TIMEOUT)  || 45000,
  // How long the server holds commands/playlist-updates for a device that's
  // offline at emit time (ms). On reconnect within this window, queued events
  // are flushed in order. Past TTL they're dropped. See lib/command-queue.js.
  commandQueueTtlMs: parseInt(process.env.COMMAND_QUEUE_TTL_MS) || 30000,
  // Phase 2 command/state model (lib/command-model.js). Ack deadline applied
  // to every requires_ack=1 command row; the sweep marks timed-out rows and
  // optionally re-emits up to commandMaxRetries. require_ack is per command
  // type — today everything is ingested with requires_ack=0 (logging only);
  // ack-per-type is enabled gradually.
  commandAckTimeoutMs: parseInt(process.env.COMMAND_ACK_TIMEOUT_MS) || 8000,
  commandMaxRetries:   parseInt(process.env.COMMAND_MAX_RETRIES)   || 2,
  ackSweepIntervalMs:  parseInt(process.env.ACK_SWEEP_INTERVAL_MS)  || 2500,
  nodeHeartbeatTimeout: parseInt(process.env.NODE_HEARTBEAT_TIMEOUT) || 60000,
  // Per-socket display-control rate limiting (lib/socket-rate-limit.js). Caps
  // how fast / how many concurrent control events ONE dashboard socket can
  // relay to displays so a malicious or buggy client can't flood a panel.
  // Defaults are generous enough for fast whiteboard strokes + rapid taps.
  socketControlRatePerSec: parseInt(process.env.SOCKET_CONTROL_RATE_PER_SEC) || 25,
  socketControlBurst:      parseInt(process.env.SOCKET_CONTROL_BURST) || 60,
  socketControlMaxDepth:   parseInt(process.env.SOCKET_CONTROL_MAX_DEPTH) || 60,
  // Engine.IO transport-level ping/pong. pingInterval lowered to 10s so a
  // wedged transport is probed quickly; pingTimeout raised to 60s to tolerate
  // the high-latency Tailscale DERP relay (~843ms) and CDN-buffered tunnels
  // without spurious transport drops that trigger disconnect/reconnect cycles
  // (which reload every cell and stall the wall). Worst-case dead-socket
  // detection: pingInterval + pingTimeout = 70s.
  pingInterval: parseInt(process.env.PING_INTERVAL) || 10000,
  pingTimeout:  parseInt(process.env.PING_TIMEOUT)  || 60000,
  // File-size ceiling for uploaded content. Env-configurable (MAX_FILE_SIZE_BYTES)
  // with a high default for massive ultra-wide master files / long-form video.
  // IMPORTANT: when this app is reached THROUGH Cloudflare (the orange-cloud proxy
  // or a cloudflared tunnel — which is how media-control.mbfdhub.com is served),
  // CF enforces its OWN request-body ceiling (100MB Free/Pro, 200MB Business,
  // 500MB Enterprise) BEFORE the request ever reaches us — uploads above the CF
  // tier get a 413 at the edge regardless of this value. To actually ingest
  // multi-GB files, either upload over a path that bypasses CF (e.g. the box's
  // tailnet address directly to the Node port) or use a chunked/resumable (tus)
  // flow that keeps each chunk under the CF limit.
  maxFileSize: parseInt(process.env.MAX_FILE_SIZE_BYTES, 10) || (20 * 1024 * 1024 * 1024), // 20GB default
  thumbnailWidth: 320,
  screenshotQuality: 70,
  // SSL: drop your Cloudflare Origin cert + key in certs/ folder
  // or set env vars SSL_CERT and SSL_KEY to custom paths
  sslCert: process.env.SSL_CERT || path.join(__dirname, 'certs', 'cert.pem'),
  sslKey: process.env.SSL_KEY || path.join(__dirname, 'certs', 'key.pem'),
  // Auth
  jwtSecret: process.env.JWT_SECRET || (() => {
    const secretFile = path.join(__dirname, 'certs', '.jwt_secret');
    const fs = require('fs');
    if (fs.existsSync(secretFile)) return fs.readFileSync(secretFile, 'utf8').trim();
    const secret = require('crypto').randomBytes(64).toString('hex');
    try { fs.mkdirSync(path.dirname(secretFile), { recursive: true }); fs.writeFileSync(secretFile, secret); } catch {}
    return secret;
  })(),
  jwtExpiry: '7d',
  // Google OAuth - set these in env or here
  googleClientId: process.env.GOOGLE_CLIENT_ID || '',
  // Microsoft OAuth - set these in env or here
  microsoftClientId: process.env.MICROSOFT_CLIENT_ID || '',
  microsoftTenantId: process.env.MICROSOFT_TENANT_ID || 'common',
  // Microsoft Graph email sender (services/email.js). Required for actual
  // delivery; absent values short-circuit to a stdout fallback for local dev.
  graphTenantId: process.env.GRAPH_TENANT_ID || '',
  graphClientId: process.env.GRAPH_CLIENT_ID || '',
  graphClientSecret: process.env.GRAPH_CLIENT_SECRET || '',
  graphSenderEmail: process.env.GRAPH_SENDER_EMAIL || '',
  graphSenderName: process.env.GRAPH_SENDER_NAME || 'Media Control',
  // Dev safety net: comma-separated allow-list of recipient emails. When set,
  // sends to any address NOT in the list are suppressed (logged but not posted
  // to Graph). Intended for local dev that pulls fresh prod DB copies - keeps
  // us from accidentally emailing real prod users. UNSET on prod systemd unit.
  graphDevRestrictTo: process.env.GRAPH_DEV_RESTRICT_TO || '',
  // Self-hosted mode: if true, first user gets enterprise plan and no billing
  selfHosted: process.env.SELF_HOSTED === 'true',
  // Disable public registration (OAuth auto-signup is also blocked when set).
  // First-user setup is still allowed so a fresh install can be initialized.
  disableRegistration: ['true', '1'].includes(String(process.env.DISABLE_REGISTRATION || '').toLowerCase()),
  // Redirect / -> /app instead of serving the marketing landing page.
  // For self-hosted internal deployments that don't want the public homepage.
  disableHomepage: ['true', '1'].includes(String(process.env.DISABLE_HOMEPAGE || '').toLowerCase()),

  // Dedicated physical classroom console mode. This does NOT replace normal
  // dashboard authentication; it mints dashboard JWTs only for the trusted
  // podium console route and can be gated by an internal device token.
  console: {
    roomId: process.env.ROOM_ID || 'classroom-1',
    deviceId: process.env.DEVICE_ID || 'classroom-1-podium-console',
    defaultProfile: process.env.DEFAULT_PROFILE || 'guest',
    deviceToken: process.env.CONSOLE_DEVICE_TOKEN || process.env.DEVICE_TOKEN || '',
    guestUserId: process.env.CONSOLE_GUEST_USER_ID || 'guest',
    guestEmail: process.env.CONSOLE_GUEST_EMAIL || 'guest@mbfd.local',
  },

  // ── Classroom-only local content cache (P3 room-agent) ───────────────────
  // When enabled, ONLY the displays that belong to the listed classroom video
  // walls get their playlist asset_url rewritten to the on-box room-agent cache
  // (a read-through proxy that serves cached bytes locally and transparently
  // falls back to this server on a miss). Every other display in every other
  // workspace/room is untouched and keeps fetching from the server, so adding
  // new displays anywhere else is unaffected. The player ALSO has an automatic
  // origin fallback, so a down/incomplete cache can never blank a wall.
  //
  // DEFAULT OFF: with no env set this whole feature is inert (no behavior change).
  //   CLASSROOM_LOCAL_CACHE_ENABLED=true            turn the rewrite on
  //   CLASSROOM_LOCAL_CACHE_BASE=http://127.0.0.1:8097   room-agent HTTP base
  //                                                 (players run ON the P3, so loopback)
  //   CLASSROOM_LOCAL_CACHE_WALL_IDS=<uuid>,<uuid>  walls whose devices use it
  //   CLASSROOM_LOCAL_CACHE_NODE_TOKEN=<secret>     per-node auth (heartbeat/manifest)
  //   CLASSROOM_LOCAL_CACHE_ROOM_ID=classroom-1     room id reported by the node
  classroomCache: {
    enabled: ['true', '1'].includes(String(process.env.CLASSROOM_LOCAL_CACHE_ENABLED || '').toLowerCase()),
    baseUrl: (process.env.CLASSROOM_LOCAL_CACHE_BASE || 'http://127.0.0.1:8097').replace(/\/+$/, ''),
    nodeId: process.env.CLASSROOM_LOCAL_CACHE_NODE_ID || 'classroom-1-p3',
    wallIds: String(process.env.CLASSROOM_LOCAL_CACHE_WALL_IDS || '')
      .split(',').map((s) => s.trim()).filter(Boolean),
    nodeToken: process.env.CLASSROOM_LOCAL_CACHE_NODE_TOKEN || '',
    roomId: process.env.CLASSROOM_LOCAL_CACHE_ROOM_ID || process.env.ROOM_ID || 'classroom-1',
  },

  // ── MBFD Media Control Studio ────────────────────────────────────────────
  // Local Ollama (server-side ONLY; the frontend never calls this). Reached
  // from inside the container via the Docker bridge gateway. Bound localhost on
  // the host — never exposed through Cloudflare.
  ollamaBaseUrl: process.env.OLLAMA_BASE_URL || 'http://172.17.0.1:11434',
  ollamaModel: process.env.OLLAMA_MODEL || 'qwen3.6:35b',
  ollamaFallbackModel: process.env.OLLAMA_FALLBACK_MODEL || '',
  // Nextcloud WebDAV. For per-user deck sync (services/nextcloud-sync.js) point
  // NEXTCLOUD_URL at the INTERNAL origin (e.g. http://mbfd-nextcloud) so server-
  // to-server calls bypass Cloudflare Access. sharedPassword is the common
  // password every NC user logs in with (set in the box .env, NEVER committed);
  // the NC uid is the work-email local-part. user/pass remain for the optional
  // service-account Files browser (routes/files.js).
  nextcloud: {
    url: process.env.NEXTCLOUD_URL || 'https://cloud.mbfdhub.com',
    user: process.env.NEXTCLOUD_USER || '',
    pass: process.env.NEXTCLOUD_PASS || '',
    sharedPassword: process.env.NEXTCLOUD_SHARED_PASSWORD || '',
    baseDir: process.env.NEXTCLOUD_BASE_DIR || 'MBFD Media Control',
    // Per-user raw-FS microservices (mbfd-ai Docker network).
    // container defaults work when media-control is on the mbfd-ai network;
    // override with NC_USERFS_URL / NC_WRITE_URL in the container env for
    // non-default placements. WebDAV vars above remain as disabled fallback.
    //
    // DEPLOY-TIME TODOs (not in this repo — perform on the GMKtec box):
    //   1. docker network connect mbfd-ai <media-control-container>
    //      (or add networks: [mbfd-ai] to the compose service + networks:
    //       { mbfd-ai: { external: true } } in the compose file)
    //   2. Set NC_USERFS_URL=http://nextcloud-user-fs:8000 in container env
    //   3. Set NC_WRITE_URL=http://nextcloud-write:8000 in container env
    //   4. Set NC_USERFS_TOKEN / NC_WRITE_TOKEN in container env — both services
    //      ALSO require a service-level bearer token (NEXTCLOUD_FS_TOKEN /
    //      NEXTCLOUD_WRITE_TOKEN on the box) in addition to the per-user email
    //      header, so any other container on mbfd-ai can't impersonate users.
    //      Get the values from the box .env for nextcloud-user-fs / nextcloud-write.
    //   5. Verify: docker exec <container> curl -s \
    //        -H 'Authorization: Bearer <NC_USERFS_TOKEN>' \
    //        -H 'X-OpenWebUI-User-Email: peterdarley@miamibeachfl.gov' \
    //        http://nextcloud-user-fs:8000/list_directory -d '{"path":""}' \
    //      should return peterdarley's NC files.
    userfsUrl: process.env.NC_USERFS_URL || 'http://nextcloud-user-fs:8000',
    writeUrl: process.env.NC_WRITE_URL || 'http://nextcloud-write:8000',
    userfsToken: process.env.NC_USERFS_TOKEN || '',
    writeToken: process.env.NC_WRITE_TOKEN || '',
  },
  // Feature flags — flip a module off without touching the core player/display
  // system. Default ON; set ENABLE_*=false to disable.
  features: {
    presentationStudio: process.env.ENABLE_PRESENTATION_STUDIO !== 'false',
    aiDeckBuilder: process.env.ENABLE_AI_DECK_BUILDER !== 'false',
    mediaDownloader: process.env.ENABLE_MEDIA_DOWNLOADER !== 'false',
    nextcloudSync: process.env.ENABLE_NEXTCLOUD_SYNC !== 'false',
    videoWallStudio: process.env.ENABLE_VIDEO_WALL_STUDIO !== 'false',
    broadcastCenter: process.env.ENABLE_BROADCAST_CENTER !== 'false',
  },
  // Live stream orchestration. Media Control only talks to the local AI Director
  // API; OBS websocket remains local-only behind that service.
  liveStream: {
    aiDirectorUrl: process.env.AI_DIRECTOR_URL || 'http://127.0.0.1:8766',
    aiDirectorTimeoutMs: parseInt(process.env.AI_DIRECTOR_TIMEOUT_MS, 10) || 5000,
    playerBaseUrl: process.env.LIVE_STREAM_PLAYER_BASE_URL || process.env.APP_URL || '',
    peerTubeWatchUrl: process.env.PEERTUBE_LIVE_WATCH_URL || '',
  },
};
