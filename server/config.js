const path = require('path');

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
  // Engine.IO transport-level ping/pong. Raised from Socket.IO defaults
  // (25000/20000) because TV WebKits (LG webOS, older Tizen) miss pongs
  // under decode load - tighter values cause spurious transport drops.
  // Worst-case dead-socket detection: pingInterval + pingTimeout = 60s.
  pingInterval: parseInt(process.env.PING_INTERVAL) || 30000,
  pingTimeout:  parseInt(process.env.PING_TIMEOUT)  || 30000,
  // Generous file-size ceiling for video-wall content. Triple-4K wallpapers
  // as PNG can easily land at 100-300MB; long-form training videos can run
  // to a couple of GB. NOTE: Cloudflare's edge enforces its own body-size
  // ceiling (100MB Free, 100MB Pro, 200MB Business, 500MB Enterprise) so
  // anything above the CF tier won't ever reach this limit and the user
  // sees a 413 from the edge, not us. Prefer JPEG/WebP for wallpapers to
  // stay comfortably under all tiers.
  maxFileSize: 2 * 1024 * 1024 * 1024, // 2GB
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
};
