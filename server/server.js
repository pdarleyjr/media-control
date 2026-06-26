const express = require('express');
const http = require('http');
const https = require('https');
const { Server } = require('socket.io');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const config = require('./config');

// 2026-05-28: top-level safety nets. A single unhandled throw inside a
// Socket.IO listener used to kill the entire Node process, putting the
// container into a restart loop that broke playback for every device. We
// fix the root causes per-handler, but also log + survive any future
// regression so a single bad payload can't take production down again.
process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err && err.stack || err);
});
process.on('unhandledRejection', (reason, promise) => {
  console.error('[unhandledRejection]', reason && reason.stack || reason);
});

// Ensure upload directories exist
[config.contentDir, config.screenshotsDir].forEach(dir => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

const app = express();
const { trustedProxies } = require('./config/cloudflareIps');
const { getClientIp } = require('./services/activity');
// Trust loopback / link-local / unique-local (local dev, LAN reverse proxies)
// and Cloudflare's published edge ranges. With this list, req.ip resolves to
// the original client when fronted by Cloudflare; X-Forwarded-For from any
// non-trusted source is ignored, so the value can't be spoofed.
app.set('trust proxy', trustedProxies);

// Determine if SSL certs are available
const hasSsl = fs.existsSync(config.sslCert) && fs.existsSync(config.sslKey);
let server;

if (hasSsl) {
  const sslOptions = {
    cert: fs.readFileSync(config.sslCert),
    key: fs.readFileSync(config.sslKey),
  };
  server = https.createServer(sslOptions, app);
} else {
  server = http.createServer(app);
}

// Socket.IO CORS is checked via the same corsOriginCheck function defined below
// (after config is loaded). Hoisted into a closure so we can reference it before
// the function is defined — at first connection time, corsOriginCheck exists.
const io = new Server(server, {
  cors: {
    origin: (origin, cb) => corsOriginCheck(origin, cb),
    credentials: true,
  },
  maxHttpBufferSize: 10 * 1024 * 1024, // 10MB for screenshot uploads
  pingInterval: config.pingInterval,
  pingTimeout: config.pingTimeout,
});

// Middleware
const helmet = require('helmet');

// CSP applies to the dashboard / app pages only. Widget and kiosk renders are
// publicly accessed by devices and intentionally use inline scripts/styles —
// they're served from /api/widgets/:id/render and /api/kiosk/:id/render and
// skip the CSP layer below via path-based opt-out.
//
// scriptSrc 'self' blocks <script> injection (the primary XSS vector) and external
// JS. scriptSrcAttr 'unsafe-inline' allows existing onclick/onchange handlers on
// dashboard buttons — TODO: refactor these to addEventListener and tighten further.
// styleSrcAttr 'unsafe-inline' is required because the views use inline style="..."
// attributes extensively for layout.
const dashboardCsp = helmet.contentSecurityPolicy({
  useDefaults: true,
  directives: {
    defaultSrc: ["'self'"],
    // Cloudflare auto-injects its web-analytics beacon (static.cloudflareinsights.com)
    // and an inline bootstrap snippet into every served HTML page at the edge.
    // Both are blocked by 'self' alone, producing CSP console warnings on every load
    // and causing Cloudflare's CAPTCHA/bot-check script to fail. Allow them explicitly.
    // The inline bootstrap hash is stable across Cloudflare edge nodes.
    scriptSrc: [
      "'self'",
      "https://static.cloudflareinsights.com",
      "'sha256-ZswfTY7H35rbv8WC7NXBoiC7WNu86vSzCDChNWwZZDM='",
    ],
    scriptSrcAttr: ["'unsafe-inline'"],
    styleSrc: ["'self'", "'unsafe-inline'"],
    styleSrcAttr: ["'unsafe-inline'"],
    imgSrc: ["'self'", 'data:', 'blob:', 'https:'],
    mediaSrc: ["'self'", 'blob:', 'https:'],
    connectSrc: ["'self'", 'wss:', 'ws:', 'https:'],
    fontSrc: ["'self'", 'data:'],
    frameSrc: ["'self'", 'https://www.youtube.com', 'https://youtube.com', 'https://*.mbfdhub.com', 'https://www.youtube-nocookie.com'],
    objectSrc: ["'none'"],
    baseUri: ["'self'"],
    formAction: ["'self'"],
    // Allow MBFD Workspace (cloud.mbfdhub.com) to embed this dashboard via
    // External Sites widget. All other origins still rejected.
    frameAncestors: ["'self'", "https://cloud.mbfdhub.com"],
    // Don't force HTTPS — self-hosted deployments may run on HTTP-only LANs.
    upgradeInsecureRequests: null,
  },
});

app.use(helmet({
  contentSecurityPolicy: false,        // we apply our own below, scoped to non-render paths
  crossOriginEmbedderPolicy: false,    // allow loading external widget content
  frameguard: false,                   // X-Frame-Options can't express multi-origin; frame-ancestors does
  hsts: { maxAge: 31536000, includeSubDomains: true },
}));

// Apply CSP everywhere except routes that legitimately need inline scripts:
// - widget/kiosk renders (public, fetched by devices, intentionally inline)
// - /player (the web player has inline JS, served to display devices)
// - /         (redirects to /app)
// The dashboard at /app uses ES modules only and gets the strict policy.
app.use((req, res, next) => {
  if (req.path === '/') return next();
  if (req.path.startsWith('/player')) return next();
  if (req.path.startsWith('/api/widgets/') && req.path.endsWith('/render')) return next();
  if (req.path.startsWith('/api/kiosk/') && req.path.endsWith('/render')) return next();
  return dashboardCsp(req, res, next);
});
// CORS policy.
// - SELF_HOSTED=true: allow all origins (operator controls their own deployment).
// - production:       allowlist screentinker.com (+ subdomains) and localhost dev.
// - development:      open (default).
// Auth is JWT in Authorization header — credentials:true is kept for any cookie-based
// future flows but the JWT stays in localStorage and is sent via fetch() explicitly,
// so an attacker origin can't ride a session.
const isProd = process.env.NODE_ENV === 'production';
const allowedHostsProd = [
  'screentinker.com',
  'www.screentinker.com',
  'localhost',
  '127.0.0.1',
];

function corsOriginCheck(origin, callback) {
  // No origin = same-origin / mobile app / server-to-server / kiosk iframe.
  if (!origin) return callback(null, true);
  if (config.selfHosted) return callback(null, true);
  if (!isProd) return callback(null, true);
  let host;
  try { host = new URL(origin).hostname; } catch { return callback(null, false); }
  const allowed = allowedHostsProd.some(h => host === h || host.endsWith('.' + h));
  if (allowed) return callback(null, true);
  callback(null, false);
}

app.use(cors({
  origin: corsOriginCheck,
  credentials: true,
}));

app.use(express.json());
const { sanitizeBody } = require('./middleware/sanitize');
app.use(sanitizeBody);

// Root always redirects to the app (no public marketing landing page).
// 302 (not 301) so this isn't hard-cached by browsers.
app.get('/', (req, res) => res.redirect(302, '/app'));

// Dashboard app
app.get('/app', (req, res) => {
  res.sendFile(path.join(config.frontendDir, 'index.html'));
});

// Serve frontend static files
// JS/CSS/HTML: no-cache (always revalidate, uses ETag/304)
// Images/fonts/icons: long cache for Cloudflare + browser
app.use(express.static(config.frontendDir, { index: false, etag: true, lastModified: true, setHeaders: (res, filePath) => {
  if (filePath.endsWith('.js') || filePath.endsWith('.css') || filePath.endsWith('.html')) {
    res.setHeader('Cache-Control', 'no-cache');
  } else if (/\.(png|jpg|jpeg|gif|svg|ico|woff2?|ttf|eot|webp|mp4|webm)$/i.test(filePath)) {
    res.setHeader('Cache-Control', 'public, max-age=2592000'); // 30 days
  }
}}));

// Player HTML: dynamic route. Injects a small inline window.__playerConfig
// script before the debug-overlay.js tag so the client knows whether to send
// telemetry to /api/player-debug. The PLAYER_DEBUG_REPORTING env var defaults
// to on - set to "off" to suppress all player-side telemetry POSTs (the
// server-side endpoint defends in depth, but the kill switch saves network
// traffic on the device too). Other player assets (JS, sw.js, etc) are still
// served by the static middleware below; only index.html is dynamic.
app.get(['/player', '/player/', '/player/index.html'], (req, res) => {
  const playerHtmlPath = path.join(__dirname, 'player', 'index.html');
  fs.readFile(playerHtmlPath, 'utf8', (err, html) => {
    if (err) return res.status(500).type('text/plain').send('player HTML unavailable');
    const reportingEnabled = String(process.env.PLAYER_DEBUG_REPORTING || 'on').toLowerCase() !== 'off';
    const inject =
      '  <script>window.__playerConfig = window.__playerConfig || {}; ' +
      'window.__playerConfig.debugReporting = ' + JSON.stringify(reportingEnabled) + ';</script>\n';
    // Inject right before the debug-overlay.js script tag. If for any reason
    // the tag isn't present (e.g. file edited out), fall back to injecting
    // before </head> so the flag still lands.
    let modified;
    if (html.indexOf('<script src="/player/debug-overlay.js"') >= 0) {
      modified = html.replace('<script src="/player/debug-overlay.js"', inject + '  <script src="/player/debug-overlay.js"');
    } else {
      modified = html.replace('</head>', inject + '</head>');
    }
    res.type('html').setHeader('Cache-Control', 'no-cache');
    res.send(modified);
  });
});

// MBFD Media Control Studio — public deck player. Served UNDER /player/* so it
// inherits the existing Cloudflare-Access + CSP bypass (displays load it with
// no OTP). The mbfd-deck-v1 document is inlined into the HTML (no authenticated
// API call needed). Published snapshot is preferred; falls back to the working
// deck. The deck JSON is `<`-escaped so AI/user content containing "</script>"
// can't break out of the inline script tag.
app.get('/player/deck/:id', (req, res) => {
  const { db } = require('./db/database');
  const p = db.prepare('SELECT id, title, deck_json, status, published_snapshot FROM presentations WHERE id = ?').get(req.params.id);
  const deckHtmlPath = path.join(__dirname, 'player', 'deck.html');
  fs.readFile(deckHtmlPath, 'utf8', (err, html) => {
    if (err) return res.status(500).type('text/plain').send('deck player unavailable');
    let deckJson = 'null';
    if (p) {
      const raw = p.published_snapshot || p.deck_json || 'null';
      try { JSON.parse(raw); deckJson = raw; } catch { deckJson = 'null'; }
    }
    const safe = deckJson.replace(/</g, '\\u003c');
    const inject = '<script>window.__deck = ' + safe + ';</script>\n';
    res.type('html').setHeader('Cache-Control', 'no-cache').send(html.replace('</head>', inject + '</head>'));
  });
});

// MBFD live stream OBS browser source. This is a tokenized player URL for the
// managed virtual display named "Content for live stream". It bypasses manual
// pairing while still using the normal player and device socket protocol.
app.get('/player/live-stream', (req, res) => {
  const { loadLiveStreamDisplay } = require('./lib/live-stream-display');
  const display = loadLiveStreamDisplay(req.query.device_id, req.query.token);
  if (!display) return res.status(404).type('text/plain').send('live stream display not found');
  const playerHtmlPath = path.join(__dirname, 'player', 'index.html');
  fs.readFile(playerHtmlPath, 'utf8', (err, html) => {
    if (err) return res.status(500).type('text/plain').send('player HTML unavailable');
    const reportingEnabled = String(process.env.PLAYER_DEBUG_REPORTING || 'on').toLowerCase() !== 'off';
    const publicConfig = {
      debugReporting: reportingEnabled,
      managedDisplay: {
        deviceId: display.id,
        deviceToken: display.device_token,
        deviceName: display.name,
        // The live-stream player runs inside OBS's browser source on the SAME
        // machine. Always use localhost so the WebSocket + content bypass the
        // Cloudflare tunnel (which adds latency and can fail the WS upgrade,
        // leaving the PIP stuck in "connecting").
        serverUrl: 'http://127.0.0.1:8096',
      },
    };
    const inject = '  <script>window.__playerConfig = ' + JSON.stringify(publicConfig).replace(/</g, '\\u003c') + ';</script>\n';
    const modified = html.indexOf('<script src="/player/debug-overlay.js"') >= 0
      ? html.replace('<script src="/player/debug-overlay.js"', inject + '  <script src="/player/debug-overlay.js"')
      : html.replace('</head>', inject + '</head>');
    res.type('html').setHeader('Cache-Control', 'no-cache');
    res.send(modified);
  });
});

// Managed tokenized player for fixed room integrations. This keeps the normal
// /player pairing flow unchanged while allowing a room-specific wrapper to
// bypass manual pairing for known displays using their existing device token.
app.get('/player/managed', (req, res) => {
  const { loadManagedDisplay } = require('./lib/managed-player-display');
  const display = loadManagedDisplay(req.query.device_id, req.query.token);
  if (!display) return res.status(404).type('text/plain').send('managed display not found');
  const playerHtmlPath = path.join(__dirname, 'player', 'index.html');
  fs.readFile(playerHtmlPath, 'utf8', (err, html) => {
    if (err) return res.status(500).type('text/plain').send('player HTML unavailable');
    const reportingEnabled = String(process.env.PLAYER_DEBUG_REPORTING || 'on').toLowerCase() !== 'off';
    const publicConfig = {
      debugReporting: reportingEnabled,
      managedDisplay: {
        deviceId: display.id,
        deviceToken: display.device_token,
        deviceName: display.name,
        serverUrl: `${req.protocol}://${req.get('host')}`,
        // audioEnabled drives auto-unmute in the player. Passed by the kiosk as
        // ?audio_enabled=1 only for the TV that feeds the eARC soundbar (TV1).
        audioEnabled: req.query.audio_enabled === '1',
      },
    };
    const inject = '  <script>window.__playerConfig = ' + JSON.stringify(publicConfig).replace(/</g, '\\u003c') + ';</script>\n';
    const modified = html.indexOf('<script src="/player/debug-overlay.js"') >= 0
      ? html.replace('<script src="/player/debug-overlay.js"', inject + '  <script src="/player/debug-overlay.js"')
      : html.replace('</head>', inject + '</head>');
    res.type('html').setHeader('Cache-Control', 'no-cache');
    res.send(modified);
  });
});

app.get('/api/live-stream/local/program-state', (req, res) => {
  const { liveStreamProgramStateAnyWorkspace } = require('./lib/live-stream-display');
  res.setHeader('Cache-Control', 'no-store');
  res.json(liveStreamProgramStateAnyWorkspace());
});

// Advanced canvas media is private workspace content, so it cannot use the
// presentation-only public asset route below. This endpoint accepts only an
// HMAC-bound endpoint/content/workspace tuple generated while publishing the
// scene. It exposes no device or user token and checks current DB ownership on
// every request, so deleting an endpoint immediately revokes its asset URLs.
app.get('/player/canvas-asset/:endpointId/:contentId/:width/:height/:signature', async (req, res) => {
  const { db } = require('./db/database');
  const { verifyCanvasAsset } = require('./lib/canvas-asset-signature');
  const endpoint = db.prepare(
    'SELECT id, workspace_id FROM advanced_canvas_endpoints WHERE id = ?'
  ).get(req.params.endpointId);
  if (!endpoint) return res.status(404).type('text/plain').send('not found');
  const content = db.prepare(
    'SELECT id, workspace_id, filepath, mime_type FROM content WHERE id = ?'
  ).get(req.params.contentId);
  if (!content || !content.filepath) return res.status(404).type('text/plain').send('not found');
  if (content.workspace_id && content.workspace_id !== endpoint.workspace_id) {
    return res.status(403).type('text/plain').send('forbidden');
  }
  if (!verifyCanvasAsset({
    endpointId: endpoint.id,
    contentId: content.id,
    workspaceId: endpoint.workspace_id,
    width: req.params.width,
    height: req.params.height,
    secret: config.jwtSecret,
    signature: req.params.signature,
  })) {
    return res.status(403).type('text/plain').send('forbidden');
  }
  const safePath = path.resolve(config.contentDir, path.basename(content.filepath));
  if (!safePath.startsWith(path.resolve(config.contentDir))) {
    return res.status(403).type('text/plain').send('invalid path');
  }

  let filePath = safePath;
  let mimeType = String(content.mime_type || 'application/octet-stream');
  if (mimeType.startsWith('image/')) {
    try {
      const { getCanvasImageVariant } = require('./lib/canvas-image-cache');
      filePath = await getCanvasImageVariant(
        content.id,
        safePath,
        req.params.width,
        req.params.height,
        config.contentDir
      );
      mimeType = 'image/webp';
    } catch (error) {
      console.warn('[canvas-asset] image optimization failed:', error.message);
      return res.status(502).type('text/plain').send('image optimization failed');
    }
  }
  const { getOfficePdf, isConvertibleOfficeMime } = require('./lib/doc-pdf');
  if (isConvertibleOfficeMime(mimeType)) {
    try {
      filePath = await getOfficePdf(content.id, safePath, mimeType);
      mimeType = 'application/pdf';
    } catch (error) {
      console.warn('[canvas-asset] document conversion failed:', error.message);
      return res.status(502).type('text/plain').send('document conversion failed');
    }
  }

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
  res.setHeader('Cache-Control', 'private, max-age=3600');
  res.setHeader('Content-Type', mimeType);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.sendFile(filePath);
});

// MBFD Media Control Studio — public slide-image serving. Under /player/* so it
// inherits the Cloudflare-Access + CSP bypass: deck images load on unattended
// displays with no OTP, exactly like the deck HTML itself. ONLY rows that are
// (a) an image and (b) linked by a presentation_assets row are served — so this
// can't be used to enumerate arbitrary private content. UUIDs are unguessable,
// matching the public deck threat model (anyone with a deck URL can already see
// the deck + its images). Path-traversal guarded; CORS-open + long cache.
app.get('/player/asset/:id', (req, res) => {
  const { db } = require('./db/database');
  const c = db.prepare('SELECT id, filepath, mime_type FROM content WHERE id = ?').get(req.params.id);
  if (!c || !c.filepath) return res.status(404).type('text/plain').send('not found');
  if (!c.mime_type || !c.mime_type.startsWith('image/')) return res.status(404).type('text/plain').send('not found');
  const linked = db.prepare('SELECT 1 FROM presentation_assets WHERE content_id = ? LIMIT 1').get(req.params.id);
  if (!linked) return res.status(403).type('text/plain').send('not a presentation asset');
  const safePath = path.resolve(config.contentDir, path.basename(c.filepath));
  if (!safePath.startsWith(path.resolve(config.contentDir))) return res.status(403).type('text/plain').send('invalid path');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
  res.setHeader('Cache-Control', 'public, max-age=2592000, immutable');
  // Force the stored (image/*) MIME — never let the on-disk extension drive the
  // Content-Type (an attacker could upload a raster file named ".html"). nosniff
  // stops browsers MIME-sniffing the bytes into something executable.
  res.setHeader('Content-Type', c.mime_type);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.sendFile(safePath);
});

// MBFD Media Control — Ozolio live-camera stream resolver (Camera Feeds tab).
// Ozolio gates HLS resolution on the embedding "document", so the bare relay embed
// renders black on our origin. We resolve the .m3u8 here with the allow-listed
// document; /player/oz.html then plays it via hls.js (relay segments are ACAO:* so
// they play from any origin). Public + under /player so it inherits the existing
// Cloudflare-Access bypass — unattended displays reach it with no OTP. The oid is
// strictly whitelisted (EMB_ alphanumeric) so the fixed upstream host can't be
// abused for SSRF.
const { resolveOzolioStream, posterUrl } = require('./lib/ozolio-resolve');
app.get('/player/oz-stream', async (req, res) => {
  try {
    const data = await resolveOzolioStream(String(req.query.oid || ''));
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 'public, max-age=60');
    res.json(data);
  } catch (e) {
    res.status(e.status || 502).json({ error: e.message || 'resolve failed' });
  }
});
app.get('/player/oz-poster', (req, res) => {
  const u = posterUrl(String(req.query.oid || ''));
  if (!u) return res.status(400).type('text/plain').send('invalid oid');
  res.setHeader('Cache-Control', 'public, max-age=30');
  res.redirect(302, u);
});

