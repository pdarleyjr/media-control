// cache-server.js — local read-through content cache for the classroom P3.
//
// Serves GET /content/:id/file to the on-box player windows (loopback only).
//   • cache HIT  → stream bytes from disk with Content-Type + Range support
//   • cache MISS → proxy from the origin server, stream to the client AND tee a
//                  copy to disk so the next request is a local hit
//
// This is a READ-THROUGH proxy: a miss is never an error, so the classroom walls
// keep playing even before the cache is warm. Combined with the player's origin
// fallback (asset_url -> /api/content/:id/file), a dead/incomplete cache can
// never blank a wall. Node built-ins only (no better-sqlite3 / native deps), so
// install on Windows is just `npm i socket.io-client`.
'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const { URL } = require('url');

const ID_RE = /^[A-Za-z0-9._-]{1,128}$/; // content ids are uuids; never allow path separators

function pickLib(u) { return u.protocol === 'https:' ? https : http; }

function createCacheServer(opts = {}) {
  const originBaseUrl = String(opts.originBaseUrl || '').replace(/\/+$/, '');
  const cacheDir = opts.cacheDir || (process.platform === 'win32' ? 'C:\\MBFD\\RoomAgent\\cache' : '/opt/mbfd/room-agent/cache');
  const contentDir = path.join(cacheDir, 'content');
  const port = parseInt(opts.port, 10) || 8097;
  const host = opts.host || '127.0.0.1';
  const log = opts.log || (() => {});
  const warn = opts.warn || (() => {});
  const downloading = new Set(); // content_ids with a tee-write in flight

  try { fs.mkdirSync(contentDir, { recursive: true }); } catch (_) { /* ignore */ }

  const fileFor = (id) => path.join(contentDir, id);
  const metaFor = (id) => path.join(contentDir, id + '.meta');

  function readMeta(id) {
    try { return JSON.parse(fs.readFileSync(metaFor(id), 'utf8')); } catch { return null; }
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
        fs.createReadStream(file, { start, end }).pipe(res);
        return true;
      }
    }
    res.writeHead(200, { 'Content-Length': total });
    fs.createReadStream(file).pipe(res);
    return true;
  }

  // Proxy from origin while a single-flight BACKGROUND fill caches the full file
  // so the NEXT request is a local hit. Critically this also runs for Range
  // requests — videos only ever use Range, so the old "cache only non-range"
  // path never cached them (every play re-streamed from the server => stutter).
  // This request itself is served straight from origin (range-aware passthrough).
  function proxyOrigin(req, res, id, depth) {
    const originUrl = `${originBaseUrl}/api/content/${encodeURIComponent(id)}/file`;
    let u;
    try { u = new URL(req._redirect || originUrl); } catch { res.writeHead(502); return res.end('bad origin'); }
    // Kick off the background full-file cache (single-flight via `downloading`).
    if (!req._redirect && !fs.existsSync(fileFor(id)) && !downloading.has(id)) {
      prewarm(id).catch(() => {});
    }
    const headers = {};
    if (req.headers.range) headers.Range = req.headers.range;
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

  // Pre-warm one content id by issuing an internal cache fill (no client). Used
  // by the manifest handler so existing library content is staged ahead of use.
  function prewarm(id) {
    return new Promise((resolve) => {
      if (!ID_RE.test(String(id || ''))) return resolve(false);
      if (fs.existsSync(fileFor(id)) || downloading.has(id)) return resolve(true);
      downloading.add(id);
      const originUrl = `${originBaseUrl}/api/content/${encodeURIComponent(id)}/file`;
      let u; try { u = new URL(originUrl); } catch { downloading.delete(id); return resolve(false); }
      const partPath = fileFor(id) + '.part';
      const lib = pickLib(u);
      const r = lib.get(u, { timeout: 300000 }, (ores) => {
        if ((ores.statusCode || 0) !== 200) { ores.resume(); downloading.delete(id); return resolve(false); }
        let out; try { out = fs.createWriteStream(partPath, { flags: 'w' }); } catch { downloading.delete(id); return resolve(false); }
        ores.pipe(out);
        out.on('finish', () => {
          try {
            fs.renameSync(partPath, fileFor(id));
            fs.writeFileSync(metaFor(id), JSON.stringify({
              content_type: ores.headers['content-type'] || 'application/octet-stream',
              size: Number(ores.headers['content-length']) || null,
              cached_at: Math.floor(Date.now() / 1000),
            }));
            log(`[cache] prewarmed ${id}`);
          } catch (e) { try { fs.unlinkSync(partPath); } catch (_) {} }
          downloading.delete(id);
          resolve(true);
        });
        ores.on('error', () => { try { out.destroy(); } catch (_) {} try { fs.unlinkSync(partPath); } catch (_) {} downloading.delete(id); resolve(false); });
      });
      r.on('error', () => { downloading.delete(id); resolve(false); });
      r.on('timeout', () => { try { r.destroy(); } catch (_) {} });
    });
  }

  async function prewarmManifest(items) {
    if (!Array.isArray(items)) return;
    for (const it of items) {
      const id = it && (it.content_id || it.id);
      if (id) { try { await prewarm(String(id)); } catch (_) { /* keep going */ } }
    }
  }

  function getStats() {
    let bytes = 0, count = 0;
    try {
      for (const name of fs.readdirSync(contentDir)) {
        if (name.endsWith('.meta') || name.endsWith('.part')) continue;
        try { const st = fs.statSync(path.join(contentDir, name)); if (st.isFile()) { bytes += st.size; count++; } } catch (_) {}
      }
    } catch (_) {}
    return { cache_size: bytes, file_count: count, content_dir: contentDir };
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
      if (fs.existsSync(fileFor(id)) && !downloading.has(id)) {
        if (serveLocal(req, res, id)) return;
      }
      return proxyOrigin(req, res, id, 0);
    }
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: 'not_found' }));
  });

  function listen() {
    server.listen(port, host, () => log(`[cache] read-through cache on http://${host}:${port} origin=${originBaseUrl} dir=${contentDir}`));
  }
  function close() { try { server.close(); } catch (_) {} }

  return { listen, close, prewarm, prewarmManifest, getStats, server };
}

module.exports = { createCacheServer };
