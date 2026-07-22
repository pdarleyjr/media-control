'use strict';

// Real-application Playwright test against the live Media Control server.
// Does NOT use __MC_ENTERPRISE_MOCK_ONLY. Tests the REAL frontend/js/app.js
// router and the REAL frontend/index.html served by the REAL server.
//
// Phase 1: Feature flag OFF — server starts, user registers, app loads,
//           #/control renders, #/operator-console falls back to control,
//           socket connects, no errors.
// Phase 2: Feature flag ON  — server restarts with the test user authorized,
//           #/operator-console should render the enterprise console,
//           room-overview should render, no errors.
// Phase 3: Lifecycle         — 10x alternating #/control <-> #/operator-console,
//           no accumulating errors or duplicate socket connections.

const { test, expect } = require('@playwright/test');
const { spawn, execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

// ── Configuration ───────────────────────────────────────────────────
const SERVER_DIR = path.resolve(__dirname, '..', '..');
const PORT = 18099;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const JWT_SECRET = 'real-app-playwright-test-jwt-secret-hs256-min-length-ok';
const TEST_EMAIL = 'realapp@test.local';
const TEST_PASSWORD = 'real-app-test-password';
const TEST_NAME = 'Real App Test';

// ── Shared state (serial tests share a worker) ──────────────────────
let serverProcess = null;
let tmpDir = '';
let authToken = '';
let authUser = null;
let serverLogs = [];

// ── Server lifecycle helpers ────────────────────────────────────────

function killServer() {
  if (!serverProcess) return;
  const pid = serverProcess.pid;
  try {
    if (process.platform === 'win32') {
      execSync(`taskkill /pid ${pid} /T /F`, { stdio: 'ignore' });
    } else {
      process.kill(pid, 'SIGKILL');
    }
  } catch { /* best-effort */ }
  serverProcess = null;
}

function startServer(options = {}) {
  const { enterpriseEnabled = false, reuseDb = false } = options;
  killServer();

  if (!reuseDb) {
    if (tmpDir) {
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-realapp-'));
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
    ENTERPRISE_OPERATOR_UI_USERS: authUser ? authUser.id : '',
    PLAYER_DEBUG_REPORTING: 'off',
  };

  serverLogs = [];
  serverProcess = spawn(process.execPath, ['server.js'], {
    cwd: SERVER_DIR,
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  serverProcess.stdout.on('data', (data) => {
    const text = data.toString();
    serverLogs.push(text);
  });
  serverProcess.stderr.on('data', (data) => {
    const text = data.toString();
    serverLogs.push(`[stderr] ${text}`);
  });
  serverProcess.on('exit', (code, signal) => {
    serverLogs.push(`[server exited code=${code} signal=${signal}]`);
  });

  return waitForServer();
}

async function waitForServer(timeoutMs = 45000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (serverProcess && serverProcess.exitCode !== null && serverProcess.exitCode !== undefined) {
      const logs = serverLogs.slice(-50).join('');
      throw new Error(`Server exited early (code=${serverProcess.exitCode}).\nRecent logs:\n${logs}`);
    }
    try {
      const res = await fetch(`${BASE_URL}/api/version`);
      if (res.ok) return;
    } catch { /* not ready yet */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  const logs = serverLogs.slice(-50).join('');
  throw new Error(`Server did not respond within ${timeoutMs}ms.\nRecent logs:\n${logs}`);
}

async function registerTestUser() {
  const res = await fetch(`${BASE_URL}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: TEST_EMAIL, password: TEST_PASSWORD, name: TEST_NAME }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(`Registration failed (${res.status}): ${JSON.stringify(body)}`);
  }
  const body = await res.json();
  authToken = body.token;
  authUser = body.user;
  return body;
}

async function loginUser() {
  const res = await fetch(`${BASE_URL}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ identifier: TEST_EMAIL, password: TEST_PASSWORD }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(`Login failed (${res.status}): ${JSON.stringify(body)}`);
  }
  const body = await res.json();
  authToken = body.token;
  authUser = body.user;
  return body;
}

// ── Playwright error-collection helpers ────────────────────────────

function attachErrorCollectors(page) {
  const errors = {
    console: [],
    page: [],
    failedRequests: [],
    mimeErrors: [],
    socketConnected: false,
    socketConnectCount: 0,
  };

  page.on('console', (msg) => {
    const text = msg.text();
    if (text.includes('Dashboard connected')) {
      errors.socketConnected = true;
      errors.socketConnectCount++;
    }
    if (msg.type() === 'error') {
      errors.console.push(text);
    }
  });
  page.on('pageerror', (err) => {
    errors.page.push(err.message);
  });
  page.on('requestfailed', (req) => {
    const url = req.url();
    // Ignore non-critical failures
    if (url.includes('sw-admin.js') || url.includes('cloudflareinsights')) return;
    errors.failedRequests.push(`${url} - ${req.failure()?.errorText || 'failed'}`);
  });
  page.on('response', (response) => {
    const url = response.url();
    const status = response.status();
    // Track 404s for JS/CSS assets
    if (status >= 400 && /\.(js|css|mjs)(\?|$)/i.test(url)) {
      errors.failedRequests.push(`${url} - HTTP ${status}`);
    }
    // MIME type check for JS modules (must be application/javascript or text/javascript)
    if (status < 400 && /\.(js|mjs)(\?|$)/i.test(url) && !url.includes('socket.io')) {
      const ct = response.headers()['content-type'] || '';
      if (!ct.includes('javascript') && !ct.includes('text/javascript')) {
        errors.mimeErrors.push(`${url} - Content-Type: ${ct}`);
      }
    }
  });

  return errors;
}

function assertNoErrors(errors, context = '') {
  const label = context ? ` (${context})` : '';
  if (errors.console.length) {
    throw new Error(`Console errors${label}:\n  ${errors.console.join('\n  ')}`);
  }
  if (errors.page.length) {
    throw new Error(`Uncaught page errors${label}:\n  ${errors.page.join('\n  ')}`);
  }
  if (errors.failedRequests.length) {
    throw new Error(`Failed requests${label}:\n  ${errors.failedRequests.join('\n  ')}`);
  }
  if (errors.mimeErrors.length) {
    throw new Error(`MIME type errors${label}:\n  ${errors.mimeErrors.join('\n  ')}`);
  }
}

function errorSummary(errors) {
  const parts = [];
  if (errors.console.length) parts.push(`Console errors (${errors.console.length}):\n  ${errors.console.slice(0, 10).join('\n  ')}`);
  if (errors.page.length) parts.push(`Page errors (${errors.page.length}):\n  ${errors.page.slice(0, 10).join('\n  ')}`);
  if (errors.failedRequests.length) parts.push(`Failed requests (${errors.failedRequests.length}):\n  ${errors.failedRequests.slice(0, 10).join('\n  ')}`);
  if (errors.mimeErrors.length) parts.push(`MIME errors (${errors.mimeErrors.length}):\n  ${errors.mimeErrors.slice(0, 10).join('\n  ')}`);
  return parts.length ? parts.join('\n\n') : 'No errors detected';
}

// ── Auth setup helper ───────────────────────────────────────────────

async function setupAuth(page) {
  await page.addInitScript(({ token, user }) => {
    localStorage.setItem('token', token);
    localStorage.setItem('user', JSON.stringify(user));
    localStorage.setItem('rd_onboarded', '1');
  }, { token: authToken, user: authUser });
}

// ── Test suites ─────────────────────────────────────────────────────

test.describe.configure({ mode: 'serial' });

// ═══════════════════════════════════════════════════════════════════
// Phase 1: Feature flag OFF
// ═══════════════════════════════════════════════════════════════════

test.describe('Phase 1 — Feature flag OFF: real app loads correctly', () => {
  test.beforeAll(async () => {
    await startServer({ enterpriseEnabled: false });
    await registerTestUser();
  });

  test.afterAll(() => {
    killServer();
  });

  test('1a. Root URL redirects to /app and page loads', async ({ page }) => {
    const errors = attachErrorCollectors(page);
    await page.goto(BASE_URL);
    // Root redirects to /app
    await page.waitForURL('**/app', { timeout: 10000 });
    // #app container exists
    await expect(page.locator('#app')).toBeVisible();
    // Give assets time to load
    await page.waitForTimeout(2000);
    assertNoErrors(errors, 'root redirect');
  });

  test('1b. Authenticated #/control renders the Command Center', async ({ page }) => {
    const errors = attachErrorCollectors(page);
    await setupAuth(page);
    await page.goto(`${BASE_URL}/app#/control`);
    // Wait for the Command Center shell to render
    await expect(page.locator('.mc-cc-shell')).toBeVisible({ timeout: 20000 });
    await expect(page.locator('.mc-cc-head')).toBeVisible();
    // .mc-cc-rail is hidden via CSS in cc-fullscreen mode (by design);
    // verify the main content area renders instead.
    await expect(page.locator('.mc-cc-main')).toBeVisible();
    // Let async data fetches settle
    await page.waitForTimeout(3000);
    assertNoErrors(errors, '#/control authenticated');
  });

  test('1c. /api/features returns enterpriseOperatorUi disabled', async () => {
    const res = await fetch(`${BASE_URL}/api/features`, {
      headers: { Authorization: `Bearer ${authToken}` },
    });
    expect(res.ok).toBe(true);
    const body = await res.json();
    expect(body.features).toBeDefined();
    expect(body.features.enterpriseOperatorUi).toEqual({
      enabled: false,
      authorized: false,
    });
  });

  test('1d. #/operator-console falls back to control view (flag off)', async ({ page }) => {
    const errors = attachErrorCollectors(page);
    await setupAuth(page);
    await page.goto(`${BASE_URL}/app#/control`);
    await expect(page.locator('.mc-cc-shell')).toBeVisible({ timeout: 20000 });

    // Navigate to #/operator-console
    await page.evaluate(() => { window.location.hash = '#/operator-console'; });
    // Wait for the route to process (isEnterpriseUiEnabled is async)
    await page.waitForTimeout(3000);

    // When flag is off, the router falls back to mediaControl.render with
    // routeHash '#/control'. The Command Center should still be visible.
    await expect(page.locator('.mc-cc-shell')).toBeVisible();

    // The enterprise nav item should be hidden
    const navItem = page.locator('#operatorConsoleNavItem');
    await expect(navItem).toBeHidden();

    assertNoErrors(errors, '#/operator-console flag off');
  });

  test('1e. Socket.IO connects', async ({ page }) => {
    const errors = attachErrorCollectors(page);
    await setupAuth(page);
    await page.goto(`${BASE_URL}/app#/control`);
    await expect(page.locator('.mc-cc-shell')).toBeVisible({ timeout: 20000 });

    // Wait for the connection-status dot to become "online"
    await expect(
      page.locator('#connectionStatus .status-dot.online')
    ).toBeVisible({ timeout: 15000 });

    // Also verify via console log
    expect(errors.socketConnected, 'Dashboard socket "connected" console log not seen').toBe(true);

    assertNoErrors(errors, 'socket connection');
  });

  test('1f. Static assets load (no 404s, no MIME errors)', async ({ page }) => {
    const errors = attachErrorCollectors(page);
    await setupAuth(page);
    await page.goto(`${BASE_URL}/app#/control`);
    await expect(page.locator('.mc-cc-shell')).toBeVisible({ timeout: 20000 });

    // Let all assets finish loading
    await page.waitForTimeout(3000);

    // Verify CSS files loaded
    const cssLoaded = await page.evaluate(() => {
      const sheets = Array.from(document.styleSheets);
      return sheets.length > 0;
    });
    expect(cssLoaded, 'No CSS stylesheets loaded').toBe(true);

    // Verify app.js module loaded (the shell rendered, so it did)
    const appModuleLoaded = await page.evaluate(() => {
      return !!document.querySelector('.mc-cc-shell');
    });
    expect(appModuleLoaded, 'app.js module did not load').toBe(true);

    assertNoErrors(errors, 'static assets');
  });
});

// ═══════════════════════════════════════════════════════════════════
// Phase 2: Feature flag ON
// ═══════════════════════════════════════════════════════════════════

test.describe('Phase 2 — Feature flag ON: enterprise operator console', () => {
  test.beforeAll(async () => {
    // Step 1: Start with flag ON, fresh DB, empty users list
    await startServer({ enterpriseEnabled: true, reuseDb: false });
    // Step 2: Register user in the fresh DB
    await registerTestUser();
    // Step 3: Restart with flag ON, same DB, user ID now in the allowlist
    await startServer({ enterpriseEnabled: true, reuseDb: true });
    // Step 4: Login (token from registration is still valid — same JWT secret + same DB)
    // But to be safe, login to get a fresh token
    await loginUser();
  });

  test.afterAll(() => {
    killServer();
  });

  test('2a. /api/features returns enterpriseOperatorUi enabled+authorized', async () => {
    const res = await fetch(`${BASE_URL}/api/features`, {
      headers: { Authorization: `Bearer ${authToken}` },
    });
    expect(res.ok).toBe(true);
    const body = await res.json();
    expect(body.features.enterpriseOperatorUi).toEqual({
      enabled: true,
      authorized: true,
    });
  });

  test('2b. #/operator-console loads the enterprise console', async ({ page }) => {
    const errors = attachErrorCollectors(page);
    await setupAuth(page);
    await page.goto(`${BASE_URL}/app#/control`);
    await expect(page.locator('.mc-cc-shell')).toBeVisible({ timeout: 20000 });

    // Navigate to #/operator-console (flag is ON, user is authorized)
    await page.evaluate(() => { window.location.hash = '#/operator-console'; });
    await page.waitForTimeout(5000);

    // The enterprise console grid should render
    const consoleGrid = await page.locator('.mc-e-console-grid').count();
    const controlShell = await page.locator('.mc-cc-shell').count();

    console.log(`[2b] console-grid=${consoleGrid}, control-shell=${controlShell}`);
    console.log(`[2b] errors: ${errorSummary(errors)}`);

    // The enterprise operator console should load
    expect(consoleGrid, 'Enterprise operator console (.mc-e-console-grid) did not render').toBeGreaterThan(0);

    await page.waitForTimeout(2000);
    assertNoErrors(errors, '#/operator-console flag on');
  });

  test('2c. Room overview component renders', async ({ page }) => {
    const errors = attachErrorCollectors(page);
    await setupAuth(page);
    await page.goto(`${BASE_URL}/app#/operator-console`);
    await page.waitForTimeout(5000);

    const hasRoomOverview = await page.locator('[data-component="room-overview"]').count();
    const hasLoadingState = await page.locator('.mc-e-ro-loading').count();
    const hasConsoleGrid = await page.locator('.mc-e-console-grid').count();

    console.log(`[2c] room-overview=${hasRoomOverview}, loading=${hasLoadingState}, grid=${hasConsoleGrid}`);
    console.log(`[2c] errors: ${errorSummary(errors)}`);

    // Room overview should render (even in loading/empty state)
    expect(hasRoomOverview + hasLoadingState, 'Room overview did not render').toBeGreaterThan(0);

    assertNoErrors(errors, 'room overview');
  });
});

// ═══════════════════════════════════════════════════════════════════
// Phase 3: Lifecycle test — repeated navigation
// ═══════════════════════════════════════════════════════════════════

test.describe('Phase 3 — Lifecycle: repeated navigation', () => {
  test.beforeAll(async () => {
    // Server should already be running with flag ON from Phase 2.
    // If not, restart it.
    if (!serverProcess || serverProcess.exitCode !== null) {
      await startServer({ enterpriseEnabled: true, reuseDb: false });
      await registerTestUser();
      await startServer({ enterpriseEnabled: true, reuseDb: true });
      await loginUser();
    }
  });

  test.afterAll(() => {
    killServer();
    // Clean up temp dir
    if (tmpDir) {
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
  });

  test('3. 10x navigation #/control <-> #/operator-console: no accumulating errors', async ({ page }) => {
    const errors = attachErrorCollectors(page);
    await setupAuth(page);
    await page.goto(`${BASE_URL}/app#/control`);
    await expect(page.locator('.mc-cc-shell')).toBeVisible({ timeout: 20000 });
    await page.waitForTimeout(2000);

    const initialSocketConnects = errors.socketConnectCount;

    // Alternate navigation 10 times
    for (let i = 0; i < 10; i++) {
      await page.evaluate(() => { window.location.hash = '#/operator-console'; });
      await page.waitForTimeout(1500);
      await page.evaluate(() => { window.location.hash = '#/control'; });
      await page.waitForTimeout(1500);
    }

    const finalSocketConnects = errors.socketConnectCount;
    const newConnections = finalSocketConnects - initialSocketConnects;

    console.log(`[3] Socket connections: initial=${initialSocketConnects}, final=${finalSocketConnects}, new=${newConnections}`);
    console.log(`[3] Console errors: ${errors.console.length}, Page errors: ${errors.page.length}`);
    console.log(`[3] Failed requests: ${errors.failedRequests.length}, MIME errors: ${errors.mimeErrors.length}`);
    console.log(`[3] Error summary:\n${errorSummary(errors)}`);

    // Navigation should NOT create a new socket connection each time.
    // The socket persists across hash changes. A few reconnects are OK
    // (e.g. if the socket drops and reconnects), but not 10+.
    expect(newConnections, `Too many new socket connections during 10 navigations: ${newConnections}`).toBeLessThan(5);

    // No accumulating errors
    assertNoErrors(errors, '10x lifecycle navigation');
  });
});
