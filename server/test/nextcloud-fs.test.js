// Unit tests for services/nextcloud-fs.js — the per-user Nextcloud raw-FS client.
// fetch is MOCKED; no microservice is contacted. Verifies the trust-boundary
// header wiring (email + bearer), the no-email guard, list normalization, the
// read/write URL split, base64 writes, and error surfacing.

// Pin the service URLs/tokens BEFORE requiring config (it reads env at load).
process.env.NC_USERFS_URL = 'http://userfs.test:8000';
process.env.NC_WRITE_URL = 'http://write.test:8000';
process.env.NC_USERFS_TOKEN = 'read-token';
process.env.NC_WRITE_TOKEN = 'write-token';

const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const ncfs = require('../services/nextcloud-fs');

const realFetch = global.fetch;
let calls = [];

// Install a fetch mock that records every call and returns a queued response.
function mockFetch(responder) {
  calls = [];
  global.fetch = async (url, opts) => {
    calls.push({ url, opts, body: opts && opts.body ? JSON.parse(opts.body) : null });
    return responder(url, opts);
  };
}
function jsonResponse(status, obj) {
  return { ok: status >= 200 && status < 300, status, json: async () => obj };
}
// Binary response for the /read_file_raw endpoint: exposes arrayBuffer() + a
// headers.get('content-type'), plus json() so postRaw's error path can parse a
// detail body on a non-2xx.
function binaryResponse(status, bytes, contentType) {
  const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k) => (String(k).toLowerCase() === 'content-type' ? (contentType || 'application/octet-stream') : null) },
    arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
    json: async () => ({}),
  };
}
afterEach(() => { global.fetch = realFetch; });

// ---- header wiring (the trust boundary) ----

test('listDir sends the per-user email header AND the read bearer token to the read URL', async () => {
  mockFetch(() => jsonResponse(200, { entries: [] }));
  await ncfs.listDir('peterdarley@miamibeachfl.gov', 'Sub/Dir');
  assert.equal(calls.length, 1);
  const c = calls[0];
  assert.match(c.url, /^http:\/\/userfs\.test:8000\/list_directory$/);
  assert.equal(c.opts.headers['X-OpenWebUI-User-Email'], 'peterdarley@miamibeachfl.gov');
  assert.equal(c.opts.headers.Authorization, 'Bearer read-token');
  assert.deepEqual(c.body, { path: 'Sub/Dir' });
});

test('writeBase64 posts to the WRITE url with the write bearer token + email header', async () => {
  mockFetch(() => jsonResponse(200, { ok: true, nextcloud_path: 'a/b.png' }));
  await ncfs.writeBase64('user@miamibeachfl.gov', 'a/b.png', 'QUJD', 'image/png');
  const c = calls[0];
  assert.match(c.url, /^http:\/\/write\.test:8000\/save_base64_file$/);
  assert.equal(c.opts.headers['X-OpenWebUI-User-Email'], 'user@miamibeachfl.gov');
  assert.equal(c.opts.headers.Authorization, 'Bearer write-token');
  assert.equal(c.body.content_base64, 'QUJD');
  assert.equal(c.body.path, 'a/b.png');
  assert.equal(c.body.if_exists, 'overwrite');
});

// ---- no-email guard (mis-wired route must fail loud, not leak) ----

for (const [name, fn] of [
  ['listDir', () => ncfs.listDir('', 'x')],
  ['readFile', () => ncfs.readFile(null, 'x')],
  ['writeBase64', () => ncfs.writeBase64(undefined, 'x', 'QQ==')],
  ['createFolder', () => ncfs.createFolder('', 'x')],
  ['deleteFile', () => ncfs.deleteFile('', 'x')],
  ['moveFile', () => ncfs.moveFile('', 'a', 'b')],
]) {
  test(`${name} throws NextcloudNotConnectedError when email is falsy (no fetch)`, async () => {
    mockFetch(() => { throw new Error('fetch must not be called'); });
    await assert.rejects(fn(), (e) => {
      assert.ok(e instanceof ncfs.NextcloudNotConnectedError);
      assert.equal(e.code, 'NC_NOT_CONNECTED');
      return true;
    });
    assert.equal(calls.length, 0, 'fetch must not run without an email');
  });
}

// ---- list normalization to the frontend file shape ----

