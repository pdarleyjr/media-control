'use strict';

// Task §17 — Feature-Flag Rollback verification (Media Control release branch).
// Does NOT modify production code.
//
// Verifies the ENTERPRISE_OPERATOR_UI feature flag can be rolled back safely:
//   - flag OFF → existing interface loads, #/operator-console falls back,
//     enterprise nav hidden, /api/features authorized:false
//   - flag ON + canary allowlist → enterprise console loads, authorized:true
//   - non-canary user → authorized:false (fail-closed)
//   - rollback to OFF → canary returns to existing interface
//   - stale browser state (localStorage) cannot reopen the enterprise route
//
// The flag is server-authoritative: the frontend gate (js/state/feature-flags.js)
// fetches GET /api/features (no-store, per-user) and ignores localStorage for
// authorization. A query-param cannot enable the flag.

const { test, expect } = require('@playwright/test');
const { spawn, execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

// ── Configuration ───────────────────────────────────────────────────
const SERVER_DIR = path.resolve(__dirname, '..', '..');
const PORT = 18117; // distinct from real-app.spec.js (18099) and service-worker.spec.js
const BASE_URL = `http://127.0.0.1:${PORT}`;
const JWT_SECRET = 'feature-flag-rollback-playwright-jwt-secret-hs256-min-length-ok';

const CANARY_EMAIL = 'canary@test.local';
const CANARY_PASSWORD = 'canary-test-password';
const CANARY_NAME = 'Canary User';

const NONCANARY_EMAIL = 'noncanary@test.local';
const NONCANARY_PASSWORD = 'noncanary-test-password';
const NONCANARY_NAME = 'Non Canary User';

let serverProcess = null;
let tmpDir = '';
let canaryToken = '';
let canaryUser = null;
let noncanaryToken = '';
let noncanaryUser = null;
let serverLogs = [];

// ── Server lifecycle helpers ─────────────────────────────────────────
function killServer() {
  if (!serverProcess) return;
  const pid = serverProcess.pid;
  try {
    if (process.platform === 'win32') execSync(`taskkill /pid ${pid} /T /F`, { stdio: 'ignore' });
    else process.kill(pid, 'SIGKILL');
  } catch { /* best-effort */ }
  serverProcess = null;
}

function startServer(options = {}) {
  const { enterpriseEnabled = false, canaryUserId = '', reuseDb = false } = options;
  killServer();
  if (!reuseDb) {
    if (tmpDir) { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} }
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-ffrollback-'));
  }
  const dbPath = path.join(tmpDir, 'test.db');
  const env = {
    ...process.env,
    PORT: String(PORT),
    DB_PATH: dbPath,
    JWT_SECRET: JWT_SECRET,
    NODE_ENV: 'development',
    DISABLE_REGISTRATION: 'false',
    SELF_HOSTED: 'true',
    ENTERPRISE_OPERATOR_UI_ENABLED: enterpriseEnabled ? 'true' : 'false',
    ENTERPRISE_OPERATOR_UI_USERS: canaryUserId,
    PLAYER_DEBUG_REPORTING: 'off',
  };
  serverLogs = [];
  serverProcess = spawn(process.execPath, ['server.js'], { cwd: SERVER_DIR, env, stdio: ['pipe', 'pipe', 'pipe'] });
  serverProcess.stdout.on('data', (d) => serverLogs.push(d.toString()));
  serverProcess.stderr.on('data', (d) => serverLogs.push(`[stderr] ${d.toString()}`));
  serverProcess.on('exit', (code, signal) => serverLogs.push(`[server exited code=${code} signal=${signal}]`));
  return waitForServer();
}

