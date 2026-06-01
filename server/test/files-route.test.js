// Unit tests for routes/files.js (per-user Nextcloud read rewrite, P6-3).
// fetch is MOCKED via nextcloud-fs internals; no HTTP is sent. Validates that:
//   - GET /health uses req.user.email (never a client header) and returns mode:'per-user'
//   - GET / (list) sends email from JWT and propagates list shape
//   - GET /download streams bytes with Content-Type + Content-Disposition
//   - All three routes survive a NextcloudNotConnectedError (503) and a generic
//     upstream error (502) gracefully
//
// THREE GUARDRAILS checked explicitly:
//   1. Email ALWAYS from req.user.email — never from any client-supplied header
//   2. No player/media-serving path touched (routes tested = health/list/download)
//   3. Presentation sync fire-and-forget is not in scope here (nextcloud-sync tests)

// Pin config BEFORE loading any module that reads process.env.
process.env.NC_USERFS_URL = 'http://userfs.test:8000';
process.env.NC_WRITE_URL = 'http://write.test:8000';
process.env.NC_USERFS_TOKEN = 'read-tok';
process.env.NC_WRITE_TOKEN = 'write-tok';
process.env.ENABLE_NEXTCLOUD_SYNC = 'true';

const { test } = require('node:test');
const assert = require('node:assert/strict');

// ---- fetch mock helpers ----

const realFetch = global.fetch;
let fetchCalls = [];

function mockFetch(handler) {
  fetchCalls = [];
  global.fetch = async (url, opts) => {
    fetchCalls.push({ url, opts, body: opts && opts.body ? JSON.parse(opts.body) : null });
    return handler(url, opts);
  };
}
function jsonResp(status, obj) {
  return { ok: status >= 200 && status < 300, status, json: async () => obj };
}
function binaryResp(status, bytes, contentType) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k) => String(k).toLowerCase() === 'content-type' ? (contentType || 'application/octet-stream') : null },
    arrayBuffer: async () => { const b = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); },
    json: async () => ({}),
  };
}
function restoreReal() { global.fetch = realFetch; }

// ---- minimal Express-like req/res/next helpers for invoking route handlers ----

function makeReq({ query = {}, user = { id: 'u1', email: 'alice@miamibeachfl.gov' }, body = {} } = {}) {
  return { query, user, body, headers: {} };
}

function makeRes() {
  const r = {
    _status: 200,
    _json: null,
    _buf: null,
    _headers: {},
    status(s) { r._status = s; return r; },
    json(o) { r._json = o; return r; },
    send(b) { r._buf = b; return r; },
    setHeader(k, v) { r._headers[k] = v; },
  };
  return r;
}

// Load the router after env/mock setup. We call the route handlers directly
// (not via supertest) to avoid needing Express to be fully wired.
// We extract the handler functions from the router's stack.
function loadRouter() {
  // Clear the require cache so each test group gets a fresh module (env already
  // set before first load so this is safe to call multiple times).
  delete require.cache[require.resolve('../routes/files')];
  delete require.cache[require.resolve('../services/nextcloud-fs')];
  delete require.cache[require.resolve('../config')];
  return require('../routes/files');
}

// Retrieve the handler registered for a given method+path from the router stack.
function getHandler(router, method, routePath) {
  for (const layer of router.stack) {
    if (!layer.route) continue;
    if (
      layer.route.path === routePath &&
      layer.route.methods[method.toLowerCase()]
    ) {
      // Return the last handler in the stack (the actual handler, not middleware).
      const handlers = layer.route.stack;
      return handlers[handlers.length - 1].handle;
    }
  }
  throw new Error(`No handler found for ${method} ${routePath}`);
}

// ══════════════════════════════════════════════════════════════════════════════
// GET /health
// ══════════════════════════════════════════════════════════════════════════════

test('GET /health returns {enabled:true, connected:true, mode:"per-user"} on success', async () => {
  mockFetch(() => jsonResp(200, { entries: [] }));
  const router = loadRouter();
  const handler = getHandler(router, 'GET', '/health');
  const req = makeReq({ user: { id: 'u1', email: 'alice@miamibeachfl.gov' } });
  const res = makeRes();
  await handler(req, res);
  restoreReal();
  assert.equal(res._status, 200);
  assert.equal(res._json.enabled, true);
  assert.equal(res._json.connected, true);
  assert.equal(res._json.mode, 'per-user');
});

