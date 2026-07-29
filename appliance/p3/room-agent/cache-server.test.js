const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const {
  calculateTransferDeadlineMs,
  checksumMatches,
  classifyOrigin,
  createCacheServer,
} = require('./cache-server');

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

test('adaptive transfer deadlines grow with file size and classify private origins', () => {
  assert.equal(calculateTransferDeadlineMs(0), 300_000);
  assert.ok(calculateTransferDeadlineMs(20 * 1024 * 1024 * 1024) > calculateTransferDeadlineMs(1024));
  assert.equal(classifyOrigin('http://192.168.1.116:8096'), 'lan');
  assert.equal(classifyOrigin('http://100.81.154.123:8096'), 'tailscale');
  assert.equal(classifyOrigin('https://media.mbfdhub.com'), 'internet');
});

test('five concurrent displays wait for one final-file cache fill instead of stampeding the origin', async () => {
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
      requestBytes(url, { Range: 'bytes=3072-4095' }),
      requestBytes(url, { Range: 'bytes=4096-5119' }),
    ]);
    await fill;

    assert.equal(originRequests, 1);
    assert.equal(originNodeToken, 'classroom-node-token');
    for (const response of responses) {
      assert.equal(response.status, 206);
      assert.equal(response.headers['x-mc-cache'], 'hit');
      assert.equal(response.body.length, 1024);
    }
    const stats = cache.getStats();
    assert.equal(stats.cache_hits, 5);
    assert.equal(stats.cache_misses, 5);
    assert.equal(stats.fill_failures, 0);
    assert.ok(stats.last_successful_fill);
    assert.equal(stats.last_successful_fill.content_id, contentId);
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
    const stats = cache.getStats();
    assert.equal(stats.sync_status, 'ready');
    assert.equal(stats.manifest_count, 2);
    assert.equal(stats.cached_manifest_count, 2);
    assert.equal(stats.missing_manifest_count, 0);
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
    cache = createCacheServer({
      originBaseUrl: `http://127.0.0.1:${originPort}`,
      cacheDir,
      maxRetries: 0,
    });
    const ok = await cache.prewarmPriority({
      content_id: 'bad-video',
      sha256: 'f'.repeat(64),
      size: Buffer.byteLength('origin-bytes'),
    });
    assert.equal(ok, false);
    assert.equal(fs.existsSync(path.join(cacheDir, 'content', 'bad-video')), false);
    assert.equal(cache.getStats().failed, 1);
    assert.equal(cache.getStats().checksum_failures, 1);
    assert.equal(cache.getStats().fill_failures, 1);
    assert.equal(cache.getStats().last_failure_reason, 'sha256_mismatch');
    assert.equal(cache.getStats().manifest_count, 1);
    assert.equal(cache.getStats().cached_manifest_count, 0);
    assert.equal(cache.getStats().missing_manifest_count, 1);
    assert.equal(cache.getStats().sync_status, 'degraded');
  } finally {
    if (cache) await close(cache.server);
    await close(origin);
    fs.rmSync(cacheDir, { recursive: true, force: true });
  }
});

test('a checksum failure is retried and publishes only the verified final generation', async () => {
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mbfd-checksum-retry-'));
  const badBytes = Buffer.from('wrong-final-bytes!');
  const finalBytes = Buffer.from('right-final-bytes!');
  const sha256 = crypto.createHash('sha256').update(finalBytes).digest('hex');
  let requests = 0;
  const origin = http.createServer((req, res) => {
    requests += 1;
    const bytes = requests === 1 ? badBytes : finalBytes;
    res.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': bytes.length });
    res.end(bytes);
  });

  let cache;
  try {
    const originPort = await listen(origin);
    cache = createCacheServer({
      originBaseUrl: `http://127.0.0.1:${originPort}`,
      cacheDir,
      maxRetries: 1,
      retryDelayMs: 1,
    });
    const item = {
      content_id: 'retry-video',
      generation: 7,
      sha256,
      size: finalBytes.length,
    };
    assert.equal(await cache.prewarmPriority(item), true);
    assert.equal(requests, 2);
    assert.equal(fs.readFileSync(path.join(cacheDir, 'content', 'retry-video')).equals(finalBytes), true);
    const meta = JSON.parse(fs.readFileSync(path.join(cacheDir, 'content', 'retry-video.meta'), 'utf8'));
    assert.equal(meta.generation, 7);
    assert.equal(meta.sha256, sha256);
    assert.equal(cache.getStats().checksum_failures, 1);
    assert.equal(cache.getStats().fill_failures, 0);
  } finally {
    if (cache) await close(cache.server);
    await close(origin);
    fs.rmSync(cacheDir, { recursive: true, force: true });
  }
});

