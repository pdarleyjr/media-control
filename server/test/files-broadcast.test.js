// Unit tests for POST /api/files/broadcast (routes/files.js, P6-5).
//
// The import path imports ONE of the caller's OWN Nextcloud files into a local
// content row, then broadcasts it via the EXISTING scene-engine push. Here:
//   - `fetch` is MOCKED (the ncfs read service is never contacted for real),
//   - `db`, `scene-engine`, and `activity` are STUBBED via the require cache so
//     no SQLite file / socket / real push is touched,
//   - `fs.writeFileSync`/`mkdirSync` are patched to a no-op so no bytes hit disk.
//
// THREE GUARDRAILS asserted explicitly:
//   1. The per-user email is ALWAYS req.user.email (from the JWT) — a spoofed
//      X-OpenWebUI-User-Email header on the request is IGNORED.
//   2. The push uses the unmodified shared scene-engine path (NOT user-scoped),
//      and a display never fetches from NC — bytes are materialized locally and
//      a content row is inserted, then pushSourceToDevice is called.
//   3. (Out of scope here — presentation→NC sync; covered by nextcloud-sync test.)
//
// Plus: workspace tenancy (foreign device 403 / unknown 404), the all-displays
// 409 CONFIRM_ALL_REQUIRED gate, the image/video-only 415 gate, path-traversal
// clamp (400 / no fetch), and 404 propagation for a foreign/missing NC path.

// Pin the microservice config BEFORE loading any module that reads env at load.
process.env.NC_USERFS_URL = 'http://userfs.test:8000';
process.env.NC_WRITE_URL = 'http://write.test:8000';
process.env.NC_USERFS_TOKEN = 'read-tok';
process.env.NC_WRITE_TOKEN = 'write-tok';
process.env.ENABLE_NEXTCLOUD_SYNC = 'true';

const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');

// ---- fetch mock (records every microservice call) ----
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

// ---- fs patch (never write real bytes during a unit test) ----
const realWrite = fs.writeFileSync;
const realMkdir = fs.mkdirSync;
function patchFs() {
  fs.writeFileSync = () => {};
  fs.mkdirSync = () => {};
}
function restoreFs() { fs.writeFileSync = realWrite; fs.mkdirSync = realMkdir; }

// ---- fake db (records inserts; canned device rows) ----
// devices: a map id -> { id, workspace_id }. total = COUNT in the workspace.
function makeDb({ devices = {}, total = null } = {}) {
  const inserts = [];
  const db = {
    _inserts: inserts,
    prepare(sql) {
      if (/SELECT id, workspace_id FROM devices WHERE id = \?/.test(sql)) {
        return { get: (id) => devices[id] || null };
      }
      if (/SELECT COUNT\(\*\) AS c FROM devices WHERE workspace_id = \?/.test(sql)) {
        return { get: () => ({ c: total == null ? Object.keys(devices).length : total }) };
      }
      if (/^\s*INSERT INTO content/.test(sql)) {
        return { run: (...args) => { inserts.push({ sql, args }); } };
      }
      throw new Error('unexpected SQL in test: ' + sql);
    },
  };
  return db;
}

// ---- fake scene-engine (records each push, returns true/false) ----
function makeSceneEngine({ result = () => true } = {}) {
  const pushes = [];
  return {
    _pushes: pushes,
    pushSourceToDevice: (io, deviceId, source, opts) => {
      pushes.push({ deviceId, source, opts });
      return result(deviceId);
    },
  };
}

// ---- install stubs in the require cache, then (re)load the router ----
function loadRouter({ db, sceneEngine } = {}) {
  const dbPath = require.resolve('../db/database');
  require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: { db } };
  const sePath = require.resolve('../services/scene-engine');
  require.cache[sePath] = { id: sePath, filename: sePath, loaded: true, exports: sceneEngine };
  const actPath = require.resolve('../services/activity');
  require.cache[actPath] = {
    id: actPath, filename: actPath, loaded: true,
    exports: { logActivity: () => {}, getClientIp: () => '127.0.0.1' },
  };
  delete require.cache[require.resolve('../routes/files')];
  delete require.cache[require.resolve('../services/nextcloud-fs')];
  delete require.cache[require.resolve('../config')];
  return require('../routes/files');
}

function getHandler(router, method, routePath) {
  for (const layer of router.stack) {
    if (!layer.route) continue;
    if (layer.route.path === routePath && layer.route.methods[method.toLowerCase()]) {
      const handlers = layer.route.stack;
      return handlers[handlers.length - 1].handle;
    }
  }
  throw new Error(`No handler found for ${method} ${routePath}`);
}