// MBFD Media Control — Miami live-NEWS resolver + proxy (Camera Feeds "Live News").
// /player/news-stream?station=<key> resolves a whitelisted station key to a
// playable HLS .m3u8 ({source}); /player/hls.html plays it with hls.js. Most
// stations are a direct CDN master; WSVN is AES-128 + CORS-locked so its source is
// a /player/hls-proxy URL that relays the playlist + key with ACAO:*. Public under
// /player (Cloudflare-Access bypass) so unattended displays reach it without OTP;
// station keys are server-whitelisted (no arbitrary URL -> no SSRF).
const { resolveNewsStream } = require('./lib/news-streams');
const { handleProxy } = require('./lib/hls-proxy');
app.get('/player/news-stream', async (req, res) => {
  try {
    const data = await resolveNewsStream(String(req.query.station || '').toLowerCase());
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 'public, max-age=30');
    res.json(data);
  } catch (e) {
    res.status(e.status || 502).json({ error: e.message || 'resolve failed' });
  }
});
app.get('/player/hls-proxy', handleProxy);

// Fixed classroom camera gateway. It exposes only the two MediaMTX paths used by
// the P3 WyreStorm and Linux podium cameras, and rewrites HLS assets to HTTPS.
const { handleClassroomCamera } = require('./lib/classroom-camera');
app.get('/player/classroom-camera/:camera/*', handleClassroomCamera);

