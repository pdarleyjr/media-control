// Room-agent asset sync worker — pulls a server-pushed manifest of desired
// `node_assets` (sha256-addressed canonical assets), downloads each one to a
// content-addressed local cache with resumable HTTP Range requests, verifies the
// SHA256, and only after verification atomically renames `<sha>.part` → `<sha>`.
// Local sync state lives in a SQLite manifest (`manifests/node-assets.db`) so the
// agent survives restarts and never re-downloads a verified asset. LRU prunes
// the cache to a quota but NEVER deletes a `desired=1` asset.
//
// Used by both the P3 (Windows) and Kamrui (Linux podium) room agents. No
// secrets or server URLs are hard-coded here — `canonical_url` arrives per-asset
// in each manifest payload. Only Node built-ins + `better-sqlite3`.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const http = require('http');
const https = require('https');
const { URL } = require('url');

// Default runtime layout (override with env on-box). Mirrors the cache paths in
// planning/command-center/ASSET_SYNC_ARCHITECTURE.md:
//   P3:    C:\MBFD\RoomAgent\cache\assets   manifests\node-assets.db
//   Linux: /opt/mbfd/room-agent/cache/assets   manifests/node-assets.db
const DEFAULT_CACHE_DIR =
  process.env.MBFD_ROOM_AGENT_CACHE_DIR
  || (process.platform === 'win32' ? 'C:\\MBFD\\RoomAgent' : '/opt/mbfd/room-agent');
const DEFAULT_QUOTA =
  parseQuota(process.env.MBFD_ROOM_AGENT_CACHE_Q) || (60 * 1024 ** 3);

const HEX64 = /^[0-9a-f]{64}$/i;

function parseQuota(raw) {
  if (raw == null) return null;
  if (typeof raw === 'number') return Math.max(0, Math.floor(raw));
  const s = String(raw).trim().toLowerCase();
  if (!s) return null;
  const m = s.match(/^(\d+(?:\.\d+)?)\s*([kmgt]i?b?)$/);
  if (!m) return null;
  const num = parseFloat(m[1]);
  if (!Number.isFinite(num)) return null;
  const factors = {
    k: 1024, kb: 1024, kib: 1024,
    m: 1024 ** 2, mb: 1024 ** 2, mib: 1024 ** 2,
    g: 1024 ** 3, gb: 1024 ** 3, gib: 1024 ** 3,
    t: 1024 ** 4, tb: 1024 ** 4, tib: 1024 ** 4,
  };
  const f = factors[m[2] || 'g'] || factors.g;
  return Math.max(0, Math.floor(num * f));
}

function safeLog(fn) {
  return (...a) => { try { fn(...a); } catch { /* ignore */ } };
}

// Resolve the local better-sqlite3 module. The agent ships its own
// node_modules, but if someone runs from a context without it, fail soft and
// keep the worker usable for pure-download flows (state in-memory only).
function openManifestDb(manifestDir) {
  let db = null;
  try {
    const Database = require('better-sqlite3');
    fs.mkdirSync(manifestDir, { recursive: true });
    db = new Database(path.join(manifestDir, 'node-assets.db'));
    db.pragma('journal_mode = WAL');
    db.exec(`
      CREATE TABLE IF NOT EXISTS node_assets (
        asset_id          TEXT PRIMARY KEY,
        sha256            TEXT,
        canonical_url     TEXT,
        size_bytes        INTEGER,
        local_path        TEXT,
        sync_status       TEXT NOT NULL DEFAULT 'pending',
        checksum_verified INTEGER NOT NULL DEFAULT 0,
        bytes_downloaded  INTEGER NOT NULL DEFAULT 0,
        desired           INTEGER NOT NULL DEFAULT 1,
        last_attempt_at   INTEGER,
        last_success_at   INTEGER,
        error_message     TEXT,
        updated_at        INTEGER NOT NULL DEFAULT (strftime('%s','now'))
      );
    `);
  } catch (e) {
    // Defensive: missing tables / module → degrade to stateless mode. The agent
    // still downloads; heartbeats just report in-memory status.
    safeLog(console.warn)('[sync-worker] manifest db unavailable, stateless mode:', e && e.message);
    db = null;
  }
  return db;
}

