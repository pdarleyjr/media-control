'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const bcrypt = require('bcryptjs');

const dbDir = path.join(process.env.KILO_TEMP || os.tmpdir(), `mc-hub-local-policy-${process.pid}`);
fs.mkdirSync(dbDir, { recursive: true });
process.env.DB_PATH = path.join(dbDir, 'test.db');
process.env.JWT_SECRET = 'hub-local-policy-test-secret-that-is-long-enough';
process.env.MBFD_HUB_FEDERATION_TOKEN = 'configured-test-service-token';
process.env.GOOGLE_CLIENT_ID = 'configured-google-client';
process.env.MICROSOFT_CLIENT_ID = 'configured-microsoft-client';

const { db } = require('../db/database');
const { ensureHubFederationSchema } = require('../routes/hub-federation');
const { generateToken } = require('../middleware/auth');
const authRouter = require('../routes/auth');

function listen(app) {
  const server = http.createServer(app);
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function origin(server) { return `http://127.0.0.1:${server.address().port}`; }

function insertUser({ id, email, username, role = 'user', provider = 'local', providerId = null, password = 'test-password' }) {
  db.prepare(`INSERT INTO users
    (id, email, username, name, password_hash, auth_provider, provider_id, role, plan_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'enterprise')`)
    .run(id, email, username, username, bcrypt.hashSync(password, 4), provider, providerId, role);
}

async function post(server, route, body, token) {
  return fetch(`${origin(server)}${route}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
}

test('Hub-enabled auth permits only the existing local guest and disables employee bypasses', async (t) => {
  ensureHubFederationSchema(db);
  insertUser({ id: 'guest-user', email: 'guest@mbfd.local', username: 'guest' });
  insertUser({ id: 'unlinked-user', email: 'unlinked@miamibeachfl.gov', username: 'unlinked' });
  insertUser({ id: 'linked-user', email: 'linked@miamibeachfl.gov', username: 'linked', provider: 'mbfd_hub', providerId: 'hub-user:42' });
  insertUser({ id: 'admin-user', email: 'admin@miamibeachfl.gov', username: 'admin', role: 'platform_admin' });
  db.prepare('INSERT INTO hub_federated_identities (provider, subject, user_id) VALUES (?, ?, ?)')
    .run('mbfd_hub', 'hub-user:42', 'linked-user');

  const app = express();
  app.use(express.json());
  app.use('/api/auth', authRouter);
  const server = await listen(app);
  t.after(() => { server.close(); db.close(); fs.rmSync(dbDir, { recursive: true, force: true }); });

  const guest = await post(server, '/api/auth/login', { identifier: 'guest', password: 'test-password' });
  assert.equal(guest.status, 200);
  assert.equal((await guest.json()).user.username, 'guest');

  for (const identifier of ['unlinked', 'unlinked@miamibeachfl.gov', 'linked']) {
    const denied = await post(server, '/api/auth/login', { identifier, password: 'test-password' });
    assert.equal(denied.status, 401);
    assert.deepEqual(await denied.json(), { error: 'Invalid email/username or password' });
  }

  const config = await fetch(`${origin(server)}/api/auth/config`).then((response) => response.json());
  assert.equal(config.hubEnabled, true);
  assert.equal(config.localEnabled, true);
  assert.equal(config.localMode, 'guest_only');
  assert.equal(config.googleEnabled, false);
  assert.equal(config.microsoftEnabled, false);
  assert.equal(config.registration_enabled, false);

  for (const [route, body] of [
    ['/api/auth/register', { email: 'new@miamibeachfl.gov', password: 'test-password' }],
    ['/api/auth/google', { credential: 'must-not-be-verified' }],
    ['/api/auth/microsoft', { access_token: 'must-not-be-used' }],
  ]) {
    const denied = await post(server, route, body);
    assert.equal(denied.status, 403);
  }

  const adminToken = generateToken(db.prepare('SELECT * FROM users WHERE id = ?').get('admin-user'), null);
  const usersResponse = await fetch(`${origin(server)}/api/auth/users`, {
    headers: { Authorization: `Bearer ${adminToken}` },
  });
  assert.equal(usersResponse.status, 200);
  const states = Object.fromEntries((await usersResponse.json()).map((user) => [user.username, user.identity_state]));
  assert.deepEqual(states, {
    guest: 'local_guest',
    unlinked: 'hub_unlinked',
    linked: 'hub_linked',
    admin: 'hub_unlinked',
  });

  const provisioned = await post(server, '/api/auth/users', {
    email: 'future@miamibeachfl.gov', username: 'future.employee', name: 'Future Employee',
    temporary_password: 'temporary-password', role: 'user',
  }, adminToken);
  assert.equal(provisioned.status, 201);
  const provisionedBody = await provisioned.json();
  assert.equal(provisionedBody.user.identity_state, 'hub_unlinked');
  assert.equal(provisionedBody.user.role, 'user');
  assert.equal(provisionedBody.user.password_hash, undefined);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM users WHERE id = ?').get(provisionedBody.user.id).n, 1);

  const guestProvision = await post(server, '/api/auth/users', {
    email: 'other@miamibeachfl.gov', username: 'guest', temporary_password: 'temporary-password', role: 'user',
  }, adminToken);
  assert.equal(guestProvision.status, 400);

  const oversizedEmail = await post(server, '/api/auth/users', {
    email: `${'a'.repeat(300)}@miamibeachfl.gov`, username: 'oversized',
    temporary_password: 'temporary-password', role: 'user',
  }, adminToken);
  assert.equal(oversizedEmail.status, 400);
});