async function waitForServer(timeoutMs = 45000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (serverProcess && serverProcess.exitCode !== null && serverProcess.exitCode !== undefined) {
      throw new Error(`Server exited early (code=${serverProcess.exitCode}).\nRecent logs:\n${serverLogs.slice(-50).join('')}`);
    }
    try {
      const res = await fetch(`${BASE_URL}/api/version`);
      if (res.ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`Server did not respond within ${timeoutMs}ms.\nRecent logs:\n${serverLogs.slice(-50).join('')}`);
}

async function registerUser(email, password, name) {
  const res = await fetch(`${BASE_URL}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password, name }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(`Registration failed for ${email} (${res.status}): ${JSON.stringify(body)}`);
  }
  return res.json();
}

async function loginUser(email, password) {
  const res = await fetch(`${BASE_URL}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ identifier: email, password }),
  });
  if (!res.ok) throw new Error(`Login failed for ${email} (${res.status})`);
  return res.json();
}

async function getFeatures(token) {
  const res = await fetch(`${BASE_URL}/api/features`, { headers: { Authorization: `Bearer ${token}` } });
  expect(res.ok, `/api/features should be 200, got ${res.status}`).toBe(true);
  return res.json();
}

// ── Error collectors ─────────────────────────────────────────────────
function attachErrorCollectors(page) {
  const errors = { console: [], page: [], failedRequests: [], mimeErrors: [] };
  page.on('console', (msg) => { if (msg.type() === 'error') errors.console.push(msg.text()); });
  page.on('pageerror', (err) => errors.page.push(err.message));
  page.on('requestfailed', (req) => {
    const url = req.url();
    if (url.includes('sw-admin.js') || url.includes('cloudflareinsights')) return;
    errors.failedRequests.push(`${url} - ${req.failure()?.errorText || 'failed'}`);
  });
  page.on('response', (response) => {
    const url = response.url();
    const status = response.status();
    if (status >= 400 && /\.(js|css|mjs)(\?|$)/i.test(url)) errors.failedRequests.push(`${url} - HTTP ${status}`);
    if (status < 400 && /\.(js|mjs)(\?|$)/i.test(url) && !url.includes('socket.io')) {
      const ct = response.headers()['content-type'] || '';
      if (!ct.includes('javascript') && !ct.includes('text/javascript')) errors.mimeErrors.push(`${url} - Content-Type: ${ct}`);
    }
  });
  return errors;
}

function assertNoErrors(errors, context = '') {
  const label = context ? ` (${context})` : '';
  if (errors.console.length) throw new Error(`Console errors${label}:\n  ${errors.console.join('\n  ')}`);
  if (errors.page.length) throw new Error(`Uncaught page errors${label}:\n  ${errors.page.join('\n  ')}`);
  if (errors.failedRequests.length) throw new Error(`Failed requests${label}:\n  ${errors.failedRequests.join('\n  ')}`);
  if (errors.mimeErrors.length) throw new Error(`MIME type errors${label}:\n  ${errors.mimeErrors.join('\n  ')}`);
}

async function setupAuth(page, token, user) {
  await page.addInitScript(({ token, user }) => {
    localStorage.setItem('token', token);
    localStorage.setItem('user', JSON.stringify(user));
    localStorage.setItem('rd_onboarded', '1');
  }, { token, user });
}

test.describe.configure({ mode: 'serial' });

