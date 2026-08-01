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
let workspaceId = '';
let viewerToken = '';
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
  workspaceId = body.current_workspace_id || workspaceId;
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
  workspaceId = body.current_workspace_id || workspaceId;
  return body;
}

function seedOperatorTopology() {
  const Database = require('better-sqlite3');
  const database = new Database(path.join(tmpDir, 'test.db'), { timeout: 10000 });
  database.pragma('busy_timeout = 10000');
  try {
    const resolvedWorkspace = workspaceId || database.prepare(
      'SELECT workspace_id FROM workspace_members WHERE user_id = ? LIMIT 1'
    ).get(authUser.id)?.workspace_id;
    if (!resolvedWorkspace) throw new Error('Test workspace was not resolved');

    database.transaction(() => {
      database.prepare(`
        INSERT OR IGNORE INTO users (id, email, name, role, auth_provider, plan_id)
        VALUES ('test-classroom-viewer', 'classroom-viewer@test.local', 'Classroom Viewer', 'user', 'local', 'enterprise')
      `).run();
      database.prepare(`
        INSERT OR REPLACE INTO workspace_members (workspace_id, user_id, role)
        VALUES (?, 'test-classroom-viewer', 'workspace_viewer')
      `).run(resolvedWorkspace);
      const insertDevice = database.prepare(`
        INSERT INTO devices (id, user_id, workspace_id, name, pairing_code, status, wall_id)
        VALUES (?, ?, ?, ?, ?, 'offline', ?)
      `);
      insertDevice.run('test-display-a', authUser.id, resolvedWorkspace, 'Available Display A', '810001', null);
      insertDevice.run('test-display-b', authUser.id, resolvedWorkspace, 'Available Display B', '810002', null);
      insertDevice.run('test-protected-display', authUser.id, resolvedWorkspace, 'Protected Display', '810003', 'test-protected-wall');
      insertDevice.run('test-protected-display-2', authUser.id, resolvedWorkspace, 'Protected Display 2', '810004', 'test-protected-wall');
      insertDevice.run('test-protected-display-3', authUser.id, resolvedWorkspace, 'Protected Display 3', '810005', 'test-protected-wall');
      database.prepare(`
        INSERT INTO video_walls (id, user_id, workspace_id, name, grid_cols, grid_rows, is_locked)
        VALUES ('test-protected-wall', ?, ?, 'Classroom Video Walls Test Fixture', 3, 1, 1)
      `).run(authUser.id, resolvedWorkspace);
      database.prepare(`
        INSERT INTO video_wall_devices (wall_id, device_id, grid_col, grid_row, canvas_x, canvas_y, canvas_width, canvas_height)
        VALUES
          ('test-protected-wall', 'test-protected-display', 0, 0, 0, 0, 1920, 1080),
          ('test-protected-wall', 'test-protected-display-2', 1, 0, 1920, 0, 1920, 1080),
          ('test-protected-wall', 'test-protected-display-3', 2, 0, 3840, 0, 1920, 1080)
      `).run();
    })();
    viewerToken = require('jsonwebtoken').sign({
      id: 'test-classroom-viewer',
      email: 'classroom-viewer@test.local',
      role: 'user',
      current_workspace_id: resolvedWorkspace,
    }, JWT_SECRET, { algorithm: 'HS256', expiresIn: '1h' });
  } finally {
    database.close();
  }
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
    // A service-worker-mediated Playwright response can omit Content-Type even
    // though the browser received and executed the module. Flag only a
    // successful body that explicitly advertises a non-JavaScript MIME.
    if (status === 200 && /\.(js|mjs)(\?|$)/i.test(url)) {
      const ct = response.headers()['content-type'] || '';
      if (ct && !ct.includes('javascript') && !ct.includes('text/javascript')) {
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

  test('1g. Live Sources renders only the canonical Anpviz camera when the edge is unavailable', async ({ page }) => {
    const errors = attachErrorCollectors(page);
    await setupAuth(page);
    await page.goto(`${BASE_URL}/app#/control`);
    await expect(page.locator('.mc-cc-shell')).toBeVisible({ timeout: 20000 });

    await page.locator('#mc-library-drawer > [data-library-toggle]').click();
    const liveSourcesTab = page.locator('.mc-tb-tab[data-tab="camerafeeds"]');
    await expect(liveSourcesTab).toBeVisible();
    await liveSourcesTab.click();
    await expect(page.locator('.mc-live-source-tile')).toHaveCount(1);
    await expect(page.locator('.mc-live-source-tile .mc-tile-label')).toHaveText('Anpviz Camera');
    await expect(page.locator('.mc-live-source-tile')).toBeDisabled();
    await expect(page.locator('body')).not.toContainText(/ANNKE|WyreStorm|Focus 210|Camera [123]/i);

    const height = await page.locator('.mc-live-source-tile').evaluate((element) =>
      element.getBoundingClientRect().height);
    expect(height).toBeGreaterThanOrEqual(48);
    assertNoErrors(errors, 'canonical live sources');
  });

  test('1h. Direct Camera-panel navigation isolates a delayed Media-tab render', async ({ page }) => {
    const errors = attachErrorCollectors(page);
    await setupAuth(page);
    await page.route('**/api/folders*', async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 750));
      await route.continue();
    });

    await page.goto(`${BASE_URL}/app#/control?panel=cameras`);
    await expect(page.locator('.mc-live-source-tile')).toHaveCount(1, { timeout: 20000 });
    await expect(page.locator('.mc-live-source-tile .mc-tile-label')).toHaveText('Anpviz Camera');
    await page.waitForTimeout(1_000);

    assertNoErrors(errors, 'direct Camera-panel navigation');
  });

  test('1i. Live News stays open across refresh and Miami Beach webcams are organized separately', async ({ page }) => {
    const errors = attachErrorCollectors(page);
    await setupAuth(page);
    await page.goto(`${BASE_URL}/app#/control?panel=cameras`);
    await expect(page.locator('.mc-live-source-tile')).toHaveCount(1, { timeout: 20000 });

    const liveNews = page.locator('details[data-feed-group-id="news"]');
    await expect(liveNews).toHaveJSProperty('open', true);
    await expect(liveNews.locator('.mc-news-feed-section')).toHaveCount(3);
    await expect(liveNews.locator('.mc-live-news-tile')).toHaveCount(7);

    // The source inventory refreshes every five seconds. The disclosure must
    // retain an explicit operator close when the DOM is replaced by that refresh.
    await liveNews.locator('summary').click();
    await expect(liveNews).toHaveJSProperty('open', false);
    await page.waitForTimeout(6_250);
    await expect(page.locator('details[data-feed-group-id="news"]')).toHaveJSProperty('open', false);

    const publicWebcams = page.locator('details[data-feed-group-id="miami-beach"]');
    await expect(publicWebcams.locator('summary')).toContainText('Miami Beach Public Webcams');
    await expect(publicWebcams).toHaveJSProperty('open', true);
    await expect(publicWebcams.locator('.mc-public-feed-section')).toHaveCount(3);
    await expect(publicWebcams.locator('.mc-live-news-tile')).toHaveCount(5);

    await expect(page.locator('.mc-cc-head')).not.toContainText(/\b\d+\s+LIVE\b/i);
    assertNoErrors(errors, 'stable live-source disclosures');
  });

  test('1j. Miami Beach wrapper accepts only curated feed identifiers', async ({ page }) => {
    await page.goto(`${BASE_URL}/player/external-feed.html?feed=mb-1st-street`);
    await expect(page.locator('#label')).toHaveText('1st Street Beach · Ocean Rescue');
    await expect(page.locator('iframe')).toHaveAttribute('src', /^https:\/\/relay\.ozolio\.com\/pub\.api\?/);
    await expect(page.locator('#error')).toBeHidden();

    await page.goto(`${BASE_URL}/player/external-feed.html?feed=https%3A%2F%2Fexample.com`);
    await expect(page.locator('iframe')).toHaveCount(0);
    await expect(page.locator('#error')).toBeVisible();
  });

  test('1k. Guest Computer player is clean full-stage LL-HLS without forced segment lag', async ({ page }) => {
    await page.route('**/player/live-source/guest-computer/**', async (route) => {
      await route.fulfill({ status: 503, contentType: 'text/plain', body: 'fixture unavailable' });
    });
    await page.goto(`${BASE_URL}/player/live-source.html?source=guest-computer&audio=1`);
    await expect(page.locator('.stage')).toBeVisible();
    await expect(page.locator('.bar')).toHaveCount(0);
    await expect(page.locator('#meta')).toBeHidden();

    const geometry = await page.locator('video').evaluate((video) => {
      const rect = video.getBoundingClientRect();
      return { width: rect.width, height: rect.height, fit: getComputedStyle(video).objectFit };
    });
    expect(geometry).toEqual({ width: 1440, height: 900, fit: 'contain' });

    const hlsConfig = await page.evaluate(() => ({
      lowLatencyMode: window.__hls?.userConfig?.lowLatencyMode,
      maxLiveSyncPlaybackRate: window.__hls?.userConfig?.maxLiveSyncPlaybackRate,
      forcedSegmentCount: Object.prototype.hasOwnProperty.call(window.__hls?.userConfig || {}, 'liveSyncDurationCount'),
    }));
    expect(hlsConfig).toEqual({
      lowLatencyMode: true,
      maxLiveSyncPlaybackRate: 1.1,
      forcedSegmentCount: false,
    });
  });

  test('1l. enhanced Whiteboard launcher is reachable from the web action dock', async ({ page }) => {
    const errors = attachErrorCollectors(page);
    await setupAuth(page);
    await page.goto(`${BASE_URL}/app#/control`);
    const launcher = page.locator('[data-dock="whiteboard"]');
    await expect(launcher).toBeVisible({ timeout: 20000 });
    const contract = await launcher.evaluate((button) => ({
      height: button.getBoundingClientRect().height,
      label: button.textContent.trim(),
      launcher_registered: typeof window.mcOpenWhiteboard === 'function',
    }));
    expect(contract.height).toBeGreaterThanOrEqual(44);
    expect(contract.label).toBe('Whiteboard');
    expect(contract.launcher_registered).toBe(true);
    assertNoErrors(errors, 'web Whiteboard action dock');
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
    seedOperatorTopology();
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

  test('2b2. Fresh authenticated sessions land on Command Center even when Operator Control is enabled', async ({ page }) => {
    const errors = attachErrorCollectors(page);
    await setupAuth(page);

    await page.goto(`${BASE_URL}/app#/login`);
    await page.waitForURL('**/app#/control', { timeout: 20000 });
    await expect(page.locator('.mc-cc-shell')).toBeVisible();

    await page.goto(`${BASE_URL}/app`);
    await page.waitForURL('**/app#/control', { timeout: 20000 });
    await expect(page.locator('.mc-cc-shell')).toBeVisible();
    assertNoErrors(errors, 'Command Center session landing');
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

  test('2d. Operator Control prioritizes topology and keeps advanced routing secondary', async ({ page }) => {
    const errors = attachErrorCollectors(page);
    await setupAuth(page);
    await page.goto(`${BASE_URL}/app#/operator-console`);

    await expect(page.getByRole('heading', { name: 'Operator Control' })).toBeVisible({ timeout: 20000 });
    await expect(page.locator('[data-topology-manager]')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Pair display' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Create custom wall' })).toBeVisible();
    await expect(page.locator('[data-protected-wall="test-protected-wall"]')).toContainText('Protected Classroom Video Wall');
    await expect(page.locator('[data-protected-wall="test-protected-wall"] [data-tm-configure-wall]')).toBeVisible();
    await expect(page.locator('[data-protected-wall="test-protected-wall"] [data-tm-edit-wall]')).toHaveCount(0);
    await expect(page.locator('[data-protected-wall="test-protected-wall"] [data-tm-delete-wall]')).toHaveCount(0);
    await expect(page.locator('[data-device-id="test-protected-display"]')).toContainText('Protected wall member');
    await expect(page.locator('[data-device-id="test-protected-display"] button')).toHaveCount(0);

    const advanced = page.locator('details.mc-e-routing-workspace');
    await expect(advanced).not.toHaveAttribute('open', '');
    await expect(advanced.locator('summary')).toHaveText('Advanced content routing');
    await expect(page.locator('.mc-e-console > section').filter({ hasText: 'About' })).toHaveCount(0);

    assertNoErrors(errors, 'focused Operator Control');
  });

  test('2e. Custom walls can be created and removed while protected walls allow layouts but reject identity mutation', async ({ page }) => {
    const errors = attachErrorCollectors(page);
    await setupAuth(page);
    await page.goto(`${BASE_URL}/app#/operator-console`);
    await expect(page.locator('[data-topology-manager]')).toBeVisible({ timeout: 20000 });

    const protectedResponse = await page.request.put(`${BASE_URL}/api/walls/test-protected-wall`, {
      headers: { Authorization: `Bearer ${authToken}` },
      data: { name: 'Must Not Change' },
    });
    expect(protectedResponse.status()).toBe(423);
    await expect(protectedResponse.json()).resolves.toMatchObject({ code: 'PROTECTED_WALL' });

    const protectedWallBefore = await page.request.get(`${BASE_URL}/api/walls/test-protected-wall`, {
      headers: { Authorization: `Bearer ${authToken}` },
    });
    expect(protectedWallBefore.ok()).toBe(true);
    const protectedWall = await protectedWallBefore.json();
    const layoutResponse = await page.request.put(`${BASE_URL}/api/walls/test-protected-wall/layout`, {
      headers: { Authorization: `Bearer ${viewerToken}` },
      data: {
        preset: 'split-all',
        expected_revision: Number(protectedWall.layout_revision) || 0,
      },
    });
    expect(layoutResponse.ok()).toBe(true);
    await expect(layoutResponse.json()).resolves.toMatchObject({ layout_mode: 'split' });

    await page.getByRole('button', { name: 'Create custom wall' }).click();
    const form = page.locator('[data-tm-wall-form]');
    await form.locator('input[name="name"]').fill('Isolated Browser Test Wall');
    await form.locator('input[value="test-display-a"]').check();
    await form.locator('input[value="test-display-b"]').check();
    await form.getByRole('button', { name: 'Create wall' }).click();

    const customWall = page.locator('.mc-e-wall-row').filter({ hasText: 'Isolated Browser Test Wall' });
    await expect(customWall).toContainText('2 displays · Custom wall');
    await expect(customWall.getByRole('button', { name: 'Edit' })).toBeVisible();
    await expect(customWall.getByRole('button', { name: 'Delete' })).toBeVisible();

    const customWallsResponse = await page.request.get(`${BASE_URL}/api/walls`, {
      headers: { Authorization: `Bearer ${authToken}` },
    });
    const customWallRecord = (await customWallsResponse.json()).find((wall) => wall.name === 'Isolated Browser Test Wall');
    const deniedViewerLayout = await page.request.put(`${BASE_URL}/api/walls/${customWallRecord.id}/layout`, {
      headers: { Authorization: `Bearer ${viewerToken}` },
      data: {
        preset: 'span-all',
        expected_revision: Number(customWallRecord.layout_revision) || 0,
      },
    });
    expect(deniedViewerLayout.status()).toBe(403);

    page.on('dialog', async (dialog) => dialog.accept('DELETE'));
    await customWall.getByRole('button', { name: 'Delete' }).click();
    await expect(page.locator('.mc-e-wall-row').filter({ hasText: 'Isolated Browser Test Wall' })).toHaveCount(0);
    await expect(page.locator('[data-protected-wall="test-protected-wall"]')).toBeVisible();

    assertNoErrors(errors, 'custom wall lifecycle');
  });

  test('2f. Wall layout changes converge in another browser without reload', async ({ browser }) => {
    const contextA = await browser.newContext();
    const contextB = await browser.newContext();
    const pageA = await contextA.newPage();
    const pageB = await contextB.newPage();
    await setupAuth(pageA);
    await setupAuth(pageB);
    await pageA.goto(`${BASE_URL}/app#/control?target=${encodeURIComponent('wall:test-protected-wall')}`);
    await pageB.goto(`${BASE_URL}/app#/control?target=${encodeURIComponent('wall:test-protected-wall')}`);
    await expect(pageA.locator('#connectionStatus .status-dot.online')).toBeVisible({ timeout: 15000 });
    await expect(pageB.locator('#connectionStatus .status-dot.online')).toBeVisible({ timeout: 15000 });
    await pageB.evaluate(async () => {
      const socket = await import('/js/socket.js');
      window.__wallChangedEvents = 0;
      window.__roomSnapshotWallModes = [];
      socket.on('wall-changed', () => { window.__wallChangedEvents += 1; });
      socket.on('room-snapshot', (snapshot) => {
        const fixture = snapshot?.layoutState?.walls?.find((wall) => wall.id === 'test-protected-wall');
        window.__roomSnapshotWallModes.push(fixture?.layoutMode || null);
      });
    });

    let wallResponse = await pageA.request.get(`${BASE_URL}/api/walls/test-protected-wall`, {
      headers: { Authorization: `Bearer ${authToken}` },
    });
    let wall = await wallResponse.json();
    let changed = await pageA.request.put(`${BASE_URL}/api/walls/test-protected-wall/layout`, {
      headers: { Authorization: `Bearer ${authToken}` },
      data: {
        preset: 'split-all',
        expected_revision: Number(wall.layout_revision) || 0,
      },
    });
    expect(changed.ok()).toBe(true);
    await expect(pageB.locator('[data-ss-mode="split"]')).toHaveAttribute('aria-pressed', 'true', { timeout: 2500 });

    wallResponse = await pageA.request.get(`${BASE_URL}/api/walls/test-protected-wall`, {
      headers: { Authorization: `Bearer ${authToken}` },
    });
    wall = await wallResponse.json();
    changed = await pageA.request.put(`${BASE_URL}/api/walls/test-protected-wall/layout`, {
      headers: { Authorization: `Bearer ${authToken}` },
      data: {
        preset: 'span-all',
        expected_revision: Number(wall.layout_revision) || 0,
      },
    });
    expect(changed.ok()).toBe(true);
    await expect.poll(() => pageB.evaluate(() => window.__wallChangedEvents), { timeout: 2500 }).toBeGreaterThanOrEqual(2);
    await expect.poll(() => pageB.evaluate(() => window.__roomSnapshotWallModes.at(-1)), { timeout: 2500 }).toBe('span');
    await expect(pageB.locator('[data-ss-mode="span"]')).toHaveAttribute('aria-pressed', 'true', { timeout: 2500 });
    await contextA.close();
    await contextB.close();
  });

  test('2g. A stale browser applies both hybrid presets without reload, conflict loops, or uncaught errors', async ({ browser }) => {
    const contextA = await browser.newContext();
    const contextB = await browser.newContext();
    const pageA = await contextA.newPage();
    const pageB = await contextB.newPage();
    const errorsA = attachErrorCollectors(pageA);
    const layoutConflicts = [];
    const layoutConsoleErrors = [];
    pageA.on('console', (message) => {
      if (
        message.type() === 'error'
        && (
          message.location().url.includes('/api/walls/test-protected-wall/layout')
          || /Wall layout changed|LAYOUT_REVISION_CONFLICT/i.test(message.text())
        )
      ) {
        layoutConsoleErrors.push(message.text());
      }
    });
    pageA.on('response', (response) => {
      if (
        response.status() === 409
        && response.url().includes('/api/walls/test-protected-wall/layout')
      ) {
        layoutConflicts.push(response.url());
      }
    });

    await setupAuth(pageA);
    await setupAuth(pageB);
    await pageA.goto(`${BASE_URL}/app#/control?target=${encodeURIComponent('wall:test-protected-wall')}`);
    await pageB.goto(`${BASE_URL}/app#/control?target=${encodeURIComponent('wall:test-protected-wall')}`);
    await expect(pageA.locator('#connectionStatus .status-dot.online')).toBeVisible({ timeout: 15000 });
    await expect(pageB.locator('#connectionStatus .status-dot.online')).toBeVisible({ timeout: 15000 });
    await expect(pageA.locator('[data-layout-preset="span-left"]')).toBeVisible();
    await expect(pageA.locator('[data-layout-preset="span-right"]')).toBeVisible();

    try {
      // Deliberately hold browser A on an old revision. The operator action
      // must fetch the current revision before mutating instead of entering a
      // permanent 409 loop.
      await pageA.evaluate(async () => {
        const socket = await import('/js/socket.js');
        socket.getSocket()?.disconnect();
      });

      let response = await pageB.request.get(`${BASE_URL}/api/walls/test-protected-wall`, {
        headers: { Authorization: `Bearer ${authToken}` },
      });
      let wall = await response.json();
      response = await pageB.request.put(`${BASE_URL}/api/walls/test-protected-wall/layout`, {
        headers: { Authorization: `Bearer ${authToken}` },
        data: {
          preset: 'span-left',
          expected_revision: Number(wall.layout_revision),
        },
      });
      expect(response.ok()).toBe(true);

      await pageA.locator('[data-layout-preset="span-right"]').click();
      await expect(pageA.locator('[data-layout-preset="span-right"]')).toHaveAttribute('aria-pressed', 'true');

      response = await pageB.request.get(`${BASE_URL}/api/walls/test-protected-wall`, {
        headers: { Authorization: `Bearer ${authToken}` },
      });
      wall = await response.json();
      expect(wall.layout_mode).toBe('groups');
      expect(wall.layout.preset).toBe('span-right');

      await pageA.locator('[data-layout-preset="span-left"]').click();
      await expect(pageA.locator('[data-layout-preset="span-left"]')).toHaveAttribute('aria-pressed', 'true');

      response = await pageB.request.get(`${BASE_URL}/api/walls/test-protected-wall`, {
        headers: { Authorization: `Bearer ${authToken}` },
      });
      wall = await response.json();
      expect(wall.layout_mode).toBe('groups');
      expect(wall.layout.preset).toBe('span-left');
      expect(layoutConflicts).toHaveLength(0);
      expect(layoutConsoleErrors).toHaveLength(0);
      expect(errorsA.page).toHaveLength(0);
      expect(errorsA.failedRequests).toHaveLength(0);
      expect(errorsA.mimeErrors).toHaveLength(0);
    } finally {
      const currentResponse = await pageB.request.get(`${BASE_URL}/api/walls/test-protected-wall`, {
        headers: { Authorization: `Bearer ${authToken}` },
      });
      if (currentResponse.ok()) {
        const current = await currentResponse.json();
        await pageB.request.put(`${BASE_URL}/api/walls/test-protected-wall/layout`, {
          headers: { Authorization: `Bearer ${authToken}` },
          data: {
            preset: 'span-all',
            expected_revision: Number(current.layout_revision),
          },
        });
      }
      await contextA.close();
      await contextB.close();
    }
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