test('GET /health uses req.user.email (NEVER a client header)', async () => {
  // This is GUARDRAIL 1: the email must come from the JWT, not from any header
  // the client could forge.
  mockFetch(() => jsonResp(200, { entries: [] }));
  const router = loadRouter();
  const handler = getHandler(router, 'GET', '/health');
  const req = makeReq({ user: { id: 'u1', email: 'bob@miamibeachfl.gov' } });
  // Attach a spoofed header — the route must ignore it entirely.
  req.headers['x-openweb-ui-user-email'] = 'attacker@evil.com';
  const res = makeRes();
  await handler(req, res);
  restoreReal();
  // The fetch call to nextcloud-user-fs must carry bob's email, not the spoofed one.
  assert.equal(fetchCalls.length, 1);
  assert.equal(
    fetchCalls[0].opts.headers['X-OpenWebUI-User-Email'],
    'bob@miamibeachfl.gov',
    'email must come from JWT, not from a client-supplied header'
  );
});

test('GET /health returns {enabled:true, connected:false, mode:"per-user"} when microservice unreachable', async () => {
  global.fetch = async () => { throw new TypeError('fetch failed'); };
  const router = loadRouter();
  const handler = getHandler(router, 'GET', '/health');
  const req = makeReq();
  const res = makeRes();
  await handler(req, res);
  restoreReal();
  assert.equal(res._json.enabled, true);
  assert.equal(res._json.connected, false);
  assert.equal(res._json.mode, 'per-user');
});

// ══════════════════════════════════════════════════════════════════════════════
// GET / (list directory)
// ══════════════════════════════════════════════════════════════════════════════

test('GET / calls ncfs.listDir with req.user.email and returns normalized list', async () => {
  mockFetch(() => jsonResp(200, {
    entries: [
      { name: 'Docs', path: 'Docs', type: 'directory', size: null, mtime: 1700000000 },
      { name: 'photo.jpg', path: 'photo.jpg', type: 'file', size: 512, mtime: 1700000001 },
    ],
  }));
  const router = loadRouter();
  const handler = getHandler(router, 'GET', '/');
  const req = makeReq({ query: { path: 'My/Folder' }, user: { id: 'u1', email: 'alice@miamibeachfl.gov' } });
  const res = makeRes();
  await handler(req, res);
  restoreReal();
  assert.equal(res._status, 200);
  assert.ok(Array.isArray(res._json));
  assert.equal(res._json.length, 2);
  assert.equal(res._json[0].name, 'Docs');
  assert.equal(res._json[0].is_dir, true);
  assert.equal(res._json[1].name, 'photo.jpg');
  assert.equal(res._json[1].size, 512);
  // Verify the fetch went to the read service with alice's email
  assert.equal(fetchCalls[0].opts.headers['X-OpenWebUI-User-Email'], 'alice@miamibeachfl.gov');
  assert.deepEqual(fetchCalls[0].body, { path: 'My/Folder' });
});

test('GET / with no path defaults to root (empty string)', async () => {
  mockFetch(() => jsonResp(200, { entries: [] }));
  const router = loadRouter();
  const handler = getHandler(router, 'GET', '/');
  const req = makeReq({ query: {}, user: { id: 'u1', email: 'alice@miamibeachfl.gov' } });
  const res = makeRes();
  await handler(req, res);
  restoreReal();
  assert.deepEqual(fetchCalls[0].body, { path: '' });
  assert.deepEqual(res._json, []);
});

test('GET / returns 503 with {connected:false} when microservice unreachable', async () => {
  global.fetch = async () => { throw new TypeError('network error'); };
  const router = loadRouter();
  const handler = getHandler(router, 'GET', '/');
  const req = makeReq();
  const res = makeRes();
  await handler(req, res);
  restoreReal();
  assert.equal(res._status, 503);
  assert.equal(res._json.connected, false);
});

test('GET / returns 502 on an upstream non-2xx error', async () => {
  mockFetch(() => jsonResp(500, { detail: 'internal server error' }));
  const router = loadRouter();
  const handler = getHandler(router, 'GET', '/');
  const req = makeReq();
  const res = makeRes();
  await handler(req, res);
  restoreReal();
  assert.equal(res._status, 502);
  assert.ok(res._json.error);
});