// ═══════════════════════════════════════════════════════════════════
// Phase 1 — Flag OFF: existing interface, fallback, hidden nav
// ═══════════════════════════════════════════════════════════════════
test.describe('Phase 1 — Feature flag OFF: existing interface loads, enterprise route falls back', () => {
  test.beforeAll(async () => {
    // Fresh DB, flag OFF, no canary allowlist.
    await startServer({ enterpriseEnabled: false, canaryUserId: '', reuseDb: false });
    const c = await registerUser(CANARY_EMAIL, CANARY_PASSWORD, CANARY_NAME);
    canaryToken = c.token; canaryUser = c.user;
    const nc = await registerUser(NONCANARY_EMAIL, NONCANARY_PASSWORD, NONCANARY_NAME);
    noncanaryToken = nc.token; noncanaryUser = nc.user;
  });

  test.afterAll(() => { killServer(); });

  test('1a. #/control renders the Command Center (existing interface)', async ({ page }) => {
    const errors = attachErrorCollectors(page);
    await setupAuth(page, canaryToken, canaryUser);
    await page.goto(`${BASE_URL}/app#/control`);
    await expect(page.locator('.mc-cc-shell')).toBeVisible({ timeout: 20000 });
    await expect(page.locator('.mc-cc-head')).toBeVisible();
    await expect(page.locator('.mc-cc-main')).toBeVisible();
    await page.waitForTimeout(3000);
    assertNoErrors(errors, '#/control flag off');
  });

  test('1b. #/operator-console falls back to #/control (flag off)', async ({ page }) => {
    const errors = attachErrorCollectors(page);
    await setupAuth(page, canaryToken, canaryUser);
    await page.goto(`${BASE_URL}/app#/control`);
    await expect(page.locator('.mc-cc-shell')).toBeVisible({ timeout: 20000 });

    await page.evaluate(() => { window.location.hash = '#/operator-console'; });
    await page.waitForTimeout(3000);

    // Fallback: Command Center still visible, enterprise console NOT rendered.
    await expect(page.locator('.mc-cc-shell')).toBeVisible();
    const grid = await page.locator('.mc-e-console-grid').count();
    expect(grid, 'Enterprise console should NOT render when flag is off').toBe(0);

    assertNoErrors(errors, '#/operator-console fallback');
  });

  test('1c. Enterprise nav item is hidden (flag off)', async ({ page }) => {
    await setupAuth(page, canaryToken, canaryUser);
    await page.goto(`${BASE_URL}/app#/control`);
    await expect(page.locator('.mc-cc-shell')).toBeVisible({ timeout: 20000 });
    await page.waitForTimeout(2000);
    const nav = page.locator('#operatorConsoleNavItem');
    await expect(nav).toBeHidden();
  });

  test('1d. /api/features returns authorized:false (flag off)', async () => {
    const body = await getFeatures(canaryToken);
    expect(body.features.enterpriseOperatorUi).toEqual({ enabled: false, authorized: false });
  });
});