// MBFD Media Control — server-side website screenshot (Website broadcasting).
// Renders a third-party site with headless Chromium and serves a JPEG, so sites
// that block framing (X-Frame-Options / CSP frame-ancestors) still display on
// walls and inside multiview frames. Public under /player (Cloudflare-Access
// bypass) so unattended displays reach it without OTP. NOT an open proxy: the
// URL is read from the content row by id (already operator-chosen + SSRF-checked
// at creation) and RE-validated here (closes DNS-rebinding); clients never pass
// a raw URL. The :id is an unguessable UUID, matching the /player/asset model.
const { getSiteShot, isExternalHttpUrl } = require('./lib/site-shot');
const { assertRemoteUrlSafe } = require('./lib/ssrf-policy');
app.get('/player/site-shot/:id', async (req, res) => {
  try {
    const { db } = require('./db/database');
    const c = db.prepare('SELECT id, remote_url, mime_type FROM content WHERE id = ?').get(req.params.id);
    if (!c || !c.remote_url) return res.status(404).type('text/plain').send('not found');
    if (c.mime_type !== 'text/html' || !isExternalHttpUrl(c.remote_url)) {
      return res.status(400).type('text/plain').send('not a website');
    }
    const safe = await assertRemoteUrlSafe(c.remote_url);
    if (!safe.ok) return res.status(400).type('text/plain').send('blocked url');
    const file = await getSiteShot(c.id, c.remote_url, { width: req.query.w, height: req.query.h, interval: req.query.interval });
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    res.setHeader('Cache-Control', 'public, max-age=5');
    res.setHeader('Content-Type', 'image/jpeg');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.sendFile(file);
  } catch (e) {
    console.warn('[site-shot] render failed:', e && e.message);
    res.status(502).type('text/plain').send('render failed');
  }
});