function httpGetStream(urlStr, { rangeStart = 0, timeoutMs = 60000 } = {}) {
  return new Promise((resolve, reject) => {
    let parsed;
    try { parsed = new URL(urlStr); } catch (e) { return reject(new Error('bad canonical_url: ' + e.message)); }
    const lib = parsed.protocol === 'http:' ? http : https;
    const headers = {};
    if (rangeStart > 0) headers.Range = `bytes=${rangeStart}-`;
    const req = lib.get(parsed, { headers, timeout: timeoutMs }, (res) => {
      // 200/206 OK; redirect-chain handled by node for http.get? No — node does
      // not auto-follow. Handle 3xx once.
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return resolve(httpGetStream(new URL(res.headers.location, parsed).toString(), { rangeStart, timeoutMs }));
      }
      if (res.statusCode !== 200 && res.statusCode !== 206) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode} fetching ${urlStr}`));
      }
      // If we requested a Range resume but the origin ignored it (200 full body),
      // the caller must restart from byte 0. Surface that via a flag.
      resolve({
        res,
        ranged: res.statusCode === 206,
        contentRange: res.headers['content-range'] || '',
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(new Error('download timeout')); });
  });
}

function statfsBytes(dirPath) {
  return new Promise((resolve) => {
    if (typeof fs.statfs !== 'function') return resolve(-1);
    fs.statfs(dirPath, (err, st) => {
      if (err) return resolve(-1);
      try { resolve((st.bavail || 0) * (st.bsize || 0)); } catch { resolve(-1); }
    });
  });
}

// Read existing `.part` bytes back through the running hash so a resumed byte
// range still verifies end-to-end. Returns { startByte, stream }.
function preparePart(partPath, hash, startByte) {
  return new Promise((resolve, reject) => {
    if (!startByte) return resolve({ startByte: 0 });
    const rs = fs.createReadStream(partPath);
    rs.on('data', (chunk) => hash.update(chunk));
    rs.on('end', () => resolve({ startByte }));
    rs.on('error', reject);
  });
}

function createSyncWorker(opts = {}) {
  const baseDir = opts.cacheDir || DEFAULT_CACHE_DIR;
  const assetsDir = path.join(baseDir, 'cache', 'assets');
  const manifestDir = path.join(baseDir, 'manifests');
  const logsDir = path.join(baseDir, 'logs');
  const quotaBytes = opts.quotaBytes || DEFAULT_QUOTA;
  const log = opts.log || safeLog(console.log);
  const warn = opts.warn || safeLog(console.warn);

  try { fs.mkdirSync(assetsDir, { recursive: true }); } catch { /* may exist / read-only */ }
  try { fs.mkdirSync(manifestDir, { recursive: true }); } catch { /* ignore */ }
  try { fs.mkdirSync(logsDir, { recursive: true }); } catch { /* ignore */ }

  const db = openManifestDb(manifestDir);

  const stmtUpsert = db && db.prepare(`
    INSERT INTO node_assets (asset_id, sha256, canonical_url, size_bytes, sync_status, bytes_downloaded, desired, last_attempt_at, updated_at)
    VALUES (@asset_id, @sha256, @canonical_url, @size_bytes, @sync_status, @bytes_downloaded, 1, @ts, @ts)
    ON CONFLICT(asset_id) DO UPDATE SET
      sha256=excluded.sha256,
      canonical_url=excluded.canonical_url,
      size_bytes=COALESCE(excluded.size_bytes, node_assets.size_bytes),
      sync_status=excluded.sync_status,
      bytes_downloaded=excluded.bytes_downloaded,
      desired=1,
      last_attempt_at=excluded.last_attempt_at,
      updated_at=excluded.ts
  `);
  const stmtSetStatus = db && db.prepare(`
    UPDATE node_assets SET sync_status=@sync_status, bytes_downloaded=@bytes_downloaded,
      checksum_verified=@checksum_verified, last_success_at=@last_success_at,
      error_message=@error_message, local_path=@local_path, updated_at=@ts
    WHERE asset_id=@asset_id
  `);
  const stmtGet = db && db.prepare('SELECT * FROM node_assets WHERE asset_id = ?');
  const stmtCounts = db && db.prepare(`
    SELECT
      COALESCE(SUM(CASE WHEN sync_status='ready' THEN 1 ELSE 0 END),0) AS ready,
      COALESCE(SUM(CASE WHEN sync_status='pending' THEN 1 ELSE 0 END),0) AS pending,
      COALESCE(SUM(CASE WHEN sync_status='downloading' THEN 1 ELSE 0 END),0) AS downloading,
      COALESCE(SUM(CASE WHEN sync_status='failed' THEN 1 ELSE 0 END),0) AS failed
    FROM node_assets
  `);
  const stmtDesiredSha = db && db.prepare('SELECT sha256 FROM node_assets WHERE desired=1');

  function markStatus(assetId, fields) {
    if (!db || !stmtSetStatus) return;
    try {
      stmtSetStatus.run({
        asset_id: assetId,
        sync_status: fields.sync_status || 'pending',
        bytes_downloaded: fields.bytes_downloaded || 0,
        checksum_verified: fields.checksum_verified ? 1 : 0,
        last_success_at: fields.last_success_at || null,
        error_message: fields.error_message || null,
        local_path: fields.local_path || null,
        ts: Math.floor(Date.now() / 1000),
      });
    } catch (e) { warn('[sync-worker] manifest write failed:', e && e.message); }
  }

  function recordManifest(assetId, sha, canonicalUrl, sizeBytes, status) {
    if (!db || !stmtUpsert) return;
    try {
      stmtUpsert.run({
        asset_id: assetId,
        sha256: (sha || '').toLowerCase(),
        canonical_url: canonicalUrl || null,
        size_bytes: sizeBytes || null,
        sync_status: status || 'pending',
        bytes_downloaded: 0,
        ts: Math.floor(Date.now() / 1000),
      });
    } catch (e) { warn('[sync-worker] manifest upsert failed:', e && e.message); }
  }

  // Download a single asset. Resumable; verifies SHA256; atomic rename on
  // success. On checksum mismatch deletes the .part and retries from scratch up
  // to 3 times with backoff.
  async function downloadAsset({ sha256, canonical_url, size }) {
    const sha = String(sha256 || '').toLowerCase();
    if (!HEX64.test(sha)) return { ok: false, error: 'invalid_sha256', sha256 };
    if (!canonical_url) return { ok: false, error: 'missing_canonical_url', sha256 };
    const finalPath = path.join(assetsDir, sha);
    const partPath = finalPath + '.part';
    recordManifest(sha, sha, canonical_url, size, 'pending');

    // Already have a verified copy?
    try {
      if (fs.existsSync(finalPath)) {
        // Trust presence but still sanity-verify the size if known; cheap.
        if (!size || fs.statSync(finalPath).size === size) {
          markStatus(sha, { sync_status: 'ready', checksum_verified: 1, local_path: finalPath, last_success_at: Math.floor(Date.now() / 1000) });
          return { ok: true, sha256: sha, status: 'ready', skipped: true };
        }
      }
    } catch { /* ignore — fall through to download */ }

    let attempt = 0;
    const maxAttempts = 3;
    while (attempt < maxAttempts) {
      attempt++;
      try {
        markStatus(sha, { sync_status: 'downloading', bytes_downloaded: 0 });
        const hash = crypto.createHash('sha256');

        // Resume from an existing .part if present and sized below target.
        let startByte = 0;
        try {
          if (fs.existsSync(partPath)) {
            const st = fs.statSync(partPath);
            if (size && st.size >= size) {
              // Part already complete; jump straight to verification.
              startByte = st.size;
              const rs = fs.createReadStream(partPath);
              await new Promise((res, rej) => { rs.on('data', c => hash.update(c)); rs.on('end', res); rs.on('error', rej); });
            } else if (st.size > 0) {
              await preparePart(partPath, hash, st.size);
              startByte = st.size;
            }
          }
        } catch (e) { warn('[sync-worker] resume prep failed:', e && e.message); }

        if (startByte < (size || Infinity)) {
          const { res, ranged } = await httpGetStream(canonical_url, { rangeStart: startByte });
          // Origin ignored our Range → must restart the hash from byte 0.
          if (startByte > 0 && !ranged) {
            hash.destroy && hash.destroy();
            const fresh = crypto.createHash('sha256');
            startByte = 0;
            const out = fs.createWriteStream(partPath, { flags: 'w' });
            await new Promise((res2, rej2) => {
              res.on('data', c => { fresh.update(c); out.write(c); });
              res.on('end', () => out.end(() => res2({ fresh })));
              res.on('error', rej2);
              out.on('error', rej2);
            });
            await verifyAndFinalize(sha, partPath, finalPath, fresh, size);
            return { ok: true, sha256: sha, status: 'ready', attempt };
          }

          const out = fs.createWriteStream(partPath, { flags: startByte > 0 ? 'a' : 'w' });
          await new Promise((res2, rej2) => {
            res.on('data', c => { hash.update(c); out.write(c); });
            res.on('end', () => out.end(() => res2()));
            res.on('error', rej2);
            out.on('error', rej2);
          });
        } else {
          // part already complete on disk — verify directly.
        }

        await verifyAndFinalize(sha, partPath, finalPath, hash, size);
        markStatus(sha, { sync_status: 'ready', checksum_verified: 1, local_path: finalPath, last_success_at: Math.floor(Date.now() / 1000) });
        return { ok: true, sha256: sha, status: 'ready', attempt };
      } catch (e) {
        warn(`[sync-worker] attempt ${attempt} for ${sha.slice(0, 10)} failed:`, e && e.message);
        try { fs.unlinkSync(partPath); } catch { /* ignore */ }
        if (attempt >= maxAttempts) {
          markStatus(sha, { sync_status: 'failed', error_message: String(e && e.message || 'unknown') });
          return { ok: false, sha256: sha, status: 'failed', error: String(e && e.message), attempt };
        }
        await new Promise(r => setTimeout(r, 1000 * Math.pow(2, attempt - 1))); // 1s, 2s backoff
      }
    }
    return { ok: false, sha256: sha, status: 'failed', error: 'max_attempts' };
  }

  function verifyAndFinalize(sha, partPath, finalPath, hash, size) {
    return new Promise((resolve, reject) => {
      // If the part was never streamed through hash (already-complete part read
      // back above), hash is already up to date. Otherwise it was fed live.
      const digest = hash.digest('hex').toLowerCase();
      if (digest !== sha) return reject(new Error('sha256_mismatch'));
      fs.open(partPath, 'r', (err, fd) => {
        if (err) return reject(err);
        try {
          if (typeof fs.fsyncSync === 'function') { try { fs.fsyncSync(fd); } catch { /* ignore */ } }
        } finally { try { fs.closeSync(fd); } catch { /* ignore */ } }
        if (size) {
          try { if (fs.statSync(partPath).size !== size) return reject(new Error('size_mismatch')); } catch (e) { return reject(e); }
        }
        // Atomic rename (same filesystem under cache dir).
        try { fs.renameSync(partPath, finalPath); } catch (e) { return reject(e); }
        resolve();
      });
    });
  }

  // LRU prune the cache down to quotaBytes. NEVER evicts a desired=1 asset.
  async function pruneCache(quota = quotaBytes) {
    let entries = [];
    try {
      for (const name of fs.readdirSync(assetsDir)) {
        const full = path.join(assetsDir, name);
        try {
          const st = fs.statSync(full);
          if (st.isFile()) entries.push({ name, full, size: st.size, atime: st.atimeMs });
        } catch { /* ignore */ }
      }
    } catch { /* dir missing — nothing to prune */ return { pruned: 0, total: 0, quota }; }

    const desiredSha = new Set();
    try { if (stmtDesiredSha) for (const r of stmtDesiredSha.all()) desiredSha.add(String(r.sha256 || '').toLowerCase()); } catch { /* ignore */ }

    let total = entries.reduce((s, e) => s + e.size, 0);
    if (total <= quota) return { pruned: 0, total, quota };

    // Candidates = non-desired, evict oldest atime first.
    const candidates = entries
      .filter(e => !desiredSha.has(e.name.toLowerCase()))
      .sort((a, b) => a.atime - b.atime);
    let pruned = 0;
    for (const c of candidates) {
      if (total <= quota) break;
      try { fs.unlinkSync(c.full); total -= c.size; pruned++; } catch { /* ignore */ }
    }
    return { pruned, total, quota };
  }

  // Roll-up status for the heartbeat. sync_status: 'error' if any failed,
  // 'sync' if any pending/downloading, else 'idle'.
  function getStatus() {
    let counts = { ready: 0, pending: 0, downloading: 0, failed: 0 };
    try { if (stmtCounts) counts = stmtCounts.get() || counts; } catch { /* ignore */ }
    let cacheSize = 0, fileCount = 0;
    try {
      for (const name of fs.readdirSync(assetsDir)) {
        try { const st = fs.statSync(path.join(assetsDir, name)); if (st.isFile()) { cacheSize += st.size; fileCount++; } } catch { /* ignore */ }
      }
    } catch { /* ignore */ }
    let syncStatus = 'idle';
    if (counts.failed > 0) syncStatus = 'error';
    else if (counts.pending > 0 || counts.downloading > 0) syncStatus = 'sync';
    return {
      sync_status: syncStatus,
      cache_size: cacheSize,
      file_count: fileCount,
      ready: counts.ready,
      pending: counts.pending,
      downloading: counts.downloading,
      failed: counts.failed,
      quota_bytes: quotaBytes,
      assets_dir: assetsDir,
      db_available: !!db,
    };
  }

  function close() { try { db && db.close(); } catch { /* ignore */ } }

  return { downloadAsset, pruneCache, getStatus, close, localAssetResolver };

  // Resolve a sha256 to a cached local path (or '' if not present). Used by the
  // Electron mcmedia:// handler + the P3 player shim to serve local bytes.
  function localAssetResolver(sha256) {
    const sha = String(sha256 || '').toLowerCase();
    if (!HEX64.test(sha)) return '';
    const full = path.join(assetsDir, sha);
    try { return fs.existsSync(full) ? full : ''; } catch { return ''; }
  }
}

// Convenience default instance (configured from env) so the agent can call
// `require('./sync-worker').downloadAsset(...)` directly without a factory.
let _default = null;
function _instance() {
  if (!_default) _default = createSyncWorker({});
  return _default;
}

module.exports = {
  createSyncWorker,
  parseQuota,
  downloadAsset: (a) => _instance().downloadAsset(a),
  pruneCache: (q) => _instance().pruneCache(q),
  getStatus: () => _instance().getStatus(),
  localAssetResolver: (s) => _instance().localAssetResolver(s),
  close: () => _instance().close && _instance().close(),
};