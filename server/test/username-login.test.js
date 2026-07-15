'use strict';

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const bcrypt = require('bcryptjs');

const dbDir = path.join(process.env.KILO_TEMP || os.tmpdir(), `mc-username-db-${process.pid}`);
fs.rmSync(dbDir, { recursive: true, force: true });
fs.mkdirSync(dbDir, { recursive: true });

process.env.DB_PATH = path.join(dbDir, 'test.db');
process.env.JWT_SECRET = 'username-login-test-secret-that-is-long-enough';

const { db } = require('../db/database');
const authRouter = require('../routes/auth');

after(() => {
  try { db.close(); } catch {}
  fs.rmSync(dbDir, { recursive: true, force: true });
});

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

async function postLogin(server, body) {
  return fetch(`${baseUrl(server)}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

test('username login is case-insensitive and preserves legacy email login', async (t) => {
  const password = 'classroom-test-password';
  db.prepare(`
    INSERT INTO users (id, email, username, name, password_hash, auth_provider, role, plan_id)
    VALUES (?, ?, ?, ?, ?, 'local', 'user', 'enterprise')
  `).run(
    'username-login-user',
    'mbfd_union@mbfd.local',
    'MBFD_Union',
    'MBFD Union',
    bcrypt.hashSync(password, 4)
  );

  const app = express();
  app.use(express.json());
  app.use('/api/auth', authRouter);
  const server = await listen(app);
  t.after(() => server.close());

  const usernameResponse = await postLogin(server, { identifier: 'mbfd_union', password });
  assert.equal(usernameResponse.status, 200);
  const usernameBody = await usernameResponse.json();
  assert.ok(usernameBody.token);
  assert.equal(usernameBody.user.username, 'MBFD_Union');
  assert.equal(usernameBody.user.name, 'MBFD Union');
  assert.ok(usernameBody.current_workspace_id);

  const meResponse = await fetch(`${baseUrl(server)}/api/auth/me`, {
    headers: { Authorization: `Bearer ${usernameBody.token}` },
  });
  assert.equal(meResponse.status, 200);
  const me = await meResponse.json();
  assert.equal(me.username, 'MBFD_Union');
  assert.equal(me.current_workspace_role, 'workspace_admin');

  const emailResponse = await postLogin(server, {
    email: 'mbfd_union@mbfd.local',
    password,
  });
  assert.equal(emailResponse.status, 200);
});

test('usernames are unique without regard to case', () => {
  assert.throws(() => {
    db.prepare(`
      INSERT INTO users (id, email, username, name, auth_provider, role, plan_id)
      VALUES (?, ?, ?, ?, 'local', 'user', 'enterprise')
    `).run('duplicate-username-user', 'duplicate@example.test', 'mbfd_union', 'Duplicate');
  }, /UNIQUE constraint failed/);
});

test('login UI accepts an email or username while setup remains email-based', () => {
  const loginSource = fs.readFileSync(path.join(__dirname, '../../frontend/js/views/login.js'), 'utf8');
  assert.match(loginSource, /auth\.identifier/);
  assert.match(loginSource, /type="\$\{isSetup \? 'email' : 'text'\}"/);
  assert.match(loginSource, /JSON\.stringify\(\{ identifier, email: identifier, password \}\)/);
});