// Integration (per-email scoping): two different JWT users listing the SAME
// query path each produce a read scoped to THEIR OWN email — never each other's.
// The microservice returns a per-user tree; here we assert the email header that
// determines that tree is taken from req.user.email, distinctly, for each user.
test('two members listing the same path read two DIFFERENT email-scoped trees', async () => {
  const trees = {
    'alice@miamibeachfl.gov': [{ name: 'alice.png', path: 'alice.png', type: 'file', size: 1, mtime: 1700000000 }],
    'bob@miamibeachfl.gov': [{ name: 'bob.png', path: 'bob.png', type: 'file', size: 1, mtime: 1700000000 }],
  };
  mockFetch((url, opts) => jsonResp(200, { entries: trees[opts.headers['X-OpenWebUI-User-Email']] || [] }));
  const router = loadRouter();
  const handler = getHandler(router, 'GET', '/');

  const resA = makeRes();
  await handler(makeReq({ query: { path: '' }, user: { id: 'a', email: 'alice@miamibeachfl.gov' } }), resA);
  const aCallEmail = fetchCalls[fetchCalls.length - 1].opts.headers['X-OpenWebUI-User-Email'];

  const resB = makeRes();
  await handler(makeReq({ query: { path: '' }, user: { id: 'b', email: 'bob@miamibeachfl.gov' } }), resB);
  const bCallEmail = fetchCalls[fetchCalls.length - 1].opts.headers['X-OpenWebUI-User-Email'];
  restoreReal();

  assert.equal(aCallEmail, 'alice@miamibeachfl.gov');
  assert.equal(bCallEmail, 'bob@miamibeachfl.gov');
  assert.equal(resA._json[0].name, 'alice.png', 'alice sees ONLY her tree');
  assert.equal(resB._json[0].name, 'bob.png', 'bob sees ONLY his tree');
});

// ══════════════════════════════════════════════════════════════════════════════
// GET /download
// ══════════════════════════════════════════════════════════════════════════════

test('GET /download streams buffer with correct Content-Type and Content-Disposition', async () => {
  mockFetch(() => binaryResp(200, Buffer.from('filedata'), 'image/png'));
  const router = loadRouter();
  const handler = getHandler(router, 'GET', '/download');
  const req = makeReq({ query: { path: 'images/banner.png' }, user: { id: 'u1', email: 'alice@miamibeachfl.gov' } });
  const res = makeRes();
  await handler(req, res);
  restoreReal();
  assert.equal(res._status, 200, 'status should remain 200 for success');
  assert.ok(res._headers['Content-Type'], 'Content-Type must be set');
  assert.ok(res._headers['Content-Disposition'], 'Content-Disposition must be set');
  assert.match(res._headers['Content-Disposition'], /attachment/);
  assert.match(res._headers['Content-Disposition'], /banner\.png/);
  assert.ok(Buffer.isBuffer(res._buf), 'response body must be a Buffer');
  // Verify email from JWT, not from a spoofed source
  assert.equal(fetchCalls[0].opts.headers['X-OpenWebUI-User-Email'], 'alice@miamibeachfl.gov');
});

test('GET /download returns 400 when path is missing', async () => {
  mockFetch(() => { throw new Error('should not call fetch'); });
  const router = loadRouter();
  const handler = getHandler(router, 'GET', '/download');
  const req = makeReq({ query: {}, user: { id: 'u1', email: 'alice@miamibeachfl.gov' } });
  const res = makeRes();
  await handler(req, res);
  restoreReal();
  assert.equal(res._status, 400);
  assert.equal(fetchCalls.length, 0, 'no fetch call when path missing');
});

test('GET /download returns 503 when microservice unreachable', async () => {
  global.fetch = async () => { throw new TypeError('network error'); };
  const router = loadRouter();
  const handler = getHandler(router, 'GET', '/download');
  const req = makeReq({ query: { path: 'file.txt' }, user: { id: 'u1', email: 'alice@miamibeachfl.gov' } });
  const res = makeRes();
  await handler(req, res);
  restoreReal();
  assert.equal(res._status, 503);
  assert.equal(res._json.connected, false);
});

test('GET /download propagates upstream 404 as 404', async () => {
  mockFetch(() => jsonResp(404, { detail: 'not found' }));
  const router = loadRouter();
  const handler = getHandler(router, 'GET', '/download');
  const req = makeReq({ query: { path: 'missing.png' }, user: { id: 'u1', email: 'alice@miamibeachfl.gov' } });
  const res = makeRes();
  await handler(req, res);
  restoreReal();
  assert.equal(res._status, 404);
});
