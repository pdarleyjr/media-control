'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const http = require('node:http');
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');

const { createHubFederationRouter, ensureHubFederationSchema } = require('../routes/hub-federation');

const PASSWORD = 'existing-account-password';

function listen(app) {
  const server = http.createServer(app);
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function origin(server) {
  return `http://127.0.0.1:${server.address().port}`;
}

function cookieValue(setCookie, name) {
  const match = String(setCookie || '').match(new RegExp(`(?:^|,\\s*)${name}=([^;]*)`));
  return match?.[1] || '';
}

function createDb() {
  const db = new Database(':memory:');
  db.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE users (
      id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, username TEXT,
      name TEXT NOT NULL DEFAULT '', password_hash TEXT,
      auth_provider TEXT NOT NULL DEFAULT 'local', provider_id TEXT,
      avatar_url TEXT, role TEXT NOT NULL DEFAULT 'user', plan_id TEXT DEFAULT 'enterprise',
      last_login INTEGER, created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
      updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
    );
    CREATE TABLE activity_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT, action TEXT NOT NULL,
      details TEXT, ip_address TEXT, workspace_id TEXT
    );
    CREATE TABLE workspaces (id TEXT PRIMARY KEY, created_by TEXT);
    CREATE TABLE workspace_members (workspace_id TEXT, user_id TEXT, role TEXT);
    CREATE TABLE content (id TEXT PRIMARY KEY, user_id TEXT);
    CREATE TABLE presentations (id TEXT PRIMARY KEY, user_id TEXT, created_by TEXT);
    CREATE TABLE layouts (id TEXT PRIMARY KEY, user_id TEXT);
    CREATE TABLE schedules (id TEXT PRIMARY KEY, user_id TEXT);
  `);
  ensureHubFederationSchema(db);
  return db;
}

function seedUser(db, overrides = {}) {
  const user = {
    id: 'preserved-user', email: 'preserved@miamibeachfl.gov', username: 'preserved',
    name: 'Preserved Profile', role: 'user', password: PASSWORD, ...overrides,
  };
  db.prepare(`INSERT INTO users
    (id, email, username, name, password_hash, auth_provider, role, plan_id)
    VALUES (?, ?, ?, ?, ?, 'local', ?, 'enterprise')`)
    .run(user.id, user.email, user.username, user.name, bcrypt.hashSync(user.password, 4), user.role);
  return user;
}

function seedOwnership(db, userId) {
  db.prepare('INSERT INTO workspaces VALUES (?, ?)').run('primary-workspace', userId);
  db.prepare('INSERT INTO workspace_members VALUES (?, ?, ?)').run('primary-workspace', userId, 'workspace_admin');
  db.prepare('INSERT INTO content VALUES (?, ?)').run('owned-content', userId);
  db.prepare('INSERT INTO presentations VALUES (?, ?, ?)').run('owned-presentation', userId, userId);
  db.prepare('INSERT INTO layouts VALUES (?, ?)').run('owned-layout', userId);
  db.prepare('INSERT INTO schedules VALUES (?, ?)').run('owned-schedule', userId);
}

function ownershipSnapshot(db) {
  return {
    workspaces: db.prepare('SELECT * FROM workspaces ORDER BY id').all(),
    memberships: db.prepare('SELECT * FROM workspace_members ORDER BY workspace_id').all(),
    content: db.prepare('SELECT * FROM content ORDER BY id').all(),
    presentations: db.prepare('SELECT * FROM presentations ORDER BY id').all(),
    layouts: db.prepare('SELECT * FROM layouts ORDER BY id').all(),
    schedules: db.prepare('SELECT * FROM schedules ORDER BY id').all(),
  };
}

async function harness(t, { claims = {}, linkTtlSeconds = 300 } = {}) {
  const db = createDb();
  let ensureWorkspaceCalls = 0;
  const config = {
    jwtSecret: 'link-test-jwt-secret-at-least-32-characters',
    hubAuth: {
      authorizeUrl: 'https://www.mbfdhub.com/auth/media-control/authorize',
      issuer: 'https://www.mbfdhub.com', audience: 'media-control',
      callbackUrl: '', serviceToken: 'service-token', stateTtlSeconds: 300,
      linkTtlSeconds, sessionTtlSeconds: 900,
    },
  };
  const app = express();
  app.use(express.json());
  app.use('/api/auth/hub', createHubFederationRouter({
    db, config,
    fetchImpl: async () => new Response(JSON.stringify({
      issuer: config.hubAuth.issuer, audience: 'media-control', subject: 'hub-user:42',
      user_id: 42, display_name: 'Hub Display Name', role: 'platform_admin', ...claims,
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }),
    ensureWorkspace: () => { ensureWorkspaceCalls += 1; return 'primary-workspace'; },
  }));
  const server = await listen(app);
  config.hubAuth.callbackUrl = `${origin(server)}/api/auth/hub/callback`;
  t.after(() => { server.close(); db.close(); });
  return { db, server, ensureWorkspaceCalls: () => ensureWorkspaceCalls };
}

async function beginLink(server) {
  const started = await fetch(`${origin(server)}/api/auth/hub/start`, { redirect: 'manual' });
  const location = new URL(started.headers.get('location'));
  const state = location.searchParams.get('state');
  const stateCookie = cookieValue(started.headers.get('set-cookie'), 'mc_hub_state');
  const callback = await fetch(`${origin(server)}/api/auth/hub/callback?code=opaque&state=${encodeURIComponent(state)}`, {
    headers: { Cookie: `mc_hub_state=${stateCookie}` }, redirect: 'manual',
  });
  return { callback, linkCookie: cookieValue(callback.headers.get('set-cookie'), 'mc_hub_link') };
}

async function link(server, linkCookie, identifier, password = PASSWORD) {
  return fetch(`${origin(server)}/api/auth/hub/link`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: `mc_hub_link=${linkCookie}` },
    body: JSON.stringify({ identifier, password }), redirect: 'manual',
  });
}

test('unmapped callback creates a browser-bound pending link without a user, workspace, or app session', async (t) => {
  const { db, server, ensureWorkspaceCalls } = await harness(t);
  seedUser(db);
  const { callback, linkCookie } = await beginLink(server);
  assert.equal(callback.status, 200);
  assert.match(await callback.text(), /hub-account-link\.js/);
  assert.match(callback.headers.get('set-cookie'), /mc_hub_link=[^;]+;.*HttpOnly.*SameSite=Strict/i);
  assert.ok(linkCookie);
  assert.equal(cookieValue(callback.headers.get('set-cookie'), 'mc_token'), '');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM users').get().n, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM hub_account_link_transactions').get().n, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM hub_federated_identities').get().n, 0);
  assert.equal(ensureWorkspaceCalls(), 0);
});

for (const role of ['user', 'platform_admin']) {
  test(`link preserves the existing ${role} account and all ownership, then login is idempotent`, async (t) => {
    const { db, server, ensureWorkspaceCalls } = await harness(t);
    const user = seedUser(db, { role });
    seedOwnership(db, user.id);
    const beforeUser = db.prepare('SELECT * FROM users WHERE id = ?').get(user.id);
    const beforeOwnership = ownershipSnapshot(db);

    const { linkCookie } = await beginLink(server);
    const linked = await link(server, linkCookie, user.username);
    assert.equal(linked.status, 200);
    assert.deepEqual(await linked.json(), { success: true, complete_url: '/api/auth/hub/complete' });
    const sessionCookie = cookieValue(linked.headers.get('set-cookie'), 'mc_token');
    assert.ok(sessionCookie);

    const afterUser = db.prepare('SELECT * FROM users WHERE id = ?').get(user.id);
    assert.equal(afterUser.id, beforeUser.id);
    assert.equal(afterUser.email, beforeUser.email);
    assert.equal(afterUser.username, beforeUser.username);
    assert.equal(afterUser.name, beforeUser.name);
    assert.equal(afterUser.password_hash, beforeUser.password_hash);
    assert.equal(afterUser.role, beforeUser.role);
    assert.equal(afterUser.auth_provider, 'mbfd_hub');
    assert.equal(afterUser.provider_id, 'hub-user:42');
    assert.deepEqual(ownershipSnapshot(db), beforeOwnership);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM users WHERE email LIKE '%@federated.invalid'").get().n, 0);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM users').get().n, 1);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM hub_federated_identities').get().n, 1);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM hub_account_link_transactions').get().n, 0);
    assert.equal(ensureWorkspaceCalls(), 1);

    const session = await fetch(`${origin(server)}/api/auth/hub/session`, { headers: { Cookie: `mc_token=${sessionCookie}` } });
    assert.equal(session.status, 200);
    const sessionBody = await session.json();
    assert.equal(sessionBody.user.id, user.id);
    assert.equal(sessionBody.user.email, user.email);
    assert.equal(sessionBody.user.role, role);

    const second = await beginLink(server);
    assert.equal(cookieValue(second.callback.headers.get('set-cookie'), 'mc_hub_link'), '');
    assert.ok(cookieValue(second.callback.headers.get('set-cookie'), 'mc_token'));
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM users').get().n, 1);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM hub_federated_identities').get().n, 1);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM workspaces').get().n, 1);
    assert.equal(ensureWorkspaceCalls(), 2);
  });
}

test('invalid proof is generic, retryable, and never links by matching Hub email or display name', async (t) => {
  const { db, server } = await harness(t, { claims: { email: 'preserved@miamibeachfl.gov', display_name: 'Preserved Profile' } });
  const user = seedUser(db);
  const { linkCookie } = await beginLink(server);
  for (const [identifier, password] of [['missing', PASSWORD], [user.username, 'wrong-password']]) {
    const response = await link(server, linkCookie, identifier, password);
    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), { error: 'account_link_failed' });
  }
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM users').get().n, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM hub_federated_identities').get().n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM hub_account_link_transactions').get().n, 1);
});

test('guest, wrong-browser cookie, expiry, and replay all fail closed', async (t) => {
  const { db, server } = await harness(t);
  const guest = seedUser(db, { id: 'guest-id', email: 'guest@mbfd.local', username: 'guest' });
  const { linkCookie } = await beginLink(server);

  const wrongBrowser = await link(server, 'wrong-browser-cookie', guest.username);
  assert.equal(wrongBrowser.status, 401);
  const guestAttempt = await link(server, linkCookie, guest.username);
  assert.equal(guestAttempt.status, 401);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM hub_federated_identities').get().n, 0);

  const employee = seedUser(db, { id: 'employee', email: 'employee@miamibeachfl.gov', username: 'employee' });
  db.prepare('UPDATE hub_account_link_transactions SET expires_at = 0').run();
  const expired = await link(server, linkCookie, employee.username);
  assert.equal(expired.status, 401);

  const fresh = await beginLink(server);
  const success = await link(server, fresh.linkCookie, employee.username);
  assert.equal(success.status, 200);
  const replay = await link(server, fresh.linkCookie, employee.username);
  assert.equal(replay.status, 401);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM hub_federated_identities').get().n, 1);
});

test('a user already mapped to another Hub subject cannot be rebound', async (t) => {
  const { db, server } = await harness(t);
  const user = seedUser(db);
  db.prepare("UPDATE users SET auth_provider='mbfd_hub', provider_id='hub-user:7' WHERE id=?").run(user.id);
  db.prepare('INSERT INTO hub_federated_identities (provider, subject, user_id) VALUES (?, ?, ?)')
    .run('mbfd_hub', 'hub-user:7', user.id);
  const { linkCookie } = await beginLink(server);
  const response = await link(server, linkCookie, user.username);
  assert.equal(response.status, 401);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM hub_federated_identities').get().n, 1);
});

test('double link consumption is atomic', async (t) => {
  const { db, server } = await harness(t);
  const user = seedUser(db);
  const { linkCookie } = await beginLink(server);
  const [a, b] = await Promise.all([
    link(server, linkCookie, user.username),
    link(server, linkCookie, user.username),
  ]);
  assert.deepEqual([a.status, b.status].sort(), [200, 401]);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM users').get().n, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM hub_federated_identities').get().n, 1);
});

test('account-link password proof is strictly rate limited per account', async (t) => {
  const { db, server } = await harness(t);
  const user = seedUser(db);
  const { linkCookie } = await beginLink(server);
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const response = await link(server, linkCookie, user.username, 'wrong-password');
    assert.equal(response.status, 401);
  }
  const limited = await link(server, linkCookie, user.username, 'wrong-password');
  assert.equal(limited.status, 429);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM hub_federated_identities').get().n, 0);
});
