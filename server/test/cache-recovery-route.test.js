'use strict';

// Runtime HTTP tests for the POST /api/admin/cache-recovery endpoint (task §6).
// Verifies the security contract that cannot be checked by source-grep alone:
//   • GET is not handled (404) — state changes must not be prefetchable
//   • Unauthenticated POST → 401
//   • Non-admin POST → 403
//   • Cross-site (bad Origin) POST → 403
//   • Authorized POST → 200 + Clear-Site-Data: "cache"
//   • Duplicate POST within the window → idempotent (no re-emit, same result)
//
// Spawns the real server on a unique port with a temp DB, registers a user,
// promotes them to admin, and exercises the endpoint over HTTP.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn, execSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const SERVER_DIR = path.resolve(__dirname, '..');
const PORT = 18118;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const JWT_SECRET = 'cache-recovery-runtime-test-jwt-secret-hs256-ok';

let serverProcess = null;
let tmpDir = '';
let adminToken = '';
let userToken = '';
let adminUser = null;
let normalUser = null;

function killServer() {
  if (!serverProcess) return;
  const pid = serverProcess.pid;
  try {
    if (process.platform === 'win32') execSync(`taskkill /pid ${pid} /T /F`, { stdio: 'ignore' });
    else process.kill(pid, 'SIGKILL');
  } catch { /* best-effort */ }
  serverProcess = null;
}

async function waitForServer(timeoutMs = 45000) {
  const start = Date.now();
  const logs = [];
  if (serverProcess) {
    serverProcess.stdout.on('data', (d) => logs.push(d.toString()));
    serverProcess.stderr.on('data', (d) => logs.push(`[stderr] ${d.toString()}`));
  }
  while (Date.now() - start < timeoutMs) {
    if (serverProcess && serverProcess.exitCode !== null && serverProcess.exitCode !== undefined) {
      throw new Error(`Server exited early (code=${serverProcess.exitCode}).\nLogs:\n${logs.slice(-30).join('')}`);
    }
    try {
      const res = await fetch(`${BASE_URL}/api/version`);
      if (res.ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`Server did not respond within ${timeoutMs}ms.\nLogs:\n${logs.slice(-30).join('')}`);
}

async function registerUser(email, password, name) {
  const res = await fetch(`${BASE_URL}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password, name }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(`Registration failed (${res.status}): ${JSON.stringify(body)}`);
  }
  return res.json();
}

before(async () => {
  killServer();
  if (tmpDir) { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} }
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-cache-recovery-'));
  const dbPath = path.join(tmpDir, 'test.db');
  // Set env in the TEST process too so the db + auth modules we require below
  // open the same temp DB and use the same JWT secret as the server subprocess.
  process.env.DB_PATH = dbPath;
  process.env.JWT_SECRET = JWT_SECRET;
  process.env.NODE_ENV = 'development';
  process.env.SELF_HOSTED = 'true';
  const env = {
    ...process.env,
    PORT: String(PORT),
    DB_PATH: dbPath,
    JWT_SECRET: JWT_SECRET,
    NODE_ENV: 'development',
    DISABLE_REGISTRATION: 'false',
    SELF_HOSTED: 'true',
    ENTERPRISE_OPERATOR_UI_ENABLED: 'true',
    ENTERPRISE_OPERATOR_UI_USERS: '',
    PLAYER_DEBUG_REPORTING: 'off',
  };
  serverProcess = spawn(process.execPath, ['server.js'], { cwd: SERVER_DIR, env, stdio: ['pipe', 'pipe', 'pipe'] });
  await waitForServer();

  // Register two users: one normal, one to be promoted to admin.
  const adminBody = await registerUser('cacheadmin@test.local', 'admin-password-123', 'Cache Admin');
  const userBody = await registerUser('cacheuser@test.local', 'user-password-123', 'Cache User');
  adminUser = adminBody.user;
  normalUser = userBody.user;

  // Promote the admin user's role in the DB (same DB_PATH the server opened).
  const { db } = require('../db/database');
  db.prepare("UPDATE users SET role = 'admin' WHERE id = ?").run(adminUser.id);

  // Generate fresh tokens that carry the updated role. requireAuth re-reads
  // the user from the DB so the promoted role is honored.
  const { generateToken } = require('../middleware/auth');
  const adminRow = db.prepare('SELECT id, email, username, name, role, auth_provider, avatar_url, plan_id FROM users WHERE id = ?').get(adminUser.id);
  const userRow = db.prepare('SELECT id, email, username, name, role, auth_provider, avatar_url, plan_id FROM users WHERE id = ?').get(normalUser.id);
  adminToken = generateToken(adminRow, null);
  userToken = generateToken(userRow, null);
});

after(() => {
  killServer();
  if (tmpDir) { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} }
});

test('GET /api/admin/cache-recovery is not handled (404)', async () => {
  const res = await fetch(`${BASE_URL}/api/admin/cache-recovery`, {
    headers: { Authorization: `Bearer ${adminToken}` },
  });
  assert.ok(res.status === 404 || res.status === 405, `expected 404 or 405, got ${res.status}`);
});

test('Unauthenticated POST /api/admin/cache-recovery → 401', async () => {
  const res = await fetch(`${BASE_URL}/api/admin/cache-recovery`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
  });
  assert.equal(res.status, 401);
});

test('Non-admin POST /api/admin/cache-recovery → 403', async () => {
  const res = await fetch(`${BASE_URL}/api/admin/cache-recovery`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${userToken}` },
  });
  assert.equal(res.status, 403);
});

test('Cross-site POST (bad Origin) → 403', async () => {
  const res = await fetch(`${BASE_URL}/api/admin/cache-recovery`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${adminToken}`,
      Origin: 'https://evil.example.com',
    },
  });
  assert.equal(res.status, 403);
});

test('Authorized admin POST → 200 + Clear-Site-Data: "cache"', async () => {
  const res = await fetch(`${BASE_URL}/api/admin/cache-recovery`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${adminToken}`,
      Origin: BASE_URL,
    },
  });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('clear-site-data'), '"cache"');
  assert.equal(res.headers.get('cache-control'), 'no-store');
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.recovered, 'cache');
  assert.ok(body.requestId, 'response must carry a requestId');
});

test('Duplicate POST within window → idempotent (no Clear-Site-Data re-emit)', async () => {
  const res = await fetch(`${BASE_URL}/api/admin/cache-recovery`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${adminToken}`,
      Origin: BASE_URL,
    },
  });
  assert.equal(res.status, 200);
  // Idempotent retry must NOT re-emit the Clear-Site-Data header.
  assert.notEqual(res.headers.get('clear-site-data'), '"cache"');
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.idempotent, true);
});

test('Normal /app load does NOT emit Clear-Site-Data', async () => {
  const res = await fetch(`${BASE_URL}/app`, { redirect: 'manual' });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('clear-site-data'), null);
});
