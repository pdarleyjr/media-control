'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const tempBase = process.env.KILO_TEMP || path.join(os.tmpdir(), 'kilo');
fs.mkdirSync(tempBase, { recursive: true });
const dbDir = fs.mkdtempSync(path.join(tempBase, 'mc-peertube-worker-db-'));
process.env.DB_PATH = path.join(dbDir, 'test.db');

const { db } = require('../db/database');
const config = require('../config');
const svc = require('../services/peertube-replay');

const originalFetch = global.fetch;
const originalConfig = { ...config.peerTubeReplay };

function response(body, init) {
  return Promise.resolve(new Response(body == null ? '' : JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
    ...init,
  }));
}

function useConfig(overrides = {}) {
  Object.assign(config.peerTubeReplay, originalConfig, {
    enabled: true,
    apiBase: 'https://peertube.example.test',
    apiToken: 'static-test-token',
    apiUsername: '',
    apiPassword: '',
    oauthClientId: '',
    oauthClientSecret: '',
    requestTimeoutMs: 500,
    pollIntervalMs: 1000,
    pollBackoffMaxMs: 4000,
    leaseMs: 10000,
    initialDelayMs: 1,
  }, overrides);
  svc._resetForTests();
}

test.afterEach(() => {
  global.fetch = originalFetch;
  svc._resetForTests();
  Object.assign(config.peerTubeReplay, originalConfig);
  db.prepare('DELETE FROM peertube_replay_worker_leases').run();
  db.prepare('DELETE FROM peertube_replay_worker_status').run();
});

test.after(() => {
  try { svc.stop(); } catch {}
  try { db.close(); } catch {}
  fs.rmSync(dbDir, { recursive: true, force: true });
});

test('database lease allows one owner, supports renewal, and permits takeover only after expiry', () => {
  useConfig();
  assert.equal(svc._acquireLease('owner-a', 1000, 10000), true);
  assert.equal(svc._acquireLease('owner-b', 2000, 10000), false);
  assert.equal(svc._acquireLease('owner-a', 3000, 10000), true);
  assert.equal(svc._acquireLease('owner-b', 12000, 10000), false, 'owner-a renewal extended lease to 13000');
  assert.equal(svc._acquireLease('owner-b', 13001, 10000), true);
});

test('exponential backoff is bounded', () => {
  assert.equal(svc._computeBackoff(0, 1000, 4000), 1000);
  assert.equal(svc._computeBackoff(1000, 1000, 4000), 2000);
  assert.equal(svc._computeBackoff(2000, 1000, 4000), 4000);
  assert.equal(svc._computeBackoff(4000, 1000, 4000), 4000);
});

test('username/password OAuth discovers real client credentials, refreshes once on 401, and retries', async () => {
  useConfig({ apiToken: '', apiUsername: 'operator', apiPassword: 'password' });
  const requests = [];
  let tokenCalls = 0;
  global.fetch = async (url, options = {}) => {
    requests.push({ url: String(url), authorization: new Headers(options.headers || {}).get('Authorization') });
    if (String(url).endsWith('/api/v1/oauth-clients/local')) {
      return response({ client_id: 'actual-client', client_secret: 'actual-secret' });
    }
    if (String(url).endsWith('/api/v1/users/token')) {
      tokenCalls += 1;
      return response({ access_token: tokenCalls === 1 ? 'expired-token' : 'fresh-token', expires_in: 3600 });
    }
    if (requests.filter((entry) => entry.url.endsWith('/api/v1/videos')).length === 1) {
      return new Response('', { status: 401 });
    }
    return response({ data: [] });
  };

  const data = await svc._ptFetch('/api/v1/videos');
  assert.deepEqual(data, { data: [] });
  assert.equal(tokenCalls, 2);
  const apiRequests = requests.filter((entry) => entry.url.endsWith('/api/v1/videos'));
  assert.deepEqual(apiRequests.map((entry) => entry.authorization), ['Bearer expired-token', 'Bearer fresh-token']);
});

test('static token is not blindly retried and API errors never include response bodies or secrets', async () => {
  useConfig({ apiToken: 'top-secret-static-token' });
  let calls = 0;
  global.fetch = async () => {
    calls += 1;
    return new Response('{"access_token":"leaked-response-secret"}', { status: 401 });
  };

  await assert.rejects(
    svc._ptFetch('/api/v1/videos'),
    (caught) => {
      assert.equal(caught.status, 401);
      assert.doesNotMatch(caught.message, /top-secret|leaked-response-secret|access_token/i);
      return true;
    }
  );
  assert.equal(calls, 1);
});

test('request timeout aborts a hung PeerTube request', async () => {
  useConfig({ requestTimeoutMs: 50 });
  global.fetch = (_url, options = {}) => new Promise((_resolve, reject) => {
    options.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true });
  });
  const started = Date.now();
  await assert.rejects(svc._ptFetch('/api/v1/videos'), /aborted/i);
  assert.ok(Date.now() - started < 1000, 'hung request was bounded');
});

test('overlapping ticks are rejected while the active poll retains its lease', async () => {
  useConfig();
  let release;
  global.fetch = () => new Promise((resolve) => { release = () => resolve(new Response('{"data":[]}', { status: 200 })); });

  const active = svc._tick();
  await new Promise((resolve) => setImmediate(resolve));
  const overlap = await svc._tick();
  assert.deepEqual(overlap, { skipped: 'overlap' });
  release();
  assert.deepEqual(await active, { ok: true, discoveredCount: 0, quarantinedCount: 0 });
});

test('stop cancels an in-flight request and leaves safe health telemetry', async () => {
  useConfig();
  global.fetch = (_url, options = {}) => new Promise((_resolve, reject) => {
    options.signal.addEventListener('abort', () => reject(Object.assign(new Error('cancelled'), { name: 'AbortError' })), { once: true });
  });
  const active = svc._tick();
  await new Promise((resolve) => setImmediate(resolve));
  svc.stop();
  assert.deepEqual(await active, { skipped: 'cancelled' });
  const health = svc.getWorkerHealth();
  assert.equal(health.running, false);
  assert.equal(health.scheduled, false);
  assert.doesNotMatch(JSON.stringify(health), /static-test-token|password|authorization/i);
});

