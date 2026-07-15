const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const { checksumMatches, createCacheServer } = require('./cache-server');

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve(server.address().port);
    });
  });
}

function close(server) {
  return new Promise((resolve) => {
    if (!server.listening) return resolve();
    server.close(resolve);
  });
}

function requestBytes(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { headers }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks),
      }));
    });
    req.on('error', reject);
  });
}

test('checksumMatches validates SHA256 and rejects absent or mismatched digests', () => {
  const bytes = Buffer.from('classroom-cache-asset');
  const expected = crypto.createHash('sha256').update(bytes).digest('hex');
  assert.equal(checksumMatches(bytes, expected), true);
  assert.equal(checksumMatches(bytes, 'b'.repeat(64)), false);
  assert.equal(checksumMatches(bytes, ''), false);
});

test('concurrent cold video ranges wait for one cache fill instead of stampeding the origin', async () => {
  const contentId = 'cold-video';
  const bytes = Buffer.alloc(256 * 1024, 0x5a);
  const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mbfd-read-through-'));
  let originRequests = 0;
  let originNodeToken = null;

  const origin = http.createServer((req, res) => {
    originRequests += 1;
    assert.equal(req.url, `/api/content/${contentId}/file`);
    originNodeToken = req.headers['x-mbfd-node-token'] || null;
    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Accept-Ranges', 'bytes');
    const match = /^bytes=(\d+)-(\d+)$/.exec(String(req.headers.range || ''));
    if (match) {
      const start = Number(match[1]);
      const end = Number(match[2]);
      const slice = bytes.subarray(start, end + 1);
      res.writeHead(206, {
        'Content-Range': `bytes ${start}-${end}/${bytes.length}`,
        'Content-Length': slice.length,
      });
      return res.end(slice);
    }
    res.writeHead(200, { 'Content-Length': bytes.length });
    setTimeout(() => res.end(bytes), 50);
  });

  let cache;
  try {
    const originPort = await listen(origin);
    cache = createCacheServer({
      originBaseUrl: `http://127.0.0.1:${originPort}`,
      cacheDir,
      nodeToken: 'classroom-node-token',
    });
    const cachePort = await listen(cache.server);
    const item = { content_id: contentId, sha256, size: bytes.length };

    const fill = cache.prewarmManifest([item]);
    await new Promise((resolve) => setTimeout(resolve, 10));
    const url = `http://127.0.0.1:${cachePort}/content/${contentId}/file`;
    const responses = await Promise.all([
      requestBytes(url, { Range: 'bytes=0-1023' }),
      requestBytes(url, { Range: 'bytes=1024-2047' }),
      requestBytes(url, { Range: 'bytes=2048-3071' }),
    ]);
    await fill;

    assert.equal(originRequests, 1);
    assert.equal(originNodeToken, 'classroom-node-token');
    for (const response of responses) {
      assert.equal(response.status, 206);
      assert.equal(response.headers['x-mc-cache'], 'hit');
      assert.equal(response.body.length, 1024);
    }
  } finally {
    if (cache) await close(cache.server);
    await close(origin);
    fs.rmSync(cacheDir, { recursive: true, force: true });
  }
});

test('overlapping manifest refreshes stay serial and download each asset once', async () => {
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mbfd-manifest-queue-'));
  const assets = new Map([
    ['video-a', Buffer.alloc(128 * 1024, 0x41)],
    ['video-b', Buffer.alloc(128 * 1024, 0x42)],
  ]);
  const requestCounts = new Map();
  let activeRequests = 0;
  let maxActiveRequests = 0;
  const origin = http.createServer((req, res) => {
    const match = /^\/api\/content\/([^/]+)\/file$/.exec(req.url);
    const id = match && decodeURIComponent(match[1]);
    const bytes = assets.get(id);
    if (!bytes) {
      res.writeHead(404);
      return res.end();
    }
    requestCounts.set(id, (requestCounts.get(id) || 0) + 1);
    activeRequests += 1;
    maxActiveRequests = Math.max(maxActiveRequests, activeRequests);
    res.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': bytes.length });
    setTimeout(() => {
      activeRequests -= 1;
      res.end(bytes);
    }, 40);
  });

  let cache;
  try {
    const originPort = await listen(origin);
    cache = createCacheServer({ originBaseUrl: `http://127.0.0.1:${originPort}`, cacheDir });
    const manifest = [...assets].map(([contentId, bytes]) => ({
      content_id: contentId,
      sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
      size: bytes.length,
    }));

    const firstSweep = cache.prewarmManifest(manifest);
    await new Promise((resolve) => setTimeout(resolve, 10));
    const overlappingSweeps = [
      cache.prewarmManifest(manifest),
      cache.prewarmManifest(manifest),
    ];
    await Promise.all([firstSweep, ...overlappingSweeps]);

    assert.deepEqual(Object.fromEntries(requestCounts), { 'video-a': 1, 'video-b': 1 });
    assert.equal(maxActiveRequests, 1);
    assert.equal(cache.getStats().sync_status, 'ready');
  } finally {
    if (cache) await close(cache.server);
    await close(origin);
    fs.rmSync(cacheDir, { recursive: true, force: true });
  }
});

test('node token is never forwarded to a cross-origin redirect', async () => {
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mbfd-cache-redirect-'));
  let redirectedToken = 'not-requested';
  const redirected = http.createServer((req, res) => {
    redirectedToken = req.headers['x-mbfd-node-token'] || null;
    res.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': 2 });
    res.end('ok');
  });
  const origin = http.createServer((req, res) => {
    assert.equal(req.headers['x-mbfd-node-token'], 'classroom-node-token');
    res.writeHead(302, { Location: `http://127.0.0.1:${redirected.address().port}/asset` });
    res.end();
  });

  let cache;
  try {
    await listen(redirected);
    const originPort = await listen(origin);
    cache = createCacheServer({
      originBaseUrl: `http://127.0.0.1:${originPort}`,
      nodeToken: 'classroom-node-token',
      cacheDir,
    });
    const cachePort = await listen(cache.server);
    const response = await requestBytes(`http://127.0.0.1:${cachePort}/content/redirected-video/file`);

    assert.equal(response.status, 200);
    assert.equal(response.body.toString(), 'ok');
    assert.equal(redirectedToken, null);
  } finally {
    if (cache) await close(cache.server);
    await close(origin);
    await close(redirected);
    fs.rmSync(cacheDir, { recursive: true, force: true });
  }
});

test('a checksum mismatch fails the fill and never publishes corrupt cache bytes', async () => {
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mbfd-bad-cache-'));
  const origin = http.createServer((req, res) => {
    const bytes = Buffer.from('origin-bytes');
    res.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': bytes.length });
    res.end(bytes);
  });
  let cache;
  try {
    const originPort = await listen(origin);
    cache = createCacheServer({ originBaseUrl: `http://127.0.0.1:${originPort}`, cacheDir });
    const ok = await cache.prewarmPriority({
      content_id: 'bad-video',
      sha256: 'f'.repeat(64),
      size: Buffer.byteLength('origin-bytes'),
    });
    assert.equal(ok, false);
    assert.equal(fs.existsSync(path.join(cacheDir, 'content', 'bad-video')), false);
    assert.equal(cache.getStats().failed, 1);
  } finally {
    if (cache) await close(cache.server);
    await close(origin);
    fs.rmSync(cacheDir, { recursive: true, force: true });
  }
});