// ═══════════════════════════════════════════════════════════════════
// Phase 2 — Flag ON + canary allowlist: enterprise console + authorization
// ═══════════════════════════════════════════════════════════════════
test.describe('Phase 2 — Feature flag ON + canary: enterprise console loads, authorization enforced', () => {
  test.beforeAll(async () => {
    // Restart with flag ON and the canary user id in the allowlist (reuse DB).
    await startServer({ enterpriseEnabled: true, canaryUserId: canaryUser.id, reuseDb: true });
    // Refresh tokens (same DB + JWT secret, but login to be safe).
    const c = await loginUser(CANARY_EMAIL, CANARY_PASSWORD);
    canaryToken = c.token; canaryUser = c.user;
    const nc = await loginUser(NONCANARY_EMAIL, NONCANARY_PASSWORD);
    noncanaryToken = nc.token; noncanaryUser = nc.user;
  });

  test.afterAll(() => { killServer(); });

  test('2a. /api/features returns authorized:true for canary user', async () => {
    const body = await getFeatures(canaryToken);
    expect(body.features.enterpriseOperatorUi).toEqual({ enabled: true, authorized: true });
  });

  test('2b. #/operator-console loads the enterprise console (canary)', async ({ page }) => {
    const errors = attachErrorCollectors(page);
    await setupAuth(page, canaryToken, canaryUser);
    await page.goto(`${BASE_URL}/app#/control`);
    await expect(page.locator('.mc-cc-shell')).toBeVisible({ timeout: 20000 });

    await page.evaluate(() => { window.location.hash = '#/operator-console'; });
    await page.waitForTimeout(5000);

    const grid = await page.locator('.mc-e-console-grid').count();
    expect(grid, 'Enterprise operator console (.mc-e-console-grid) did not render').toBeGreaterThan(0);
    await page.waitForTimeout(2000);

    assertNoErrors(errors, '#/operator-console canary');
  });

  test('2c. Enterprise nav item is visible for canary (flag on)', async ({ page }) => {
    await setupAuth(page, canaryToken, canaryUser);
    await page.goto(`${BASE_URL}/app#/control`);
    await expect(page.locator('.mc-cc-shell')).toBeVisible({ timeout: 20000 });
    await page.waitForTimeout(2000);
    const nav = page.locator('#operatorConsoleNavItem');
    await expect(nav).toBeVisible();
  });

  test('2d. /api/features returns authorized:false for non-canary user (fail-closed)', async () => {
    const body = await getFeatures(noncanaryToken);
    expect(body.features.enterpriseOperatorUi).toEqual({ enabled: true, authorized: false });
  });

  test('2e. Non-canary user falls back to #/control on #/operator-console', async ({ page }) => {
    const errors = attachErrorCollectors(page);
    await setupAuth(page, noncanaryToken, noncanaryUser);
    await page.goto(`${BASE_URL}/app#/control`);
    await expect(page.locator('.mc-cc-shell')).toBeVisible({ timeout: 20000 });

    await page.evaluate(() => { window.location.hash = '#/operator-console'; });
    await page.waitForTimeout(3000);

    // Not authorized → falls back to Command Center, no enterprise grid.
    await expect(page.locator('.mc-cc-shell')).toBeVisible();
    const grid = await page.locator('.mc-e-console-grid').count();
    expect(grid, 'Non-canary should NOT see enterprise console').toBe(0);

    assertNoErrors(errors, 'non-canary fallback');
  });

  test('2f. Enterprise nav item is hidden for non-canary user', async ({ page }) => {
    await setupAuth(page, noncanaryToken, noncanaryUser);
    await page.goto(`${BASE_URL}/app#/control`);
    await expect(page.locator('.mc-cc-shell')).toBeVisible({ timeout: 20000 });
    await page.waitForTimeout(2000);
    const nav = page.locator('#operatorConsoleNavItem');
    await expect(nav).toBeHidden();
  });
});

// ═══════════════════════════════════════════════════════════════════
// Phase 3 — Rollback to OFF: canary returns to existing interface
// ═══════════════════════════════════════════════════════════════════
test.describe('Phase 3 — Rollback to OFF: canary returns to existing interface', () => {
  test.beforeAll(async () => {
    // Restart with flag OFF (reuse DB). Canary is no longer authorized.
    await startServer({ enterpriseEnabled: false, canaryUserId: '', reuseDb: true });
    const c = await loginUser(CANARY_EMAIL, CANARY_PASSWORD);
    canaryToken = c.token; canaryUser = c.user;
  });

  test.afterAll(() => { killServer(); });

  test('3a. After rollback, /api/features returns authorized:false for canary', async () => {
    const body = await getFeatures(canaryToken);
    expect(body.features.enterpriseOperatorUi).toEqual({ enabled: false, authorized: false });
  });

  test('3b. After rollback, canary #/operator-console falls back to #/control', async ({ page }) => {
    const errors = attachErrorCollectors(page);
    await setupAuth(page, canaryToken, canaryUser);
    await page.goto(`${BASE_URL}/app#/control`);
    await expect(page.locator('.mc-cc-shell')).toBeVisible({ timeout: 20000 });

    await page.evaluate(() => { window.location.hash = '#/operator-console'; });
    await page.waitForTimeout(3000);

    await expect(page.locator('.mc-cc-shell')).toBeVisible();
    const grid = await page.locator('.mc-e-console-grid').count();
    expect(grid, 'After rollback, canary must NOT see enterprise console').toBe(0);

    assertNoErrors(errors, 'rollback fallback');
  });

  test('3c. After rollback, enterprise nav item is hidden for canary', async ({ page }) => {
    await setupAuth(page, canaryToken, canaryUser);
    await page.goto(`${BASE_URL}/app#/control`);
    await expect(page.locator('.mc-cc-shell')).toBeVisible({ timeout: 20000 });
    await page.waitForTimeout(2000);
    await expect(page.locator('#operatorConsoleNavItem')).toBeHidden();
  });
});