// MBFD Media Control — Office/ODF document playback as PDF (Content > office docs).
// PPT/PPTX/DOC/DOCX/XLS/XLSX/ODF can't render in a browser frame as raw bytes, and
// the old ONLYOFFICE api.js iframe URL displayed the JS library as text. Here we
// convert the document to a PDF with headless LibreOffice (cached) and serve it so
// the player can show it through the native PDF viewer — the same path PDFs use.
// Public under /player (Cloudflare-Access bypass) so unattended displays reach it
// without OTP. Same deployment guard as /api/content/:id/file: only serve docs that
// are actually referenced by a playlist/widget in their workspace (or are platform
// templates), so a leaked UUID can't convert+exfiltrate arbitrary private uploads.
const { getOfficePdf, isConvertibleOfficeMime } = require('./lib/doc-pdf');
const { canServePublicContent } = require('./lib/public-content-access');
const { DEFAULT_DPI, clampPage, getPdfPageCount, getRenderablePdf, isDocumentMime, renderPdfPageImage } = require('./lib/doc-render');
app.get('/player/doc-pdf/:id', async (req, res) => {
  try {
    const { db } = require('./db/database');
    const c = db.prepare('SELECT id, filepath, mime_type, workspace_id FROM content WHERE id = ?').get(req.params.id);
    if (!c || !c.filepath) return res.status(404).type('text/plain').send('not found');
    if (!isConvertibleOfficeMime(c.mime_type)) return res.status(400).type('text/plain').send('not an office document');
    if (!canServePublicContent(db, c)) return res.status(403).type('text/plain').send('not assigned to any playlist or widget');
    const srcPath = path.resolve(config.contentDir, path.basename(c.filepath));
    if (!srcPath.startsWith(path.resolve(config.contentDir))) return res.status(403).type('text/plain').send('invalid path');
    const pdfPath = await getOfficePdf(c.id, srcPath, c.mime_type);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.sendFile(pdfPath);
  } catch (e) {
    console.warn('[doc-pdf] convert failed:', e && e.message);
    res.status(502).type('text/plain').send('conversion failed');
  }
});

// Controllable PDF / Office document player. Unlike the browser's native PDF
// plugin, /player/doc/:id can receive Command Center transport events and move
// page-by-page through an uploaded PDF or LibreOffice-converted PowerPoint.
app.get('/player/doc/:id', (req, res) => {
  res.setHeader('Cache-Control', 'no-cache');
  res.sendFile(path.join(__dirname, 'player', 'doc.html'));
});

app.get('/player/doc-meta/:id', async (req, res) => {
  try {
    const { db } = require('./db/database');
    const c = db.prepare('SELECT id, filename, filepath, mime_type, workspace_id FROM content WHERE id = ?').get(req.params.id);
    if (!c || !c.filepath) return res.status(404).json({ error: 'not found' });
    if (!isDocumentMime(c.mime_type)) return res.status(400).json({ error: 'not a document' });
    if (!canServePublicContent(db, c)) return res.status(403).json({ error: 'not assigned to any playlist or widget' });
    const pdfPath = await getRenderablePdf(c);
    const pages = await getPdfPageCount(pdfPath);
    const stat = fs.statSync(pdfPath);
    res.setHeader('Cache-Control', 'public, max-age=30');
    res.json({
      id: c.id,
      filename: c.filename || 'Document',
      mime_type: c.mime_type,
      pages,
      dpi: DEFAULT_DPI,
      version: Math.round(stat.mtimeMs),
    });
  } catch (e) {
    console.warn('[doc-player] metadata failed:', e && e.message);
    res.status(502).json({ error: 'metadata failed' });
  }
});

app.get('/player/doc-page/:id/:page.png', async (req, res) => {
  try {
    const { db } = require('./db/database');
    const c = db.prepare('SELECT id, filepath, mime_type, workspace_id FROM content WHERE id = ?').get(req.params.id);
    if (!c || !c.filepath) return res.status(404).type('text/plain').send('not found');
    if (!isDocumentMime(c.mime_type)) return res.status(400).type('text/plain').send('not a document');
    if (!canServePublicContent(db, c)) return res.status(403).type('text/plain').send('not assigned to any playlist or widget');
    const pdfPath = await getRenderablePdf(c);
    const pages = await getPdfPageCount(pdfPath);
    const page = clampPage(req.params.page, pages);
    const rendered = await renderPdfPageImage(c.id, pdfPath, page);
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'public, max-age=86400, immutable');
    res.sendFile(rendered.path);
  } catch (e) {
    console.warn('[doc-player] page render failed:', e && e.message);
    res.status(502).type('text/plain').send('render failed');
  }
});

