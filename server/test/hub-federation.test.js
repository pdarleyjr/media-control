'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const http = require('node:http');
const Database = require('better-sqlite3');
const jwt = require('jsonwebtoken');

const {
  createHubFederationRouter,
  ensureHubFederationSchema,
} = require('../routes/hub-federation');

const HUB_ISSUER = 'https://www.mbfdhub.com';
const HUB_AUTHORIZE = `${HUB_ISSUER}/auth/media-control/authorize`;
const CALLBACK = 'https://media.mbfdhub.com/api/auth/hub/callback';
const SERVICE_TOKEN = 'dedicated-media-control-service-fixture';
const JWT_SECRET = 'media-control-test-jwt-secret-at-least-32-characters';

function testConfig(overrides = {}) {
  return {
    jwtSecret: JWT_SECRET,
    hubAuth: {
      authorizeUrl: HUB_AUTHORIZE,
      issuer: HUB_ISSUER,
      audience: 'media-control',
      callbackUrl: CALLBACK,
      serviceToken: SERVICE_TOKEN,
      stateTtlSeconds: 300,
      sessionTtlSeconds: 900,
      ...overrides,
    },
  };
}

function testDatabase() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE users (
      id TEXT PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      username TEXT,
      name TEXT NOT NULL DEFAULT '',
      password_hash TEXT,
      auth_provider TEXT NOT NULL DEFAULT 'local',
      provider_id TEXT,
      avatar_url TEXT,
      role TEXT NOT NULL DEFAULT 'user',
      plan_id TEXT DEFAULT 'enterprise',
      email_alerts INTEGER NOT NULL DEFAULT 1,
      last_login INTEGER,
      created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
      updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
    );
    CREATE TABLE activity_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT,
      action TEXT NOT NULL,
      details TEXT,
      ip_address TEXT,
      workspace_id TEXT
    );
  `);
  ensureHubFederationSchema(db);
  return db;
}

function response(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function exchangeClaims(overrides = {}) {
  return {
    issuer: HUB_ISSUER,
    audience: 'media-control',
    subject: 'hub-user:42',
    user_id: 42,
    display_name: 'Canonical Operator',
    role: 'platform_admin',
    email: 'must-not-be-used-for-linking@example.test',
    ...overrides,
  };
}

function listen(app) {
  const server = http.createServer(app);
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function baseUrl(server) {
  const address = server.address();
  return `http://127.0.0.1:${address.port}`;
}

function cookieValue(setCookie, name) {
  const match = String(setCookie || '').match(new RegExp(`(?:^|,\\s*)${name}=([^;]*)`));
  return match?.[1] || '';
}

async function createHarness(t, { config = testConfig(), fetchImpl } = {}) {
  const db = testDatabase();
  const calls = [];
  const exchange = fetchImpl || (async (url, options) => {
    calls.push({ url, options });
    return response(exchangeClaims());
  });
  const app = express();
  app.use(express.json());
  app.use('/api/auth/hub', createHubFederationRouter({
    db,
    config,
    fetchImpl: exchange,
    ensureWorkspace: () => 'workspace-primary',
  }));
  const server = await listen(app);
  t.after(() => {
    server.close();
    db.close();
  });
  return { db, calls, server };
}

async function start(server) {
  return fetch(`${baseUrl(server)}/api/auth/hub/start`, { redirect: 'manual' });
}

async function callback(server, state, stateCookie, code = 'opaque-hub-code') {
  return fetch(`${baseUrl(server)}/api/auth/hub/callback?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`, {
    headers: { Cookie: `mc_hub_state=${stateCookie}` },
    redirect: 'manual',
  });
}

test('start uses only the configured Hub authorize URL, callback, audience, and fresh state', async (t) => {
  const { server } = await createHarness(t);
  const res = await start(server);
  assert.equal(res.status, 302);
  const location = new URL(res.headers.get('location'));
  assert.equal(`${location.origin}${location.pathname}`, HUB_AUTHORIZE);
  assert.equal(location.searchParams.get('client_id'), 'media-control');
  assert.equal(location.searchParams.get('redirect_uri'), CALLBACK);
  assert.match(location.searchParams.get('state'), /^[A-Za-z0-9_-]{43}$/);
  assert.match(res.headers.get('set-cookie'), /mc_hub_state=[^;]+;.*HttpOnly.*SameSite=Lax/i);
});

test('state tamper and replay are rejected before a Hub exchange', async (t) => {
  const { server, calls } = await createHarness(t);
  const started = await start(server);
  const location = new URL(started.headers.get('location'));
  const state = location.searchParams.get('state');
  const stateCookie = cookieValue(started.headers.get('set-cookie'), 'mc_hub_state');

  const tampered = await callback(server, `${state.slice(0, -1)}X`, stateCookie);
  assert.equal(tampered.status, 400);
  assert.equal(calls.length, 0);

  const first = await callback(server, state, stateCookie);
  assert.equal(first.status, 200);
  assert.equal(calls.length, 1);

  const replay = await callback(server, state, stateCookie);
  assert.equal(replay.status, 400);
  assert.equal(calls.length, 1);
});

