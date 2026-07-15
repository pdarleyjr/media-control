// cache-server.js — local read-through content cache for the classroom P3.
//
// Serves GET /content/:id/file to the on-box player windows (loopback only).
//   • cache HIT  → stream bytes from disk with Content-Type + Range support
//   • cache MISS → perform one full, verified origin fill; concurrent player
//                  requests wait for that same fill and then read from disk
//
// This cache-first gate avoids a cold-cache fan-out where every display streams
// the same high-bitrate video across the classroom uplink. If the fill fails,
// the request still falls back to the origin proxy. Node built-ins only (no
// better-sqlite3 / native deps), so Windows install stays dependency-light.
'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const { URL } = require('url');

const ID_RE = /^[A-Za-z0-9._-]{1,128}$/; // content ids are uuids; never allow path separators
const SHA256_RE = /^[0-9a-f]{64}$/i;

function checksumMatches(bytes, expected) {
  if (!SHA256_RE.test(String(expected || ''))) return false;
  return crypto.createHash('sha256').update(bytes).digest('hex') === String(expected).toLowerCase();
}

function pickLib(u) { return u.protocol === 'https:' ? https : http; }

function createCacheServer(opts = {}) {
  const originBaseUrl = String(opts.originBaseUrl || '').replace(/\/+$/, '');
  const cacheDir = opts.cacheDir || (process.platform === 'win32' ? 'C:\\MBFD\\RoomAgent\\cache' : '/opt/mbfd/room-agent/cache');
  const contentDir = path.join(cacheDir, 'content');
  const port = parseInt(opts.port, 10) || 8097;
  const host = opts.host || '127.0.0.1';
  const nodeToken = String(opts.nodeToken || '');
  let originAuthority = '';
  try { originAuthority = new URL(originBaseUrl).origin; } catch (_) { /* invalid origin fails closed */ }
  const log = opts.log || (() => {});
  const warn = opts.warn || (() => {});
  const downloads = new Map(); // content_id -> shared fill Promise
  const manifestById = new Map();
  const pendingManifest = new Map();
  let manifestSweep = null;
  let failureCount = 0;
  let lastFailure = null;

  try { fs.mkdirSync(contentDir, { recursive: true }); } catch (_) { /* ignore */ }

  const fileFor = (id) => path.join(contentDir, id);
  const metaFor = (id) => path.join(contentDir, id + '.meta');

  function readMeta(id) {
    try { return JSON.parse(fs.readFileSync(metaFor(id), 'utf8')); } catch { return null; }
  }

  function cacheEntryMatches(id, expected = null) {
    let st;
    try { st = fs.statSync(fileFor(id)); } catch { return false; }
    if (!st.isFile() || st.size <= 0) return false;
    const meta = readMeta(id);
    if (!meta || meta.checksum_verified !== true || !SHA256_RE.test(String(meta.sha256 || ''))) return false;
    if (Number(meta.size) !== st.size) return false;
    const expectedSha = String(expected && expected.sha256 || '').toLowerCase();
    const expectedSize = Number(expected && (expected.size || expected.size_bytes)) || null;
    if (expectedSha && meta.sha256 !== expectedSha) return false;
    if (expectedSize && st.size !== expectedSize) return false;
    return true;
  }

  function removeCacheEntry(id) {
    try { fs.unlinkSync(fileFor(id)); } catch (_) {}
    try { fs.unlinkSync(metaFor(id)); } catch (_) {}
    try { fs.unlinkSync(fileFor(id) + '.part'); } catch (_) {}
  }

  // The player loads <video crossOrigin="anonymous"> (so screenshots don't taint
  // the canvas), which makes the media request a CORS request. The origin server
  // sends CORS on /api/content; the local cache MUST mirror that or the cross-
  // origin <video> silently fails to load (blank wall) even though curl works.
  function setCors(res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Range, Content-Type');
    res.setHeader('Access-Control-Expose-Headers', 'Content-Range, Accept-Ranges, Content-Length, Content-Type');
  }

  function addOriginNodeAuth(headers, url) {
    if (nodeToken && originAuthority && url.origin === originAuthority) {
      headers['X-MBFD-Node-Token'] = nodeToken;
    }
    return headers;
  }

  // Serve a fully-cached file, honoring a single Range request (video seeking).
  function serveLocal(req, res, id) {
    const file = fileFor(id);
    const meta = readMeta(id) || {};
    let st;
    try { st = fs.statSync(file); } catch { return false; }
    const total = st.size;
    const type = meta.content_type || 'application/octet-stream';
    const range = req.headers.range;
    setCors(res);
    res.setHeader('Content-Type', type);
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Cache-Control', 'public, max-age=2592000, immutable');
    res.setHeader('X-MC-Cache', 'hit');
    if (range) {
      const m = /^bytes=(\d*)-(\d*)$/.exec(range);
      if (m) {
        let start = m[1] === '' ? 0 : parseInt(m[1], 10);
        let end = m[2] === '' ? total - 1 : parseInt(m[2], 10);
        if (Number.isNaN(start) || Number.isNaN(end) || start > end || end >= total) {
          res.writeHead(416, { 'Content-Range': `bytes */${total}` });
          return res.end(), true;
        }
        res.writeHead(206, {
          'Content-Range': `bytes ${start}-${end}/${total}`,
          'Content-Length': end - start + 1,
        });
        if (req.method === 'HEAD') res.end();
        else fs.createReadStream(file, { start, end }).pipe(res);
        return true;
      }
    }
    res.writeHead(200, { 'Content-Length': total });
    if (req.method === 'HEAD') res.end();
    else fs.createReadStream(file).pipe(res);
    return true;
  }

  // Last-resort origin proxy. Normal cache misses do not enter this path until a
  // shared full-file fill has failed, preventing one origin stream per display.
  function proxyOrigin(req, res, id, depth) {
    const originUrl = `${originBaseUrl}/api/content/${encodeURIComponent(id)}/file`;
    let u;
    try { u = new URL(req._redirect || originUrl); } catch { res.writeHead(502); return res.end('bad origin'); }
    const headers = {};
    if (req.headers.range) headers.Range = req.headers.range;
    addOriginNodeAuth(headers, u);
    const lib = pickLib(u);
    const oreq = lib.get(u, { headers, timeout: 60000 }, (ores) => {
      if (ores.statusCode >= 300 && ores.statusCode < 400 && ores.headers.location && (depth || 0) < 3) {
        ores.resume();
        req._redirect = new URL(ores.headers.location, u).toString();
        return proxyOrigin(req, res, id, (depth || 0) + 1);
      }
      const sc = ores.statusCode || 502;
      const passHeaders = { 'X-MC-Cache': 'miss' };
      passHeaders['Access-Control-Allow-Origin'] = '*';
      passHeaders['Access-Control-Expose-Headers'] = 'Content-Range, Accept-Ranges, Content-Length, Content-Type';
      if (ores.headers['content-type']) passHeaders['Content-Type'] = ores.headers['content-type'];
      if (ores.headers['content-length']) passHeaders['Content-Length'] = ores.headers['content-length'];
      if (ores.headers['content-range']) passHeaders['Content-Range'] = ores.headers['content-range'];
      if (ores.headers['accept-ranges']) passHeaders['Accept-Ranges'] = ores.headers['accept-ranges'];
      res.writeHead(sc, passHeaders);
      ores.pipe(res);
    });
    oreq.on('error', (e) => {
      warn('[cache] origin request error:', e && e.message);
      if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'application/json' });
      try { res.end(JSON.stringify({ ok: false, error: 'origin_unreachable' })); } catch (_) {}
    });
    oreq.on('timeout', () => { try { oreq.destroy(new Error('origin timeout')); } catch (_) {} });
  }

  // Pre-warm one content id with a single shared Promise. It also supports a
  // request arriving before the checksum manifest: bytes are hashed locally,
  // then revalidated against the manifest when it arrives.
  function prewarm(id, manifestItem) {
    const normalizedId = String(id || '');
    if (!ID_RE.test(normalizedId)) return Promise.resolve(false);
    if (manifestItem) manifestById.set(normalizedId, manifestItem);
    const expected = manifestItem || manifestById.get(normalizedId) || null;
    if (cacheEntryMatches(normalizedId, expected)) return Promise.resolve(true);
    if (downloads.has(normalizedId)) return downloads.get(normalizedId);
    if (fs.existsSync(fileFor(normalizedId)) || fs.existsSync(metaFor(normalizedId))) removeCacheEntry(normalizedId);

    const expectedSha = String(expected && expected.sha256 || '').toLowerCase();
    const expectedSize = Number(expected && (expected.size || expected.size_bytes)) || null;
    const originUrl = `${originBaseUrl}/api/content/${encodeURIComponent(normalizedId)}/file`;
    let u;
    try { u = new URL(originUrl); } catch { return Promise.resolve(false); }

    const task = new Promise((resolve) => {
      const partPath = fileFor(normalizedId) + '.part';
      const lib = pickLib(u);
      let settled = false;
      const finish = (ok, error) => {
        if (settled) return;
        settled = true;
        downloads.delete(normalizedId);
        if (!ok) {
          try { fs.unlinkSync(partPath); } catch (_) {}
          failureCount += 1;
          lastFailure = { content_id: normalizedId, error: String(error || 'cache_fill_failed'), at: Math.floor(Date.now() / 1000) };
          warn(`[cache] fill failed ${normalizedId}: ${lastFailure.error}`);
        }
        resolve(ok);
      };
      const headers = addOriginNodeAuth({}, u);
      const r = lib.get(u, { headers, timeout: 300000 }, (ores) => {
        if ((ores.statusCode || 0) !== 200) {
          ores.resume();
          return finish(false, `origin_status_${ores.statusCode || 0}`);
        }
        let out;
        try { out = fs.createWriteStream(partPath, { flags: 'w' }); }
        catch (error) { return finish(false, error.message); }
        const hash = crypto.createHash('sha256');
        ores.on('data', (chunk) => hash.update(chunk));
        ores.pipe(out);
        out.on('finish', () => {
          try {
            const actualSha = hash.digest('hex');
            const actualSize = fs.statSync(partPath).size;
            if (SHA256_RE.test(expectedSha) && actualSha !== expectedSha) throw new Error('sha256_mismatch');
            if (expectedSize && actualSize !== expectedSize) throw new Error('size_mismatch');
            fs.renameSync(partPath, fileFor(normalizedId));
            fs.writeFileSync(metaFor(normalizedId), JSON.stringify({
              content_type: ores.headers['content-type'] || 'application/octet-stream',
              size: actualSize,
              sha256: actualSha,
              checksum_verified: true,
              cached_at: Math.floor(Date.now() / 1000),
            }));
            log(`[cache] prewarmed ${normalizedId}`);
            finish(true);
          } catch (error) {
            finish(false, error.message);
          }
        });
        out.on('error', (error) => { try { ores.destroy(); } catch (_) {} finish(false, error.message); });
        ores.on('error', (error) => { try { out.destroy(); } catch (_) {} finish(false, error.message); });
      });
      r.on('error', (error) => finish(false, error.message));
      r.on('timeout', () => { try { r.destroy(new Error('origin_timeout')); } catch (_) {} });
    });
    downloads.set(normalizedId, task);
    return task;
  }

  function startManifestSweep() {
    if (manifestSweep) return manifestSweep;
    manifestSweep = (async () => {
      while (pendingManifest.size > 0) {
        const [id, item] = pendingManifest.entries().next().value;
        pendingManifest.delete(id);
        try { await prewarm(id, item); } catch (_) { /* keep warming the remainder */ }
      }
    })().finally(() => { manifestSweep = null; });
    return manifestSweep;
  }

  function prewarmManifest(items) {
    if (!Array.isArray(items)) return Promise.resolve();
    for (const it of items) {
      const id = it && (it.content_id || it.id);
      if (id) {
        const normalizedId = String(id);
        manifestById.set(normalizedId, it);
        if (!cacheEntryMatches(normalizedId, it) && !downloads.has(normalizedId)) {
          pendingManifest.set(normalizedId, it);
        }
      }
    }
    return startManifestSweep();
  }

  function prewarmPriority(item) {
    const id = item && (item.content_id || item.id);
    if (!id) return Promise.resolve(false);
    const normalizedId = String(id);
    manifestById.set(normalizedId, item);
    pendingManifest.delete(normalizedId);
    return prewarm(normalizedId, item);
  }

  function getStats() {
    let bytes = 0, count = 0;
    try {
      for (const name of fs.readdirSync(contentDir)) {
        if (name.endsWith('.meta') || name.endsWith('.part')) continue;
        try { const st = fs.statSync(path.join(contentDir, name)); if (st.isFile()) { bytes += st.size; count++; } } catch (_) {}
      }
    } catch (_) {}
    return {
      cache_size: bytes,
      file_count: count,
      content_dir: contentDir,
      downloading: downloads.size,
      queued: pendingManifest.size,
      sync_status: downloads.size || pendingManifest.size ? 'syncing' : 'ready',
      failed: lastFailure && (Math.floor(Date.now() / 1000) - lastFailure.at) < 300 ? 1 : 0,
      failure_count: failureCount,
      last_failure: lastFailure,
    };
  }

  function serveAfterCacheFill(req, res, id) {
    prewarm(id, manifestById.get(id)).then((ready) => {
      if (res.destroyed || res.writableEnded) return;
      if (ready && serveLocal(req, res, id)) return;
      proxyOrigin(req, res, id, 0);
    }).catch((error) => {
      warn('[cache] fill gate error:', error && error.message);
      if (!res.destroyed && !res.writableEnded) proxyOrigin(req, res, id, 0);
    });
  }

  const server = http.createServer((req, res) => {
    let u;
    try { u = new URL(req.url, `http://${host}:${port}`); } catch { res.writeHead(400); return res.end(); }
    // CORS preflight (the player uses crossOrigin video/img).
    if (req.method === 'OPTIONS') {
      setCors(res);
      res.writeHead(204);
      return res.end();
    }
    if (u.pathname === '/healthz') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      return res.end(JSON.stringify({ ok: true, ...getStats() }));
    }
    const m = /^\/content\/([^/]+)\/file$/.exec(u.pathname);
    if (m) {
      const id = decodeURIComponent(m[1]);
      if (!ID_RE.test(id)) { res.writeHead(400); return res.end('bad id'); }
      if (cacheEntryMatches(id, manifestById.get(id))) {
        if (serveLocal(req, res, id)) return;
      }
      return serveAfterCacheFill(req, res, id);
    }
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: 'not_found' }));
  });

  function listen() {
    server.listen(port, host, () => log(`[cache] read-through cache on http://${host}:${port} origin=${originBaseUrl} dir=${contentDir}`));
  }
  function close() { try { server.close(); } catch (_) {} }

  return { listen, close, prewarm, prewarmManifest, prewarmPriority, getStats, server };
}

module.exports = { checksumMatches, createCacheServer };