function makeReq({ body = {}, user = { id: 'u1', email: 'alice@miamibeachfl.gov' }, workspaceId = 'ws1', workspaceRole = 'workspace_editor', actingAs = false } = {}) {
  return {
    body, user, workspaceId, workspaceRole, actingAs,
    headers: {},
    app: { get: () => ({ /* fake io */ }) },
  };
}
function makeRes() {
  const r = {
    _status: 200, _json: null, _headers: {},
    status(s) { r._status = s; return r; },
    json(o) { r._json = o; return r; },
    send(b) { r._buf = b; return r; },
    setHeader(k, v) { r._headers[k] = v; },
  };
  return r;
}

afterEach(() => {
  global.fetch = realFetch;
  restoreFs();
  delete require.cache[require.resolve('../db/database')];
  delete require.cache[require.resolve('../services/scene-engine')];
  delete require.cache[require.resolve('../services/activity')];
  delete require.cache[require.resolve('../routes/files')];
  delete require.cache[require.resolve('../services/nextcloud-fs')];
});

const DEVS = { d1: { id: 'd1', workspace_id: 'ws1' }, d2: { id: 'd2', workspace_id: 'ws1' } };

// ══════════════════════════════════════════════════════════════════════════════
// Happy path: import an image → content row inserted → pushed to the device
// ══════════════════════════════════════════════════════════════════════════════

test('imports an image and broadcasts it to the selected display', async () => {
  mockFetch(() => binaryResp(200, Buffer.from([0x89, 0x50, 0x4e, 0x47]), 'image/png'));
  patchFs();
  const db = makeDb({ devices: DEVS, total: 5 });        // total>targets -> no all-gate
  const se = makeSceneEngine();
  const router = loadRouter({ db, sceneEngine: se });
  const handler = getHandler(router, 'POST', '/broadcast');
  const req = makeReq({ body: { path: 'Photos/welcome.png', device_ids: ['d1'], fit_mode: 'contain' } });
  const res = makeRes();
  await handler(req, res);

  assert.equal(res._status, 200);
  assert.equal(res._json.success, true);
  assert.equal(res._json.sent, 1);
  assert.deepEqual(res._json.failed, []);
  assert.ok(res._json.content_id, 'returns the new content id');

  // A content row was inserted, owned by the importer + workspace, marked import/private.
  assert.equal(db._inserts.length, 1);
  const ins = db._inserts[0];
  assert.match(ins.sql, /content_type/);
  assert.match(ins.sql, /'nextcloud_import'/);
  assert.match(ins.sql, /'private'/);
  // args order: id, user_id, workspace_id, filename, filepath, mime, size
  assert.equal(ins.args[0], res._json.content_id);
  assert.equal(ins.args[1], 'u1');           // user_id from JWT
  assert.equal(ins.args[2], 'ws1');          // workspace_id
  assert.equal(ins.args[5], 'image/png');    // mime inferred from extension

  // The push used the shared scene-engine path with the imported content id.
  assert.equal(se._pushes.length, 1);
  assert.equal(se._pushes[0].deviceId, 'd1');
  assert.equal(se._pushes[0].source.content_id, res._json.content_id);
  assert.equal(se._pushes[0].source.fit_mode, 'contain');
  assert.equal(se._pushes[0].opts.workspaceId, 'ws1');
  assert.equal(se._pushes[0].opts.userId, 'u1');
});

// ══════════════════════════════════════════════════════════════════════════════
// GUARDRAIL 1: the email is ALWAYS req.user.email, never a client header
// ══════════════════════════════════════════════════════════════════════════════

test('reads with req.user.email — a spoofed X-OpenWebUI-User-Email header is ignored', async () => {
  mockFetch(() => binaryResp(200, Buffer.from([0x00, 0x00, 0x00, 0x18]), 'video/mp4'));
  patchFs();
  const db = makeDb({ devices: DEVS, total: 5 });
  const router = loadRouter({ db, sceneEngine: makeSceneEngine() });
  const handler = getHandler(router, 'POST', '/broadcast');
  const req = makeReq({ body: { path: 'a/clip.mp4', device_ids: ['d1'] }, user: { id: 'u9', email: 'bob@miamibeachfl.gov' } });
  req.headers['x-openweb-ui-user-email'] = 'attacker@evil.com'; // must be ignored
  const res = makeRes();
  await handler(req, res);

  assert.equal(res._status, 200);
  assert.equal(fetchCalls.length, 1, 'exactly one read call');
  assert.equal(
    fetchCalls[0].opts.headers['X-OpenWebUI-User-Email'],
    'bob@miamibeachfl.gov',
    'email MUST come from the JWT, never from a client-supplied header'
  );
  assert.match(fetchCalls[0].url, /\/read_file_raw$/);
  assert.deepEqual(fetchCalls[0].body, { path: 'a/clip.mp4' });
});

// ══════════════════════════════════════════════════════════════════════════════
// Media-type gate (415) — only image/video may be broadcast as bytes
// ══════════════════════════════════════════════════════════════════════════════