test('successful exchange uses the dedicated service credential and creates a short local session', async (t) => {
  const { server, calls } = await createHarness(t);
  const started = await start(server);
  const location = new URL(started.headers.get('location'));
  const state = location.searchParams.get('state');
  const stateCookie = cookieValue(started.headers.get('set-cookie'), 'mc_hub_state');
  const completed = await callback(server, state, stateCookie);

  assert.equal(completed.status, 200);
  assert.match(await completed.text(), /\/js\/hub-auth-complete\.js/);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `${HUB_ISSUER}/api/v2/media-control/auth/exchange`);
  assert.equal(calls[0].options.headers.Authorization, `Bearer ${SERVICE_TOKEN}`);
  assert.doesNotMatch(calls[0].options.body, /password|session|cookie/i);

  const token = cookieValue(completed.headers.get('set-cookie'), 'mc_token');
  const decoded = jwt.verify(token, JWT_SECRET, { algorithms: ['HS256'] });
  assert.equal(decoded.auth_source, 'mbfd_hub');
  assert.equal(decoded.canonical_subject, 'hub-user:42');
  assert.equal(decoded.exp - decoded.iat, 900);

  const session = await fetch(`${baseUrl(server)}/api/auth/hub/session`, {
    headers: { Cookie: `mc_token=${token}` },
  });
  assert.equal(session.status, 200);
  const body = await session.json();
  assert.equal(body.token, token);
  assert.equal(body.user.auth_provider, 'mbfd_hub');
  assert.equal(body.user.role, 'platform_admin');
  assert.equal(body.user.password_hash, undefined);
});

test('federated identities are keyed by canonical subject and never matched by email', async (t) => {
  const { db, server } = await createHarness(t);
  db.prepare(`
    INSERT INTO users (id, email, name, password_hash, auth_provider, role)
    VALUES ('legacy-local', ?, 'Legacy local account', 'bcrypt-hash-fixture', 'local', 'platform_admin')
  `).run('must-not-be-used-for-linking@example.test');

  const started = await start(server);
  const location = new URL(started.headers.get('location'));
  const completed = await callback(
    server,
    location.searchParams.get('state'),
    cookieValue(started.headers.get('set-cookie'), 'mc_hub_state'),
  );
  assert.equal(completed.status, 200);

  const users = db.prepare('SELECT id, email, password_hash, auth_provider, provider_id FROM users ORDER BY id').all();
  assert.equal(users.length, 2);
  const federated = users.find((user) => user.auth_provider === 'mbfd_hub');
  assert.ok(federated);
  assert.notEqual(federated.id, 'legacy-local');
  assert.notEqual(federated.email, 'must-not-be-used-for-linking@example.test');
  assert.equal(federated.password_hash, null);
  assert.equal(federated.provider_id, 'hub-user:42');
  const audit = db.prepare("SELECT user_id, details FROM activity_log WHERE action = 'auth:hub_login'").get();
  assert.equal(audit.user_id, federated.id);
  assert.equal(JSON.parse(audit.details).canonical_subject, 'hub-user:42');
});

test('wrong issuer, audience, subject, role, or failed exchange is denied without a session', async (t) => {
  const invalidClaims = [
    exchangeClaims({ issuer: 'https://evil.example' }),
    exchangeClaims({ audience: 'another-app' }),
    exchangeClaims({ subject: 'unexpected-subject' }),
    exchangeClaims({ role: 'user' }),
  ];

  for (const claims of invalidClaims) {
    await t.test(JSON.stringify(claims), async (st) => {
      const { server } = await createHarness(st, { fetchImpl: async () => response(claims) });
      const started = await start(server);
      const location = new URL(started.headers.get('location'));
      const completed = await callback(
        server,
        location.searchParams.get('state'),
        cookieValue(started.headers.get('set-cookie'), 'mc_hub_state'),
      );
      assert.equal(completed.status, 401);
      assert.equal(cookieValue(completed.headers.get('set-cookie'), 'mc_token'), '');
    });
  }

  await t.test('Hub exchange rejection', async (st) => {
    const { server } = await createHarness(st, { fetchImpl: async () => response({ error: 'invalid_authorization_code' }, 401) });
    const started = await start(server);
    const location = new URL(started.headers.get('location'));
    const completed = await callback(
      server,
      location.searchParams.get('state'),
      cookieValue(started.headers.get('set-cookie'), 'mc_hub_state'),
    );
    assert.equal(completed.status, 401);
  });

  await t.test('malformed Hub exchange response', async (st) => {
    const { server } = await createHarness(st, {
      fetchImpl: async () => ({ ok: true, json: async () => { throw new SyntaxError('invalid JSON'); } }),
    });
    const started = await start(server);
    const location = new URL(started.headers.get('location'));
    const completed = await callback(
      server,
      location.searchParams.get('state'),
      cookieValue(started.headers.get('set-cookie'), 'mc_hub_state'),
    );
    assert.equal(completed.status, 502);
    assert.equal(cookieValue(completed.headers.get('set-cookie'), 'mc_token'), '');
  });
});

test('federation fails closed when its service configuration is incomplete', async (t) => {
  const { server } = await createHarness(t, {
    config: testConfig({ serviceToken: '' }),
  });
  const res = await start(server);
  assert.equal(res.status, 503);
});
