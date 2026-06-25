// Server-side website screenshot service. Renders any third-party URL with
// headless Chromium and serves it as a JPEG, so sites that set X-Frame-Options
// or CSP frame-ancestors (Google, most SaaS/banking/news front pages) — which a
// direct <iframe> would refuse to render — can still be broadcast to displays,
// video walls, and inside multiview frames/arbitrary rects.
//
// NOTE: This service is ONLY needed for genuinely external third-party websites
// that block iframes. Our own /player/* pages (hls.html, oz.html, grid.html,
// deck, YouTube, cameras, presentations) all iframe directly and never reach
// this code path. site-shot is idle in a classroom that only uses those source
// types.
//
// The public /player/site-shot/:id route (server.js) reads the already-SSRF-
// validated URL from the content row by id and calls renderSiteShot — clients
// never pass a raw URL, so this is NOT an open SSRF proxy.

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const pexecFile = promisify(execFile);
const config = require('../config');

const CHROMIUM_BIN = process.env.CHROMIUM_BIN || '/usr/bin/chromium-browser';
// Set DISABLE_SITESHOT=true to skip all Chromium rendering entirely (safe when
// you never broadcast raw external websites — returns 503 instead of spinning).
const DISABLED = process.env.DISABLE_SITESHOT === 'true';

const MIN_W = 320, MAX_W = 3840, MIN_H = 240, MAX_H = 2160;
const MIN_INTERVAL = 5, MAX_INTERVAL = 600, DEFAULT_INTERVAL = 20;

function clamp(n, lo, hi, dflt) {
  const v = parseInt(n, 10);
  if (!Number.isFinite(v)) return dflt;
  return Math.max(lo, Math.min(hi, v));
}
function clampWidth(n) { return clamp(n, MIN_W, MAX_W, 1600); }
function clampHeight(n) { return clamp(n, MIN_H, MAX_H, 900); }
function clampInterval(n) { return clamp(n, MIN_INTERVAL, MAX_INTERVAL, DEFAULT_INTERVAL); }

// Only ever screenshot an absolute http(s) URL. Root-relative (/player/…) and
// non-http schemes are rejected — our own pages iframe directly, never here.
function isExternalHttpUrl(url) {
  return typeof url === 'string' && /^https?:\/\//i.test(url);
}

function cacheFileName(id, w, h) {
  return `siteshot_${id}_${w}x${h}.jpg`;
}

// Single-flight: collapse concurrent renders of the same output file (several
// displays showing the same site refresh at once) into one Chromium process.
const inflight = new Map();

// Failure backoff: after a render fails, skip retries for FAILURE_COOLDOWN_MS.
// Without this, a non-working Chromium binary causes an instant retry storm —
// each failure takes ~35 s (execFile timeout), multiple callers pile up, and
// the CPU spike kills WebSocket heartbeats → all devices disconnect at once.
const FAILURE_COOLDOWN_MS = 10 * 60 * 1000; // 10 minutes
const failedAt = new Map(); // outPath → timestamp of last failure

// Render `url` to a JPEG at outPath with headless Chromium. Resolves to outPath.
async function renderSiteShot(url, { width = 1600, height = 900, outPath }) {
  if (!isExternalHttpUrl(url)) throw new Error('site-shot: non-http url');
  const tmpPng = `${outPath}.src.png`;
  const args = [
    '--headless', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
    '--disable-software-rasterizer', '--no-first-run', '--no-default-browser-check',
    '--hide-scrollbars', '--force-device-scale-factor=1', '--mute-audio',
    `--window-size=${width},${height}`,
    '--virtual-time-budget=12000', // let the page settle (JS/render) up to 12s
    `--screenshot=${tmpPng}`,
    url,
  ];
  await pexecFile(CHROMIUM_BIN, args, { timeout: 35000, maxBuffer: 8 * 1024 * 1024 });
  if (!fs.existsSync(tmpPng)) throw new Error('chromium produced no screenshot');
  try {
    const sharp = require('sharp');
    await sharp(tmpPng, { limitInputPixels: false, failOn: 'none' }).jpeg({ quality: 80 }).toFile(outPath);
  } finally {
    try { fs.unlinkSync(tmpPng); } catch { /* ignore */ }
  }
  return outPath;
}

// Render with caching + single-flight + failure backoff. Serves the cached JPEG
// when it is younger than `interval` seconds; otherwise re-renders.
// Returns the file path or throws.
async function getSiteShot(id, url, { width, height, interval }) {
  if (DISABLED) throw new Error('site-shot disabled (DISABLE_SITESHOT=true)');
  const w = clampWidth(width), h = clampHeight(height), iv = clampInterval(interval);
  const outPath = path.join(config.contentDir, cacheFileName(id, w, h));

  // Return cached result if fresh enough.
  try {
    const st = fs.statSync(outPath);
    if ((Date.now() - st.mtimeMs) / 1000 < iv) return outPath;
  } catch { /* no cache yet */ }

  // Failure backoff: never retry a recently-failed render. This prevents a broken
  // Chromium binary from hammering the CPU with instant-fail execFile calls.
  const lastFail = failedAt.get(outPath);
  if (lastFail && (Date.now() - lastFail) < FAILURE_COOLDOWN_MS) {
    throw new Error('site-shot in backoff after recent failure — will retry in ' +
      Math.ceil((FAILURE_COOLDOWN_MS - (Date.now() - lastFail)) / 60000) + ' min');
  }

  // Deduplicate concurrent requests for the same URL.
  if (inflight.has(outPath)) return inflight.get(outPath);

  const p = renderSiteShot(url, { width: w, height: h, outPath })
    .then(r => { failedAt.delete(outPath); return r; })
    .catch(e => { failedAt.set(outPath, Date.now()); throw e; })
    .finally(() => inflight.delete(outPath));
  inflight.set(outPath, p);
  return p;
}

module.exports = {
  renderSiteShot,
  getSiteShot,
  isExternalHttpUrl,
  clampWidth, clampHeight, clampInterval,
  cacheFileName,
  CHROMIUM_BIN,
  DISABLED,
};