// Serve web player at /player (same no-cache for JS/HTML). The index.html
// route above intercepts the HTML requests; everything else still falls
// through to this static handler (debug-overlay.js, sw.js, manifest, etc).
app.use('/player', express.static(path.join(__dirname, 'player'), { etag: true, lastModified: true, setHeaders: (res, filePath) => {
  if (filePath.endsWith('.js') || filePath.endsWith('.css') || filePath.endsWith('.html')) {
    res.setHeader('Cache-Control', 'no-cache');
  }
}}));

// Serve setup scripts
app.use('/scripts', express.static(path.join(__dirname, '..', 'scripts')));

// Serve socket.io client
app.use('/socket.io-client', express.static(
  path.join(__dirname, 'node_modules', 'socket.io', 'client-dist')
));

// Simple rate limiter for auth endpoints
const rateLimits = new Map();
function rateLimit(windowMs, maxRequests) {
  return (req, res, next) => {
    const key = getClientIp(req) + req.path;
    const now = Date.now();
    const windowStart = now - windowMs;
    let hits = rateLimits.get(key) || [];
    hits = hits.filter(t => t > windowStart);
    if (hits.length >= maxRequests) {
      return res.status(429).json({ error: 'Too many requests, try again later' });
    }
    hits.push(now);
    rateLimits.set(key, hits);
    // Cleanup old entries periodically
    if (rateLimits.size > 10000) {
      for (const [k, v] of rateLimits) { if (v.every(t => t < windowStart)) rateLimits.delete(k); }
    }
    next();
  };
}

// Auth routes (public, rate limited)
app.use('/api/auth/login', rateLimit(60000, 10)); // 10 attempts per minute
app.use('/api/auth/register', rateLimit(60000, 5)); // 5 registrations per minute
// Admin password-reset endpoint: even if an admin's session is compromised,
// cap the blast radius to 20 resets/min/IP. Express matches the longest
// path prefix first, so this fires before /api/auth catches the request.
app.use('/api/auth/users', rateLimit(60000, 20));
app.use('/api/auth', require('./routes/auth'));
app.use('/api/admin', require('./routes/admin-sync'));
// Rate limit pairing to prevent brute force (5 attempts per minute per IP)
app.use('/api/provision/pair', rateLimit(60000, 5));
// Rate limit expensive operations
app.use('/api/status/export', rateLimit(60000, 5)); // 5 exports per minute
app.use('/api/status/import', rateLimit(60000, 3)); // 3 imports per minute
app.use('/api/content', rateLimit(60000, 30)); // 30 content operations per minute

// Public contact form (enterprise inquiries from landing page). Rate limited
// to 5 submissions per minute per IP; honeypot enforced inside the route.
app.use('/api/contact', rateLimit(60000, 5));
app.use('/api/contact', require('./routes/contact'));

// Public player debug-log sink. Smart TVs and other embedded browsers
// without devtools POST captured errors here. Rate limited to 10 req/min
// per IP+path. Body is JSON (express.json() is global at line 140).
app.use('/api/player-debug', rateLimit(60000, 10));
app.use('/api/player-debug', require('./routes/player-debug'));

// Physical classroom console bootstrap. This route intentionally does not use
// normal user login; it mints a dashboard JWT for the trusted podium device so
// the room boots directly into Guest and can switch profiles from the header.
app.use('/api/console', rateLimit(60000, 60));
app.use('/api/console', require('./routes/console'));


// Screenshot route (before protected routes - needs custom auth for img tags)
const { verifyToken } = require('./middleware/auth');
app.get('/api/devices/:id/screenshot', (req, res) => {
  let user = null;
  const authHeader = req.headers.authorization;
  const tokenParam = req.query.token;
  const token = authHeader?.startsWith('Bearer ') ? authHeader.split(' ')[1] : tokenParam;
  if (!token) return res.status(401).json({ error: 'Authentication required' });
  try {
    const decoded = verifyToken(token);
    const { db } = require('./db/database');
    user = db.prepare('SELECT id, role FROM users WHERE id = ?').get(decoded.id);
    if (!user) return res.status(401).json({ error: 'User not found' });
  } catch { return res.status(401).json({ error: 'Invalid or expired token' }); }
  const { db: sdb } = require('./db/database');
  const device = sdb.prepare('SELECT user_id, workspace_id FROM devices WHERE id = ?').get(req.params.id);
  if (!device) return res.status(404).json({ error: 'Device not found' });
  // Shared-display model: a platform admin, the owner, OR any member of the
  // device's workspace may view its screenshot — mirroring GET /api/displays/state
  // (workspace-scoped) so every member sees previews of the shared room's displays.
  // (Was owner-only, which hid shared displays' previews from everyone but the owner
  // and didn't even whitelist platform_admin.)
  const isAdmin = ['admin', 'superadmin', 'platform_admin'].includes(user.role);
  let allowed = isAdmin || (device.user_id && device.user_id === user.id);
  if (!allowed && device.workspace_id) {
    allowed = !!sdb.prepare('SELECT 1 FROM workspace_members WHERE workspace_id = ? AND user_id = ?')
      .get(device.workspace_id, user.id);
  }
  if (!allowed) return res.status(403).json({ error: 'Access denied' });
  // Serve from memory if available (device online), otherwise from disk (offline snapshot)
  const deviceSocket = require('./ws/deviceSocket');
  const memScreenshot = deviceSocket.lastScreenshots?.[req.params.id];
  if (memScreenshot) {
    const buffer = Buffer.from(memScreenshot, 'base64');
    res.set('Content-Type', 'image/jpeg');
    res.set('Cache-Control', 'no-cache');
    return res.send(buffer);
  }
  const screenshot = sdb.prepare('SELECT * FROM screenshots WHERE device_id = ? ORDER BY captured_at DESC LIMIT 1').get(req.params.id);
  if (!screenshot) return res.status(404).json({ error: 'No screenshot available' });
  const safePath = path.resolve(config.screenshotsDir, path.basename(screenshot.filepath));
  if (!safePath.startsWith(path.resolve(config.screenshotsDir))) return res.status(403).json({ error: 'Invalid path' });
  res.sendFile(safePath);
});

// Public content file serving (must be BEFORE protected routes)
// 2026-05-28: previously the playlist check was global — any caller with a
// content UUID could fetch the file if it was referenced by ANY playlist in
// any workspace. Now both the playlist AND widget checks are scoped to the
// content's own workspace. Platform-template content (workspace_id IS NULL)
// remains globally fetchable when referenced anywhere, since that's its
// purpose.
app.get('/api/content/:id/file', (req, res) => {
  const { db } = require('./db/database');
  const content = db.prepare('SELECT * FROM content WHERE id = ?').get(req.params.id);
  if (!content) return res.status(404).json({ error: 'Content not found' });
  if (!content.filepath) return res.status(404).json({ error: 'No file (remote URL content)' });
  if (!canServePublicContent(db, content)) return res.status(403).json({ error: 'Content not assigned to any playlist or widget' });
  const safePath = path.resolve(config.contentDir, path.basename(content.filepath));
  if (!safePath.startsWith(path.resolve(config.contentDir))) return res.status(403).json({ error: 'Invalid path' });
  if (content.mime_type) res.setHeader('Content-Type', content.mime_type);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.sendFile(safePath);
});