test('rejects a non-image/video file with 415 (no insert, no push)', async () => {
  mockFetch(() => binaryResp(200, Buffer.from('PDF!'), 'application/pdf'));
  patchFs();
  const db = makeDb({ devices: DEVS, total: 5 });
  const se = makeSceneEngine();
  const router = loadRouter({ db, sceneEngine: se });
  const handler = getHandler(router, 'POST', '/broadcast');
  const req = makeReq({ body: { path: 'docs/brief.pdf', device_ids: ['d1'] } });
  const res = makeRes();
  await handler(req, res);

  assert.equal(res._status, 415);
  assert.equal(db._inserts.length, 0, 'no content row for a rejected type');
  assert.equal(se._pushes.length, 0, 'nothing pushed');
});

// ══════════════════════════════════════════════════════════════════════════════
// Tenancy: a device not in the caller's workspace is 403; unknown device 404
// ══════════════════════════════════════════════════════════════════════════════

test('returns 403 for a device in a different workspace (no fetch, no push)', async () => {
  mockFetch(() => { throw new Error('fetch must not run'); });
  patchFs();
  const db = makeDb({ devices: { foreign: { id: 'foreign', workspace_id: 'OTHER' } }, total: 5 });
  const se = makeSceneEngine();
  const router = loadRouter({ db, sceneEngine: se });
  const handler = getHandler(router, 'POST', '/broadcast');
  const req = makeReq({ body: { path: 'ok.png', device_ids: ['foreign'] } });
  const res = makeRes();
  await handler(req, res);

  assert.equal(res._status, 403);
  assert.equal(fetchCalls.length, 0, 'tenancy is enforced BEFORE reading NC');
  assert.equal(se._pushes.length, 0);
});

test('returns 404 for an unknown device id', async () => {
  mockFetch(() => { throw new Error('fetch must not run'); });
  patchFs();
  const db = makeDb({ devices: DEVS, total: 5 });
  const router = loadRouter({ db, sceneEngine: makeSceneEngine() });
  const handler = getHandler(router, 'POST', '/broadcast');
  const req = makeReq({ body: { path: 'ok.png', device_ids: ['nope'] } });
  const res = makeRes();
  await handler(req, res);
  assert.equal(res._status, 404);
});

// ══════════════════════════════════════════════════════════════════════════════
// All-displays gate: targeting every display without confirm_all -> 409
// ══════════════════════════════════════════════════════════════════════════════

test('returns 409 CONFIRM_ALL_REQUIRED when targeting all displays without confirm_all', async () => {
  mockFetch(() => { throw new Error('fetch must not run'); });
  patchFs();
  const db = makeDb({ devices: DEVS, total: 2 });  // 2 targets == 2 total
  const se = makeSceneEngine();
  const router = loadRouter({ db, sceneEngine: se });
  const handler = getHandler(router, 'POST', '/broadcast');
  const req = makeReq({ body: { path: 'ok.png', device_ids: ['d1', 'd2'] } });
  const res = makeRes();
  await handler(req, res);

  assert.equal(res._status, 409);
  assert.equal(res._json.code, 'CONFIRM_ALL_REQUIRED');
  assert.equal(res._json.count, 2);
  assert.equal(fetchCalls.length, 0, 'gate fires BEFORE the NC read');
  assert.equal(se._pushes.length, 0);
});

test('proceeds when targeting all displays WITH confirm_all:true', async () => {
  mockFetch(() => binaryResp(200, Buffer.from([0x89, 0x50, 0x4e, 0x47]), 'image/png'));
  patchFs();
  const db = makeDb({ devices: DEVS, total: 2 });
  const se = makeSceneEngine();
  const router = loadRouter({ db, sceneEngine: se });
  const handler = getHandler(router, 'POST', '/broadcast');
  const req = makeReq({ body: { path: 'ok.png', device_ids: ['d1', 'd2'], confirm_all: true } });
  const res = makeRes();
  await handler(req, res);

  assert.equal(res._status, 200);
  assert.equal(res._json.sent, 2);
  assert.equal(se._pushes.length, 2);
});

// ══════════════════════════════════════════════════════════════════════════════
// Path traversal clamp at the trust boundary
// ══════════════════════════════════════════════════════════════════════════════

