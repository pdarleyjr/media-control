// Unit tests for services/nextcloud-sync.js (P6-4 transport swap).
//
// The transport (services/nextcloud-fs.js) is exercised for real but its `fetch`
// is MOCKED — so we observe the actual HTTP the swap produces (write service URL,
// email header, base64 body) without contacting any microservice. `db` and the
// `pptx` renderer are stubbed via the require cache so the test is hermetic (no
// SQLite file, no real .pptx render).
//
// THREE GUARDRAILS asserted here:
//   1. The scoping email is the OWNER's users.email (loaded server-side) and is
//      sent verbatim as X-OpenWebUI-User-Email — never a client header.
//   2. This path never touches the player/media-serving routes (sync is push-only
//      to the owner's own NC tree; no display ever fetches from NC).
//   3. syncSoon is fire-and-forget: a write failure (:8005 down) NEVER rejects and
//      NEVER breaks the caller — the job row is recorded as 'error' instead.

// Pin the microservice config BEFORE requiring anything that reads env at load.
process.env.NC_USERFS_URL = 'http://userfs.test:8000';
process.env.NC_WRITE_URL = 'http://write.test:8000';
process.env.NC_USERFS_TOKEN = 'read-token';
process.env.NC_WRITE_TOKEN = 'write-token';
process.env.ENABLE_NEXTCLOUD_SYNC = 'true';

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const realFetch = global.fetch;

// ---- fetch mock (records every microservice call) ----
let fetchCalls = [];
function mockFetch(responder) {
  fetchCalls = [];
  global.fetch = async (url, opts) => {
    fetchCalls.push({ url, opts, body: opts && opts.body ? JSON.parse(opts.body) : null });
    return responder(url, opts);
  };
}
function jsonResp(status, obj) {
  return { ok: status >= 200 && status < 300, status, json: async () => (obj || {}) };
}

// ---- fake db (records prepared SQL + returns canned rows / captures jobs) ----
// A presentation owned by an @miamibeachfl.gov user, with no prior sync job.
function makeDb({ presentation, owner, priorPath = null } = {}) {
  const jobs = []; // captured nextcloud_sync_jobs rows (insert) / updates
  let priorJob = priorPath ? { id: 'job-existing', nextcloud_path: priorPath } : null;
  const db = {
    _jobs: jobs,
    _getPriorJob: () => priorJob,
    prepare(sql) {
      if (/FROM presentations WHERE id = \?/.test(sql)) {
        return { get: () => presentation || null };
      }
      if (/FROM users WHERE id = \?/.test(sql)) {
        return { get: () => owner || null };
      }
      if (/SELECT id FROM nextcloud_sync_jobs WHERE presentation_id = \?/.test(sql)) {
        return { get: () => (priorJob ? { id: priorJob.id } : null) };
      }
      if (/SELECT nextcloud_path FROM nextcloud_sync_jobs WHERE presentation_id = \?/.test(sql)) {
        return { get: () => (priorJob ? { nextcloud_path: priorJob.nextcloud_path } : null) };
      }
      if (/^INSERT INTO nextcloud_sync_jobs/.test(sql)) {
        return { run: (id, ws, uid, pid, ncPath, status, errMsg, syncedAt) => {
          priorJob = { id, nextcloud_path: ncPath };
          jobs.push({ op: 'insert', id, nextcloud_path: ncPath, status, error_msg: errMsg, last_synced_at: syncedAt });
        } };
      }
      if (/^UPDATE nextcloud_sync_jobs SET/.test(sql)) {
        // The set clause + trailing id are passed positionally; we only need to
        // record that an update with a status happened and what path it set.
        return { run: (...args) => {
          const id = args[args.length - 1];
          const fields = {};
          if (/nextcloud_path = \?/.test(sql)) fields.nextcloud_path = args.shift();
          if (/status = \?/.test(sql)) fields.status = args.shift();
          if (/error_msg = \?/.test(sql)) fields.error_msg = args.shift();
          if (/last_synced_at = \?/.test(sql)) fields.last_synced_at = args.shift();
          if (fields.nextcloud_path) priorJob = { id, nextcloud_path: fields.nextcloud_path };
          jobs.push({ op: 'update', id, ...fields });
        } };
      }
      throw new Error('unexpected SQL in test: ' + sql);
    },
  };
  return db;
}