// Public thumbnail serving (must be BEFORE protected routes)
app.get('/api/content/:id/thumbnail', (req, res) => {
  const { db } = require('./db/database');
  const content = db.prepare('SELECT * FROM content WHERE id = ?').get(req.params.id);
  if (!content || !content.thumbnail_path) return res.status(404).json({ error: 'Thumbnail not found' });
  const safePath = path.resolve(config.contentDir, path.basename(content.thumbnail_path));
  if (!safePath.startsWith(path.resolve(config.contentDir))) return res.status(403).json({ error: 'Invalid path' });
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.sendFile(safePath);
});

// Protected API Routes.
// Phase 2.1: resolveTenancy runs right after requireAuth on every resource
// route. It attaches req.workspaceId, req.workspaceRole, req.orgRole,
// req.isPlatformAdmin, req.actingAs. Route handlers in 2.1 don't read these
// yet (they still filter by user_id); 2.2 will migrate them one route at a time.
const { requireAuth } = require('./middleware/auth');
const { resolveTenancy } = require('./lib/tenancy');
const { requireWorkspaceWrite } = require('./lib/permissions');

// activityLogger wraps res.json on every subsequent route to auto-log
// successful POST/PUT/DELETE mutations. Mount it BEFORE the workspace routes
// (this fix corrects a pre-existing bug where it was mounted after them and
// silently never fired). Auth routes are already mounted above and stay
// opt-out from the auto-logger (login has its own inline writers).
const { activityLogger } = require('./services/activity');
app.use(activityLogger);

// /api/workspaces: management endpoints that operate on a target workspace
// (URL param), not the caller's currently active one. Hence requireAuth only,
// no resolveTenancy. Permission gated per-handler via canAdminWorkspace().
app.use('/api/workspaces', requireAuth, require('./routes/workspaces'));

app.use('/api/devices', requireAuth, resolveTenancy, require('./routes/devices'));
app.use('/api/displays', requireAuth, resolveTenancy, require('./routes/displays'));
app.use('/api/advanced-canvas', requireAuth, resolveTenancy, require('./routes/advanced-canvas'));
app.use('/api/content', requireAuth, resolveTenancy, require('./routes/content'));
// Resumable chunked uploads (tus) — for multi-GB files that exceed Cloudflare's
// ~100MB per-request edge limit. app.all (not app.use) so req.url keeps the
// /api/tus prefix the tus Server matches on; auth runs first so onUploadFinish
// sees req.user / req.workspaceId. No rate-limit (a 20GB file is hundreds of PATCHes).
const tusServer = require('./routes/tus');
const tusHandle = (req, res) => tusServer.handle(req, res);
app.all('/api/tus', requireAuth, resolveTenancy, tusHandle);
app.all('/api/tus/*', requireAuth, resolveTenancy, tusHandle);
app.use('/api/folders', requireAuth, resolveTenancy, require('./routes/folders'));
app.use('/api/assignments', requireAuth, resolveTenancy, require('./routes/assignments'));
app.use('/api/provision', requireAuth, resolveTenancy, requireWorkspaceWrite, require('./routes/provisioning'));
app.use('/api/layouts', requireAuth, resolveTenancy, require('./routes/layouts'));
// Widget render is public (accessed by devices)
app.get('/api/widgets/:id/render', (req, res, next) => { req._skipAuth = true; next(); });
// Rate limit preview endpoint — it inlines user content as base64 which is memory-intensive
app.use('/api/widgets/preview', rateLimit(60000, 30));
app.use('/api/widgets', (req, res, next) => { if (req._skipAuth) return next(); requireAuth(req, res, next); }, resolveTenancy, require('./routes/widgets'));
app.use('/api/schedules', requireAuth, resolveTenancy, require('./routes/schedules'));
app.use('/api/walls', requireAuth, resolveTenancy, require('./routes/video-walls'));
app.use('/api/teams', requireAuth, resolveTenancy, require('./routes/teams'));
app.use('/api/reports', requireAuth, resolveTenancy, require('./routes/reports'));
app.use('/api/screen-share', requireAuth, require('./routes/screen-share'));  // screen-share REST: ICE/TURN credential issuance, JWT-gated
app.use('/api/groups', requireAuth, resolveTenancy, require('./routes/device-groups'));
app.use('/api/playlists', requireAuth, resolveTenancy, require('./routes/playlists'));
// MBFD Media Control Studio: presentations (mbfd-deck-v1). Same auth+tenancy gate.
app.use('/api/presentations', requireAuth, resolveTenancy, require('./routes/presentations'));
// AI Deck Builder (server-side Ollama bridge; async jobs). AI never called from the browser.
app.use('/api/ai', requireAuth, resolveTenancy, require('./routes/ai'));
// Files (Nextcloud WebDAV proxy) + media downloads. Feature-flag + env gated.
app.use('/api/files', requireAuth, resolveTenancy, require('./routes/files'));
app.use('/api/downloads', requireAuth, resolveTenancy, require('./routes/downloads'));
// Phase 3: Operational Activities ("Scenes") + Fast Broadcast. Same
// requireAuth + resolveTenancy gating as the other resource routes; handlers
// scope by req.workspaceId and reuse the existing device-content-push path.
app.use('/api/scenes', requireAuth, resolveTenancy, require('./routes/scenes'));
app.use('/api/broadcast', requireAuth, resolveTenancy, require('./routes/broadcast'));
app.use('/api/live-stream', requireAuth, resolveTenancy, requireWorkspaceWrite, require('./routes/live-stream'));
app.use('/api/activity', requireAuth, resolveTenancy, require('./routes/activity'));
app.use('/api/white-label', requireAuth, resolveTenancy, require('./routes/white-label'));
// Kiosk render is public (accessed by devices), CRUD is protected
app.get('/api/kiosk/:id/render', (req, res, next) => {
  // Let it through to the kiosk route without auth
  req._skipAuth = true;
  next();
});
app.use('/api/kiosk', (req, res, next) => {
  if (req._skipAuth) return next();
  requireAuth(req, res, next);
}, resolveTenancy, require('./routes/kiosk'));

