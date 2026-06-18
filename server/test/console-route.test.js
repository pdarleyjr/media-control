const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const dbDir = path.join(process.env.KILO_TEMP || os.tmpdir(), `mc-console-db-${process.pid}`);
fs.rmSync(dbDir, { recursive: true, force: true });
fs.mkdirSync(dbDir, { recursive: true });

process.env.DB_PATH = path.join(dbDir, 'test.db');
process.env.CONSOLE_DEVICE_TOKEN = 'test-console-token';
process.env.CONSOLE_GUEST_USER_ID = 'test-console-guest';
process.env.CONSOLE_GUEST_EMAIL = 'guest-console@example.test';
process.env.DEFAULT_PROFILE = 'guest';

const { db } = require('../db/database');
const consoleRouter = require('../routes/console');

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

async function createConsoleServer(t) {
  const app = express();
  app.use(express.json());
  app.use('/api/console', consoleRouter);
  const server = await listen(app);
  t.after(() => server.close());
  return server;
}

test('console session mints a Guest dashboard token without normal login', async (t) => {
  const server = await createConsoleServer(t);

  const res = await fetch(`${baseUrl(server)}/api/console/session`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-MBFD-Device-Token': 'test-console-token',
    },
    body: JSON.stringify({
      room_id: 'Classroom 1',
      device_id: 'Podium Console',
      profile_id: 'guest',
    }),
  });

  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(body.token);
  assert.equal(body.user.id, 'test-console-guest');
  assert.equal(body.user.email, 'guest-console@example.test');
  assert.equal(body.user.auth_provider, 'console_guest');
  assert.equal(body.room_id, 'classroom1');
  assert.equal(body.device_id, 'podiumconsole');
  assert.equal(body.device_token_required, true);
  assert.ok(body.current_workspace_id);
  assert.ok(body.profiles.some((profile) => profile.id === 'test-console-guest'));
});

test('console session rejects an invalid trusted-device token', async (t) => {
  const server = await createConsoleServer(t);

  const res = await fetch(`${baseUrl(server)}/api/console/session`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-MBFD-Device-Token': 'wrong-token',
    },
    body: JSON.stringify({ profile_id: 'guest' }),
  });

  assert.equal(res.status, 403);
  const body = await res.json();
  assert.equal(body.error, 'Console device token rejected');
});