// ---- install module stubs in the require cache, then (re)load the SUT ----
function loadSync({ db, renderImpl } = {}) {
  const dbPath = require.resolve('../db/database');
  // Stub db
  require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: { db } };
  // Stub pptx renderer (resolve the real module id, replace its exports).
  const realPptxPath = require.resolve('../services/pptx');
  require.cache[realPptxPath] = {
    id: realPptxPath, filename: realPptxPath, loaded: true,
    exports: { renderDeckToPptxBuffer: renderImpl || (async () => Buffer.from('PPTX-BYTES')) },
  };
  // Fresh nextcloud-sync (and its ncfs dep keeps the real transport).
  delete require.cache[require.resolve('../services/nextcloud-sync')];
  return require('../services/nextcloud-sync');
}

function cleanup() {
  global.fetch = realFetch;
  delete require.cache[require.resolve('../db/database')];
  delete require.cache[require.resolve('../services/pptx')];
  delete require.cache[require.resolve('../services/nextcloud-sync')];
}

const GOV_OWNER = { email: 'alice@miamibeachfl.gov' };
const PRES = { id: 'p1', workspace_id: 'ws1', user_id: 'u1', title: 'Quarterly Brief', deck_json: '{"slides":[]}' };
const PPTX_MIME = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';

beforeEach(() => { fetchCalls = []; });
afterEach(() => { cleanup(); });

// ── GUARDRAIL 1 + transport swap: write goes to nextcloud-write with owner email ──

test('syncPresentation writes the rendered .pptx to nextcloud-write scoped by the OWNER email', async () => {
  const db = makeDb({ presentation: PRES, owner: GOV_OWNER });
  mockFetch(() => jsonResp(200, { ok: true }));
  const sync = loadSync({ db });

  const result = await sync.syncPresentation('p1');
  assert.equal(result.ok, true);
  assert.equal(result.email, 'alice@miamibeachfl.gov');
  assert.equal(result.path, 'MBFD Media Control/Presentations/Quarterly Brief.pptx');

  // createFolder THEN save_base64_file, both to the WRITE service, both with the
  // owner's email header (NEVER a client-supplied header — there is no req here).
  const writeCalls = fetchCalls.filter((c) => /write\.test:8000/.test(c.url));
  assert.equal(writeCalls.length, 2, 'createFolder + save_base64_file');
  for (const c of writeCalls) {
    assert.equal(c.opts.headers['X-OpenWebUI-User-Email'], 'alice@miamibeachfl.gov');
    assert.equal(c.opts.headers.Authorization, 'Bearer write-token');
  }
  const folderCall = writeCalls.find((c) => /\/create_folder$/.test(c.url));
  assert.deepEqual(folderCall.body, { path: 'MBFD Media Control/Presentations' });

  const saveCall = writeCalls.find((c) => /\/save_base64_file$/.test(c.url));
  assert.equal(saveCall.body.path, 'MBFD Media Control/Presentations/Quarterly Brief.pptx');
  assert.equal(saveCall.body.content_base64, Buffer.from('PPTX-BYTES').toString('base64'));
  assert.equal(saveCall.body.if_exists, 'overwrite');

  // No READ-service call was made — sync is a pure push.
  assert.equal(fetchCalls.filter((c) => /userfs\.test:8000/.test(c.url)).length, 0);
});

test('a successful sync records the job row done with the nextcloud_path + last_synced_at', async () => {
  const db = makeDb({ presentation: PRES, owner: GOV_OWNER });
  mockFetch(() => jsonResp(200, { ok: true }));
  const sync = loadSync({ db });

  await sync.syncPresentation('p1');
  const done = db._jobs.find((j) => j.status === 'done');
  assert.ok(done, 'a done job row was recorded');
  assert.equal(done.nextcloud_path, 'MBFD Media Control/Presentations/Quarterly Brief.pptx');
  assert.equal(typeof done.last_synced_at, 'number');
  assert.equal(done.error_msg, null);
});

// ── stale-title delete: a renamed deck removes the old .pptx first ──

test('a renamed deck deletes the prior .pptx before writing the new one', async () => {
  const db = makeDb({
    presentation: PRES, owner: GOV_OWNER,
    priorPath: 'MBFD Media Control/Presentations/Old Name.pptx',
  });
  mockFetch(() => jsonResp(200, { ok: true }));
  const sync = loadSync({ db });

  await sync.syncPresentation('p1');
  const delCall = fetchCalls.find((c) => /\/delete_file$/.test(c.url));
  assert.ok(delCall, 'delete_file was called for the stale path');
  assert.deepEqual(delCall.body, { path: 'MBFD Media Control/Presentations/Old Name.pptx' });
  assert.equal(delCall.opts.headers['X-OpenWebUI-User-Email'], 'alice@miamibeachfl.gov');
});