// Each of these must be rejected at the media-control boundary (400, no NC read):
//   - '..' traversal (unix-style and backslash-style),
//   - absolute paths (unix, windows drive, UNC),
//   - a single '.' segment,
//   - a control character (NUL / CR / LF) that could confuse the downstream
//     service's path handling,
//   - empty / whitespace-only.
for (const bad of [
  '../../etc/passwd', '/etc/passwd', 'a/../../b.png', 'C:/Windows/x.png', '',
  '..\\..\\windows\\x.png', '\\\\server\\share\\x.png', 'a/./b.png', 'a/..',
  'evil .png', 'line\nbreak.png', 'cr\rinject.png', '   ',
]) {
  test(`rejects unsafe path ${JSON.stringify(bad)} with 400 (no fetch)`, async () => {
    mockFetch(() => { throw new Error('fetch must not run for an unsafe path'); });
    patchFs();
    const db = makeDb({ devices: DEVS, total: 5 });
    const router = loadRouter({ db, sceneEngine: makeSceneEngine() });
    const handler = getHandler(router, 'POST', '/broadcast');
    const req = makeReq({ body: { path: bad, device_ids: ['d1'] } });
    const res = makeRes();
    await handler(req, res);
    assert.equal(res._status, 400);
    assert.equal(fetchCalls.length, 0);
  });
}

// Adversarial: a URL-ENCODED traversal string is NOT decoded by the clamp, so it
// passes through as a LITERAL directory name (e.g. '%2e%2e'). This is SAFE: the
// real trust boundary is the per-user email header, and the read microservice
// path-joins '%2e%2e' under the CALLER'S OWN root (a literal folder that does not
// exist) — it cannot escape the tree. We assert the request reached the service
// with the literal path AND the caller's JWT email (not a traversal of the host).
test('a URL-encoded traversal string is passed through LITERALLY and stays email-scoped', async () => {
  mockFetch(() => jsonResp(404, { detail: 'No such file' })); // literal '%2e%2e' dir -> 404
  patchFs();
  const db = makeDb({ devices: DEVS, total: 5 });
  const se = makeSceneEngine();
  const router = loadRouter({ db, sceneEngine: se });
  const handler = getHandler(router, 'POST', '/broadcast');
  const req = makeReq({
    body: { path: '%2e%2e/%2e%2e/secret.png', device_ids: ['d1'] },
    user: { id: 'u1', email: 'alice@miamibeachfl.gov' },
  });
  const res = makeRes();
  await handler(req, res);

  // The clamp let it through (no '..' segment literally present), so a read was
  // attempted — but scoped to alice and as a literal (harmless) path -> 404.
  assert.equal(fetchCalls.length, 1);
  assert.equal(fetchCalls[0].opts.headers['X-OpenWebUI-User-Email'], 'alice@miamibeachfl.gov');
  assert.deepEqual(fetchCalls[0].body, { path: '%2e%2e/%2e%2e/secret.png' });
  assert.equal(res._status, 404, 'literal encoded path resolves to nothing -> safe 404');
  assert.equal(db._inserts.length, 0);
  assert.equal(se._pushes.length, 0);
});

// ══════════════════════════════════════════════════════════════════════════════
// Foreign / missing NC path -> the read microservice 404 propagates as 404
// ══════════════════════════════════════════════════════════════════════════════

test('propagates a read-service 404 (foreign/missing file) as 404', async () => {
  mockFetch(() => jsonResp(404, { detail: 'not found' }));
  patchFs();
  const db = makeDb({ devices: DEVS, total: 5 });
  const se = makeSceneEngine();
  const router = loadRouter({ db, sceneEngine: se });
  const handler = getHandler(router, 'POST', '/broadcast');
  const req = makeReq({ body: { path: 'someone-elses/secret.png', device_ids: ['d1'] } });
  const res = makeRes();
  await handler(req, res);

  assert.equal(res._status, 404);
  assert.equal(db._inserts.length, 0, 'no content row when the read fails');
  assert.equal(se._pushes.length, 0);
});

// ══════════════════════════════════════════════════════════════════════════════
// Read-only members are denied
// ══════════════════════════════════════════════════════════════════════════════

test('denies a workspace_viewer with 403', async () => {
  mockFetch(() => { throw new Error('fetch must not run'); });
  patchFs();
  const db = makeDb({ devices: DEVS, total: 5 });
  const router = loadRouter({ db, sceneEngine: makeSceneEngine() });
  const handler = getHandler(router, 'POST', '/broadcast');
  const req = makeReq({ body: { path: 'ok.png', device_ids: ['d1'] }, workspaceRole: 'workspace_viewer', actingAs: false });
  const res = makeRes();
  await handler(req, res);
  assert.equal(res._status, 403);
});

// ══════════════════════════════════════════════════════════════════════════════
// Validation: device_ids must be a non-empty array
// ══════════════════════════════════════════════════════════════════════════════

test('returns 400 when device_ids is empty', async () => {
  mockFetch(() => { throw new Error('fetch must not run'); });
  patchFs();
  const db = makeDb({ devices: DEVS, total: 5 });
  const router = loadRouter({ db, sceneEngine: makeSceneEngine() });
  const handler = getHandler(router, 'POST', '/broadcast');
  const req = makeReq({ body: { path: 'ok.png', device_ids: [] } });
  const res = makeRes();
  await handler(req, res);
  assert.equal(res._status, 400);
});