// Frontend version hash (changes when files are modified, triggers soft reload)
const crypto = require('crypto');
let frontendHash = '';
function updateFrontendHash() {
  try {
    const files = ['index.html', 'js/app.js', 'js/api.js', 'js/socket.js', 'css/variables.css', 'css/main.css',
      'js/views/dashboard.js', 'js/views/device-detail.js', 'js/views/content-library.js',
      'js/views/settings.js', 'js/views/login.js',
      'js/views/layout-editor.js', 'js/views/schedule.js', 'js/views/widgets.js',
      'js/views/video-wall.js', 'js/views/reports.js', 'js/views/designer.js',
      'js/views/activity.js', 'js/views/kiosk.js', 'js/views/smartboard.js',
      // Command Center is split into feature modules; include them in the
      // frontend hash so inspector/routing hotfixes force active browsers to
      // reload instead of mixing new modules with stale cached dependencies.
      'css/media-control.css', 'css/console.css', 'js/views/media-control.js',
      'js/views/media-control/command-bar.js', 'js/views/media-control/inspector.js',
      'js/views/media-control/routing-picker.js', 'js/views/media-control/stage.js',
      'js/views/media-control/toolbox.js', 'js/views/media-control/send.js',
      'js/views/media-control/transport.js', 'js/services/screen-share-engine.js'].map(f => {
      try { return fs.readFileSync(path.join(config.frontendDir, f)); } catch { return ''; }
    });
    // Include player files in hash so web players detect code updates
    try { files.push(fs.readFileSync(path.join(__dirname, 'player', 'index.html'))); } catch {}
    try { files.push(fs.readFileSync(path.join(__dirname, 'player', 'doc.html'))); } catch {}
    try { files.push(fs.readFileSync(path.join(__dirname, 'player', 'grid.html'))); } catch {}
    try { files.push(fs.readFileSync(path.join(__dirname, 'player', 'multiview-core.js'))); } catch {}
    try { files.push(fs.readFileSync(path.join(__dirname, 'player', 'screen-share-receiver.js'))); } catch {}
    try { files.push(fs.readFileSync(path.join(__dirname, 'player', 'sw.js'))); } catch {}
    try { files.push(fs.readFileSync(path.join(__dirname, 'player', 'debug-overlay.js'))); } catch {}
    frontendHash = crypto.createHash('md5').update(Buffer.concat(files.map(f => Buffer.from(f)))).digest('hex').slice(0, 8);
  } catch { frontendHash = Date.now().toString(36); }
}
updateFrontendHash();
// Recheck every 30 seconds
setInterval(updateFrontendHash, 30000);
app.get('/api/version', (req, res) => {
  let version = '1.2.0';
  try { version = fs.readFileSync(path.join(__dirname, '..', 'VERSION'), 'utf8').trim(); } catch {}
  res.json({ hash: frontendHash, version });
});

// Public status page
app.use('/api/status', require('./routes/status'));

// Activity logging middleware now mounted earlier (just before the workspace
// route block) - leaving this comment here as a breadcrumb for the move.

// APK version check endpoint (public, used by devices to check for updates).
//
// Source of truth (in priority order):
//   1. ScreenTinker.apk.json next to the APK - this is the output-metadata.json
//      that Gradle writes at app/build/outputs/apk/debug/output-metadata.json,
//      renamed and copied alongside ScreenTinker.apk so a single rebuild keeps
//      both the binary and its version metadata in lockstep. Schema:
//        { "elements": [ { "versionName": "1.7.8", "versionCode": 11, ... } ] }
//   2. A legacy VERSION file (one-line text) at the repo root - kept for
//      backwards compatibility with installs that pre-date the metadata file.
//   3. Fallback: '0.0.0' - chosen so that the safety check below NEVER flags
//      an update when the metadata is unavailable. This prevents the infinite
//      update loop bug where a device on "1.7.8" would see latest="1.0.0",
//      detect a mismatch, "update" to the same APK, reboot, repeat.
app.get('/api/update/check', (req, res) => {
  const currentVersion = (req.query.version || '').toString().trim();
  const apkPath = path.join(__dirname, '..', 'ScreenTinker.apk');
  const apkExists = fs.existsSync(apkPath);
  const apkSize = apkExists ? fs.statSync(apkPath).size : 0;
  const apkModified = apkExists ? fs.statSync(apkPath).mtimeMs : 0;

  let latestVersion = '0.0.0';
  let latestVersionCode = 0;
  let source = 'fallback';

  // Priority 1: APK metadata JSON (canonical).
  try {
    const metaPath = path.join(__dirname, '..', 'ScreenTinker.apk.json');
    if (fs.existsSync(metaPath)) {
      const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
      const element = Array.isArray(meta.elements) ? meta.elements[0] : null;
      if (element && typeof element.versionName === 'string' && element.versionName.length > 0) {
        latestVersion = element.versionName.trim();
        if (typeof element.versionCode === 'number') latestVersionCode = element.versionCode;
        source = 'apk-metadata';
      }
    }
  } catch (e) {
    console.warn('[update-check] failed to parse ScreenTinker.apk.json:', e.message);
  }

  // Priority 2: legacy VERSION file.
  if (source === 'fallback') {
    try {
      const versionFile = path.join(__dirname, '..', 'VERSION');
      if (fs.existsSync(versionFile)) {
        const v = fs.readFileSync(versionFile, 'utf8').trim();
        if (v.length > 0) { latestVersion = v; source = 'version-file'; }
      }
    } catch (e) {
      console.warn('[update-check] failed to read VERSION:', e.message);
    }
  }

  // Safety: only flag an update when BOTH versions are real and different.
  // Without this guard a missing/unreadable metadata file would advertise
  // "0.0.0" and every installed device would detect a mismatch with its
  // real version and enter a download/reinstall loop on every poll.
  const looksLikeRealVersion = (v) => /^\d+\.\d+\.\d+/.test(v);
  const updateAvailable = !!(
    currentVersion &&
    looksLikeRealVersion(currentVersion) &&
    looksLikeRealVersion(latestVersion) &&
    currentVersion !== latestVersion
  );

  res.json({
    latest_version: latestVersion,
    latest_version_code: latestVersionCode,
    current_version: currentVersion || 'unknown',
    update_available: updateAvailable,
    download_url: '/download/apk',
    apk_size: apkSize,
    apk_modified: apkModified,
    source,
  });
});


// (Content file endpoint moved above protected routes)

// (Screenshot route moved above protected routes)

// Serve uploaded content files directly (with CORS for web player canvas capture)
// Long cache for media files — Cloudflare and browsers can cache these aggressively
app.use('/uploads/content', (req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
  res.setHeader('Cache-Control', 'public, max-age=2592000, immutable'); // 30 days
  res.setHeader('X-Content-Type-Options', 'nosniff');
  next();
}, express.static(config.contentDir));

// Setup WebSockets
const setupWebSockets = require('./ws');
const { deviceNs, dashboardNs } = setupWebSockets(io);
app.set('io', io);

// Start heartbeat checker
const { startHeartbeatChecker } = require('./services/heartbeat');
startHeartbeatChecker(io);

// Start command-queue sweep (prunes expired entries for offline devices)
const commandQueue = require('./lib/command-queue');
commandQueue.startSweep();

// Start Phase 2 command-ack sweep (times out unacked requires_ack=1 command
// rows and optionally re-emits retries). The timer is unref()'d so it doesn't
// keep the event loop alive. Safe no-op while every ingested command is
// requires_ack=0 (the current additive default).
const commandModel = require('./lib/command-model');
commandModel.startAckSweep(io);

// Start scheduler
const { startScheduler } = require('./services/scheduler');
startScheduler(io);

// Start alert service
const { startAlertService } = require('./services/alerts');
startAlertService(io);