test('an unchanged title does NOT delete (prior path equals current path)', async () => {
  const db = makeDb({
    presentation: PRES, owner: GOV_OWNER,
    priorPath: 'MBFD Media Control/Presentations/Quarterly Brief.pptx',
  });
  mockFetch(() => jsonResp(200, { ok: true }));
  const sync = loadSync({ db });

  await sync.syncPresentation('p1');
  assert.equal(fetchCalls.filter((c) => /\/delete_file$/.test(c.url)).length, 0);
});

test('a failed stale-delete is swallowed and the new write still proceeds', async () => {
  const db = makeDb({
    presentation: PRES, owner: GOV_OWNER,
    priorPath: 'MBFD Media Control/Presentations/Old Name.pptx',
  });
  mockFetch((url) => {
    if (/\/delete_file$/.test(url)) return jsonResp(500, { detail: 'boom' });
    return jsonResp(200, { ok: true });
  });
  const sync = loadSync({ db });

  const result = await sync.syncPresentation('p1');
  assert.equal(result.ok, true, 'write succeeds despite the stale-delete failing');
  assert.ok(fetchCalls.find((c) => /\/save_base64_file$/.test(c.url)));
});

// ── skip-guard: non-gov owners have no NC account ──

test('skips silently when the owner is not @miamibeachfl.gov (no fetch)', async () => {
  const db = makeDb({ presentation: PRES, owner: { email: 'someone@gmail.com' } });
  mockFetch(() => { throw new Error('fetch must not run for a non-gov owner'); });
  const sync = loadSync({ db });

  const result = await sync.syncPresentation('p1');
  assert.match(result.skipped, /Nextcloud account/);
  assert.equal(fetchCalls.length, 0);
});

test('skips when the owner row is missing an email', async () => {
  const db = makeDb({ presentation: PRES, owner: { email: null } });
  mockFetch(() => { throw new Error('fetch must not run'); });
  const sync = loadSync({ db });
  const result = await sync.syncPresentation('p1');
  assert.ok(result.skipped);
  assert.equal(fetchCalls.length, 0);
});

// ── GUARDRAIL 3: fire-and-forget never breaks the save ──

test('syncPresentation NEVER rejects when nextcloud-write is down (:8005 unreachable)', async () => {
  const db = makeDb({ presentation: PRES, owner: GOV_OWNER });
  global.fetch = async () => { throw new TypeError('fetch failed'); };
  const sync = loadSync({ db });

  // Resolves to an { error } object — it does not throw.
  const result = await sync.syncPresentation('p1');
  assert.ok(result.error, 'returns an error object, never rejects');
  // The failure is recorded as an error job (best-effort), not surfaced to the caller.
  assert.ok(db._jobs.find((j) => j.status === 'error'), 'error job recorded');
});

test('syncSoon is fire-and-forget: returns synchronously and swallows rejections', async () => {
  const db = makeDb({ presentation: PRES, owner: GOV_OWNER });
  global.fetch = async () => { throw new TypeError('fetch failed'); };
  const sync = loadSync({ db });

  // Must return undefined immediately (no await, no throw).
  assert.equal(sync.syncSoon('p1'), undefined);
  // Let the queued microtask/setImmediate run; it must not produce an unhandled rejection.
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
});

// ── enabled() gating (sharedPassword no longer required) ──

test('enabled() is true with the feature flag + writeUrl, regardless of sharedPassword', () => {
  const db = makeDb({ presentation: PRES, owner: GOV_OWNER });
  const sync = loadSync({ db });
  assert.equal(sync.enabled(), true);
});

// ── disabled feature short-circuits before any DB/fetch work ──

test('a disabled feature flag short-circuits (skipped, no fetch)', async () => {
  // Reload config with the flag off.
  delete require.cache[require.resolve('../config')];
  process.env.ENABLE_NEXTCLOUD_SYNC = 'false';
  const db = makeDb({ presentation: PRES, owner: GOV_OWNER });
  mockFetch(() => { throw new Error('fetch must not run when disabled'); });
  const sync = loadSync({ db });
  const result = await sync.syncPresentation('p1');
  assert.match(result.skipped, /disabled/);
  assert.equal(fetchCalls.length, 0);
  // Restore for any later test files in the same process.
  process.env.ENABLE_NEXTCLOUD_SYNC = 'true';
  delete require.cache[require.resolve('../config')];
});