test('listDir normalizes type->is_dir and mtime(seconds)->ISO modified, keeping size/path', async () => {
  mockFetch(() => jsonResponse(200, {
    path: '.',
    entries: [
      { name: 'Folder', path: 'Folder', type: 'directory', size: null, mtime: 1700000000 },
      { name: 'photo.jpg', path: 'photo.jpg', type: 'file', size: 2048, mtime: 1700000000.5 },
    ],
  }));
  const list = await ncfs.listDir('user@miamibeachfl.gov', '');
  assert.equal(list.length, 2);
  assert.deepEqual(list[0], {
    name: 'Folder', is_dir: true, size: 0, modified: new Date(1700000000 * 1000).toISOString(), path: 'Folder', mime_type: '',
  });
  assert.equal(list[1].is_dir, false);
  assert.equal(list[1].size, 2048);
  assert.equal(list[1].path, 'photo.jpg');
  assert.match(list[1].modified, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(list[1].mime_type, 'image/jpeg');
});

test('normalizeEntry includes mime_type: image/jpeg for .jpg, video/mp4 for .mp4, empty string for directory', () => {
  const jpg = ncfs.normalizeEntry({ name: 'photo.jpg', path: 'photo.jpg', type: 'file', size: 1024, mtime: 1700000000 });
  assert.equal(jpg.mime_type, 'image/jpeg');

  const mp4 = ncfs.normalizeEntry({ name: 'clip.mp4', path: 'clip.mp4', type: 'file', size: 4096, mtime: 1700000000 });
  assert.equal(mp4.mime_type, 'video/mp4');

  const dir = ncfs.normalizeEntry({ name: 'Photos', path: 'Photos', type: 'directory', size: null, mtime: 1700000000 });
  assert.equal(dir.mime_type, '');
  assert.equal(dir.is_dir, true);
});

test('listDir tolerates a response missing entries', async () => {
  mockFetch(() => jsonResponse(200, { path: '.' }));
  const list = await ncfs.listDir('user@miamibeachfl.gov', '');
  assert.deepEqual(list, []);
});

// ---- readFile shape + mime inference ----

test('readFile streams raw bytes from /read_file_raw with the read bearer + email header', async () => {
  mockFetch(() => binaryResponse(200, Buffer.from('hello'), 'text/markdown'));
  const r = await ncfs.readFile('user@miamibeachfl.gov', 'notes/today.md');
  assert.ok(Buffer.isBuffer(r.buffer));
  assert.equal(r.buffer.toString('utf-8'), 'hello');
  assert.equal(r.name, 'today.md');
  assert.equal(r.mime, 'text/markdown'); // from the service Content-Type
  assert.equal(r.size, 5);
  assert.match(calls[0].url, /\/read_file_raw$/);
  assert.equal(calls[0].opts.headers['X-OpenWebUI-User-Email'], 'user@miamibeachfl.gov');
  assert.equal(calls[0].opts.headers.Authorization, 'Bearer read-token');
});

test('readFile preserves binary bytes intact and falls back to extension mime on octet-stream', async () => {
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
  mockFetch(() => binaryResponse(200, jpeg, 'application/octet-stream'));
  const r = await ncfs.readFile('user@miamibeachfl.gov', 'pics/photo.jpg');
  assert.deepEqual([...r.buffer], [...jpeg]); // not UTF-8 mangled
  assert.equal(r.mime, 'image/jpeg');
  assert.equal(r.size, 6);
});

test('mimeForName falls back to octet-stream for unknown/no extension', () => {
  assert.equal(ncfs.mimeForName('thing.png'), 'image/png');
  assert.equal(ncfs.mimeForName('movie.mp4'), 'video/mp4');
  assert.equal(ncfs.mimeForName('README'), 'application/octet-stream');
  assert.equal(ncfs.mimeForName('weird.zzz'), 'application/octet-stream');
});

// ---- write helpers route to the write service with correct bodies ----

test('createFolder / moveFile / deleteFile hit the write service with expected bodies', async () => {
  mockFetch(() => jsonResponse(200, { ok: true }));
  await ncfs.createFolder('u@miamibeachfl.gov', 'Reports/2026');
  await ncfs.moveFile('u@miamibeachfl.gov', 'a.txt', 'b.txt', true);
  await ncfs.deleteFile('u@miamibeachfl.gov', 'old.txt');
  assert.match(calls[0].url, /\/create_folder$/);
  assert.deepEqual(calls[0].body, { path: 'Reports/2026' });
  assert.match(calls[1].url, /\/move_file$/);
  assert.deepEqual(calls[1].body, { source: 'a.txt', destination: 'b.txt', overwrite: true });
  assert.match(calls[2].url, /\/delete_file$/);
  assert.deepEqual(calls[2].body, { path: 'old.txt' });
  // every call carried the write token + email
  for (const c of calls) {
    assert.equal(c.opts.headers.Authorization, 'Bearer write-token');
    assert.equal(c.opts.headers['X-OpenWebUI-User-Email'], 'u@miamibeachfl.gov');
  }
});

// ---- error surfacing ----

test('non-2xx surfaces a plain Error carrying the upstream .status (e.g. 404)', async () => {
  mockFetch(() => jsonResponse(404, { detail: 'not a file' }));
  await assert.rejects(ncfs.readFile('u@miamibeachfl.gov', 'missing'), (e) => {
    assert.ok(!(e instanceof ncfs.NextcloudNotConnectedError));
    assert.equal(e.status, 404);
    assert.match(e.message, /not a file/);
    return true;
  });
});

test('a network/transport failure becomes NextcloudNotConnectedError', async () => {
  global.fetch = async () => { throw new TypeError('fetch failed'); };
  await assert.rejects(ncfs.listDir('u@miamibeachfl.gov', ''), (e) => {
    assert.ok(e instanceof ncfs.NextcloudNotConnectedError);
    return true;
  });
});

// ---- health resolves, never rejects ----

test('health(email) resolves { connected: true } when the list succeeds', async () => {
  mockFetch(() => jsonResponse(200, { entries: [] }));
  assert.deepEqual(await ncfs.health('u@miamibeachfl.gov'), { connected: true });
});

test('health(email) resolves { connected: false, error } on failure (never throws)', async () => {
  mockFetch(() => jsonResponse(401, { detail: 'unauthorized' }));
  const h = await ncfs.health('u@miamibeachfl.gov');
  assert.equal(h.connected, false);
  assert.match(h.error, /401/);
});

test('health without an email is { connected: false } and does not call fetch', async () => {
  mockFetch(() => { throw new Error('fetch must not be called'); });
  const h = await ncfs.health('');
  assert.equal(h.connected, false);
  assert.equal(calls.length, 0);
});