// Handle provisioning via WebSocket notification
const { db } = require('./db/database');
// Override provision to also notify device via WS
app.post('/api/provision/pair', requireAuth, resolveTenancy, requireWorkspaceWrite, (req, res) => {
  const { pairing_code, name } = req.body;
  if (!pairing_code) return res.status(400).json({ error: 'pairing_code required' });
  // Phase 2.2a: pair into the caller's current workspace. Refusing on no
  // context prevents the regression window where a newly-paired device
  // would have workspace_id NULL and be invisible to workspace-filtered lists.
  if (!req.workspaceId) return res.status(403).json({ error: 'No workspace context. Switch to a workspace before pairing.' });

  const device = db.prepare('SELECT * FROM devices WHERE pairing_code = ?').get(pairing_code);
  if (!device) return res.status(404).json({ error: 'No device found with that pairing code' });

  const deviceName = name || 'Display ' + (db.prepare('SELECT COUNT(*) as count FROM devices WHERE user_id = ?').get(req.user.id).count + 1);
  db.prepare("UPDATE devices SET pairing_code = NULL, name = ?, user_id = ?, workspace_id = ?, status = 'online', updated_at = strftime('%s','now') WHERE id = ?")
    .run(deviceName, req.user.id, req.workspaceId, device.id);

  // Link fingerprint to user
  db.prepare("UPDATE device_fingerprints SET user_id = ?, device_id = ? WHERE device_id = ?")
    .run(req.user.id, device.id, device.id);

  // Notify the device via WebSocket
  deviceNs.to(device.id).emit('device:paired', { device_id: device.id, name: deviceName });

  const updated = db.prepare('SELECT id, name, workspace_id, status FROM devices WHERE id = ?').get(device.id);
  // Phase 2.3: scope to the workspace the device was just claimed into.
  const { workspaceRoom, emitToWorkspace } = require('./lib/socket-rooms');
  emitToWorkspace(dashboardNs, workspaceRoom(updated.workspace_id), 'dashboard:device-added', updated);

  // Security audit trail. Note: pairing_code is intentionally NOT included
  // (it's a secret); the audit writer would redact it anyway by key name.
  try {
    const { audit } = require('./lib/audit');
    const { getClientIp } = require('./services/activity');
    audit({
      actorType: 'user',
      actorId: req.user.id,
      action: 'device.pair',
      targetType: 'device',
      targetId: device.id,
      workspaceId: req.workspaceId,
      sourceIp: getClientIp(req),
      details: { name: deviceName },
    });
  } catch (_) { /* audit best-effort */ }

  res.json(updated);
});

// Serve APK download
const apkPath = path.join(__dirname, '..', 'ScreenTinker.apk');
app.get('/download/apk', (req, res) => {
  if (fs.existsSync(apkPath)) {
    res.setHeader('Content-Type', 'application/vnd.android.package-archive');
    res.setHeader('Content-Disposition', 'attachment; filename="ScreenTinker.apk"');
    res.setHeader('Cache-Control', 'no-cache');
    res.sendFile(apkPath);
  } else {
    res.status(404).send(`<!DOCTYPE html><html><head><title>APK Not Found</title><style>body{font-family:-apple-system,system-ui,sans-serif;display:flex;justify-content:center;align-items:center;min-height:100vh;margin:0;background:#0f172a;color:#e2e8f0}div{text-align:center;max-width:500px;padding:24px}h1{color:#f87171;font-size:24px}code{background:#1e293b;padding:2px 8px;border-radius:4px;font-size:14px}p{line-height:1.6;color:#94a3b8}</style></head><body><div><h1>APK Not Available</h1><p>The Android APK has not been compiled yet. To build it from source:</p><p><code>cd android</code><br><code>./gradlew assembleDebug</code><br><code>cp app/build/outputs/apk/debug/app-debug.apk ../ScreenTinker.apk</code></p><p>See the <a href="/" style="color:#3b82f6">README</a> for full build instructions.</p><p>Alternatively, use the <a href="/player" style="color:#3b82f6">web player</a> in any browser.</p></div></body></html>`);
  }
});

// SPA fallback for app routes. Unmatched /api/ paths return 404 so misrouted
// clients fail fast instead of hanging until Cloudflare's 15s upstream timeout.
app.get('*', (req, res) => {
  if (req.path.startsWith('/api/')) {
    return res.status(404).json({ error: 'Not found' });
  }
  res.sendFile(path.join(config.frontendDir, 'index.html'));
});

// Final error handler (4-arg). Without it, multer's fileFilter rejection and
// LIMIT_FILE_SIZE bubbled to Express's default handler as a 500 text/html page,
// so the dashboard could only show an opaque "server error" for a disallowed or
// oversized upload. Map them to actionable JSON; mirror the tus path's 415.
// Must be registered AFTER all routes so next(err) reaches it.
app.use((err, req, res, next) => {
  if (!err) return next();
  if (res.headersSent) return next(err);
  if (err.name === 'MulterError') {
    const tooBig = err.code === 'LIMIT_FILE_SIZE';
    return res.status(tooBig ? 413 : 400).json({
      error: tooBig ? 'File exceeds the maximum allowed upload size' : `Upload error: ${err.message}`,
    });
  }
  if (/files? are allowed/i.test(err.message || '')) {
    return res.status(415).json({ error: err.message });
  }
  const status = Number.isInteger(err.status) ? err.status : 500;
  if (req.path && req.path.startsWith('/api/')) {
    return res.status(status).json({ error: err.message || 'Server error' });
  }
  console.error('Unhandled error:', err.stack || err);
  return res.status(status).send('Server error');
});

const listenPort = hasSsl ? config.httpsPort : config.port;
const protocol = hasSsl ? 'https' : 'http';

server.listen(listenPort, '0.0.0.0', () => {
  console.log(`
╔══════════════════════════════════════════════════╗
║               Media Control Server               ║
║──────────────────────────────────────────────────║
║  Dashboard: ${protocol}://localhost:${String(listenPort).padEnd(5)}              ║
║  API:       ${protocol}://localhost:${String(listenPort).padEnd(5)}/api          ║
║  SSL:       ${hasSsl ? 'ENABLED ✓' : 'DISABLED (no certs found)'}${hasSsl ? '                       ' : '         '}║
║──────────────────────────────────────────────────║
║  Listening on all interfaces (0.0.0.0)           ║
╚══════════════════════════════════════════════════╝
  `);
  // Self-heal any video that isn't yet a browser-safe MP4 (e.g. a transcode that
  // a previous deploy/restart killed mid-flight). Deferred + single-flight so it
  // never blocks startup or stacks ffmpeg processes. Non-fatal.
  setTimeout(() => {
    try { require('./lib/media-transcode').resumePendingTranscodes(); }
    catch (e) { console.warn('resumePendingTranscodes kick failed:', e && e.message); }
  }, 8000);
});

// If SSL is enabled, also start an HTTP server that redirects to HTTPS
if (hasSsl) {
  const redirectApp = express();
  redirectApp.use((req, res) => {
    const host = req.headers.host?.replace(`:${config.port}`, `:${config.httpsPort}`) || `localhost:${config.httpsPort}`;
    res.redirect(301, `https://${host}${req.url}`);
  });
  http.createServer(redirectApp).listen(config.port, '0.0.0.0', () => {
    console.log(`  HTTP redirect: http://localhost:${config.port} → https://localhost:${config.httpsPort}\n`);
  });
}