// ═══════════════════════════════════════════════════════════════════
// Phase 4 — Stale browser state (localStorage) cannot reopen the route
// ═══════════════════════════════════════════════════════════════════
test.describe('Phase 4 — Stale browser state cannot reopen the enterprise route', () => {
  test.beforeAll(async () => {
    // Flag OFF (post-rollback state). Reuse the running server if still up.
    if (!serverProcess || serverProcess.exitCode !== null) {
      await startServer({ enterpriseEnabled: false, canaryUserId: '', reuseDb: true });
    }
    const c = await loginUser(CANARY_EMAIL, CANARY_PASSWORD);
    canaryToken = c.token; canaryUser = c.user;
  });

  test.afterAll(() => {
    killServer();
    if (tmpDir) { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} }
  });

  test('4a. Stale localStorage flag data cannot reopen #/operator-console (fresh load)', async ({ page }) => {
    const errors = attachErrorCollectors(page);
    // Seed localStorage with bogus enterprise-flag data that the app does NOT
    // consult for authorization (the gate fetches /api/features server-side).
    await page.addInitScript(({ token, user }) => {
      localStorage.setItem('token', token);
      localStorage.setItem('user', JSON.stringify(user));
      localStorage.setItem('rd_onboarded', '1');
      // Malicious/stale attempts to fake enterprise authorization via localStorage:
      localStorage.setItem('enterpriseOperatorUi', JSON.stringify({ enabled: true, authorized: true }));
      localStorage.setItem('mc_enterprise_authorized', 'true');
      localStorage.setItem('featureFlags', JSON.stringify({ enterpriseOperatorUi: { enabled: true, authorized: true } }));
    }, { token: canaryToken, user: canaryUser });

    // Load directly onto the enterprise route (deep link).
    await page.goto(`${BASE_URL}/app#/operator-console`);
    await page.waitForTimeout(4000);

    // Despite stale localStorage, the server says authorized:false → fallback.
    const grid = await page.locator('.mc-e-console-grid').count();
    const shell = await page.locator('.mc-cc-shell').count();
    expect(grid, 'Stale localStorage must NOT open enterprise console').toBe(0);
    expect(shell, 'App must fall back to Command Center despite stale localStorage').toBeGreaterThan(0);

    assertNoErrors(errors, 'stale localStorage fallback');
  });

  test('4b. A query-param cannot enable the enterprise route', async ({ page }) => {
    const errors = attachErrorCollectors(page);
    await setupAuth(page, canaryToken, canaryUser);
    // Attempt to force-enable via query param (the server ignores it).
    await page.goto(`${BASE_URL}/app#/operator-console?enterprise=1&enabled=true`);
    await page.waitForTimeout(4000);

    const grid = await page.locator('.mc-e-console-grid').count();
    const shell = await page.locator('.mc-cc-shell').count();
    expect(grid, 'Query param must NOT enable enterprise console').toBe(0);
    expect(shell, 'App must fall back to Command Center').toBeGreaterThan(0);

    assertNoErrors(errors, 'query-param fallback');
  });

  test('4c. /api/features is no-store (cannot be cached across users/sessions)', async () => {
    const res = await fetch(`${BASE_URL}/api/features`, { headers: { Authorization: `Bearer ${canaryToken}` } });
    expect(res.ok).toBe(true);
    const cc = res.headers.get('cache-control') || '';
    expect(cc.toLowerCase()).toContain('no-store');
    const body = await res.json();
    expect(body.features.enterpriseOperatorUi).toEqual({ enabled: false, authorized: false });
  });
});