test('failed replacement retains the prior cache generation until periodic recovery swaps final bytes', async () => {
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mbfd-cache-generation-'));
  const oldBytes = Buffer.from('old-web-safe-generation');
  const finalBytes = Buffer.from('new-web-safe-generation');
  const oldSha = crypto.createHash('sha256').update(oldBytes).digest('hex');
  const finalSha = crypto.createHash('sha256').update(finalBytes).digest('hex');
  let phase = 'old';
  const origin = http.createServer((req, res) => {
    if (phase === 'offline') {
      res.writeHead(503);
      return res.end('temporarily offline');
    }
    const bytes = phase === 'old' ? oldBytes : finalBytes;
    res.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': bytes.length });
    res.end(bytes);
  });

  let cache;
  try {
    const originPort = await listen(origin);
    cache = createCacheServer({
      originBaseUrl: `http://127.0.0.1:${originPort}`,
      cacheDir,
      maxRetries: 0,
      retryDelayMs: 1,
    });
    const oldItem = {
      content_id: 'generation-video',
      generation: 1,
      sha256: oldSha,
      size: oldBytes.length,
    };
    assert.equal(await cache.prewarmPriority(oldItem), true);

    phase = 'offline';
    const finalItem = {
      content_id: 'generation-video',
      generation: 2,
      sha256: finalSha,
      size: finalBytes.length,
    };
    assert.equal(await cache.prewarmPriority(finalItem), false);
    assert.equal(
      fs.readFileSync(path.join(cacheDir, 'content', 'generation-video')).equals(oldBytes),
      true,
      'the prior verified generation remains until the replacement is verified',
    );

    phase = 'final';
    await cache.prewarmManifest([finalItem]);
    assert.equal(
      fs.readFileSync(path.join(cacheDir, 'content', 'generation-video')).equals(finalBytes),
      true,
    );
    const meta = JSON.parse(fs.readFileSync(path.join(cacheDir, 'content', 'generation-video.meta'), 'utf8'));
    assert.equal(meta.generation, 2);
    assert.equal(meta.sha256, finalSha);

    const cachePort = await listen(cache.server);
    const playback = await requestBytes(`http://127.0.0.1:${cachePort}/content/generation-video/file`, {
      Range: 'bytes=0-2',
    });
    assert.equal(playback.status, 206);
    assert.equal(playback.headers['x-mc-cache'], 'hit');
    assert.equal(playback.body.equals(finalBytes.subarray(0, 3)), true);
  } finally {
    if (cache) await close(cache.server);
    await close(origin);
    fs.rmSync(cacheDir, { recursive: true, force: true });
  }
});

test('authoritative manifest revocation stops serving previously cached bytes', async () => {
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mbfd-cache-revocation-'));
  const bytes = Buffer.from('workspace-visible-before-archive');
  const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
  let archived = false;
  let originRequests = 0;
  const origin = http.createServer((req, res) => {
    originRequests += 1;
    if (archived) {
      res.writeHead(410, { 'Content-Type': 'application/json' });
      return res.end('{"error":"Content is archived"}');
    }
    res.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': bytes.length });
    res.end(bytes);
  });

  let cache;
  try {
    const originPort = await listen(origin);
    cache = createCacheServer({
      originBaseUrl: `http://127.0.0.1:${originPort}`,
      cacheDir,
      maxRetries: 0,
    });
    const item = {
      content_id: 'archived-video',
      generation: 1,
      sha256,
      size: bytes.length,
    };
    await cache.prewarmManifest([item]);
    assert.equal(originRequests, 1);

    archived = true;
    await cache.prewarmManifest([]);
    const cachePort = await listen(cache.server);
    const response = await requestBytes(
      `http://127.0.0.1:${cachePort}/content/archived-video/file`,
    );

    assert.equal(response.status, 410);
    assert.equal(response.headers['x-mc-cache'], 'miss');
    assert.equal(originRequests, 2);
    assert.notEqual(response.body.toString(), bytes.toString());
    assert.equal(cache.getStats().manifest_count, 0);
  } finally {
    if (cache) await close(cache.server);
    await close(origin);
    fs.rmSync(cacheDir, { recursive: true, force: true });
  }
});

test('manifest generation changes during a fill reconcile to the newest checksum', async () => {
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mbfd-cache-live-generation-'));
  const oldBytes = Buffer.from('generation-one-bytes');
  const newBytes = Buffer.from('generation-two-bytes');
  let requests = 0;
  let releaseFirstRequest;
  const firstRequestStarted = new Promise((resolve) => {
    releaseFirstRequest = resolve;
  });
  const origin = http.createServer((req, res) => {
    requests += 1;
    const bytes = requests === 1 ? oldBytes : newBytes;
    res.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': bytes.length });
    if (requests === 1) {
      releaseFirstRequest();
      setTimeout(() => res.end(bytes), 40);
      return;
    }
    res.end(bytes);
  });

  let cache;
  try {
    const originPort = await listen(origin);
    cache = createCacheServer({
      originBaseUrl: `http://127.0.0.1:${originPort}`,
      cacheDir,
      maxRetries: 0,
    });
    const generationOne = {
      content_id: 'changing-video',
      generation: 1,
      sha256: crypto.createHash('sha256').update(oldBytes).digest('hex'),
      size: oldBytes.length,
    };
    const generationTwo = {
      content_id: 'changing-video',
      generation: 2,
      sha256: crypto.createHash('sha256').update(newBytes).digest('hex'),
      size: newBytes.length,
    };

    const firstSweep = cache.prewarmManifest([generationOne]);
    await firstRequestStarted;
    const updatedSweep = cache.prewarmManifest([generationTwo]);
    await Promise.all([firstSweep, updatedSweep]);

    assert.equal(requests, 2);
    assert.equal(
      fs.readFileSync(path.join(cacheDir, 'content', 'changing-video')).equals(newBytes),
      true,
    );
    const meta = JSON.parse(
      fs.readFileSync(path.join(cacheDir, 'content', 'changing-video.meta'), 'utf8'),
    );
    assert.equal(meta.generation, 2);
    assert.equal(meta.sha256, generationTwo.sha256);
    assert.equal(cache.getStats().missing_manifest_count, 0);
  } finally {
    if (cache) await close(cache.server);
    await close(origin);
    fs.rmSync(cacheDir, { recursive: true, force: true });
  }
});
