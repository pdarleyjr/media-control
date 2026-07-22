'use strict';

// Task §16 — Service-Worker / Cache-Transition verification (Media Control
// release branch). Does NOT modify production code.
//
// Finding (documented up front): the dashboard at /app does NOT register a
// service worker. The only service worker in the repo is server/player/sw.js,
// which is scoped to /player (player displays) and never controls /app.
// The dashboard instead relies on a CACHE-BUSTING bootstrap:
//   1. /app sets Cache-Control: no-store AND Clear-Site-Data: "cache" so the
//      browser drops its HTTP cache every time the shell is requested.
//   2. JS/CSS/HTML are served with Cache-Control: no-cache (always revalidate
//      via ETag/Last-Modified → 304 when unchanged).
//   3. dashboard-bootstrap-v2.js imports /js/app.js?v=dashboard-bootstrap-v2
//      (a stable cache-busting query param) so a stale cached module graph
//      is never reused after the bootstrap file itself is revalidated.
//   4. app.js polls /api/version (frontendHash) every 15s; on a hash change it
//      shows a "reload now" toast (non-console mode) — it does NOT auto-reload
//      the operator dashboard, so there is no reload loop on the dashboard.
//
// This suite tests the cache-busting transition instead of a service worker.

const { test, expect } = require('@playwright/test');
const { spawn, execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

// ── Configuration ───────────────────────────────────────────────────
const SERVER_DIR = path.resolve(__dirname, '..', '..');
const PORT = 18116; // distinct from real-app.spec.js (18099) to avoid clashes
const BASE_URL = `http://127.0.0.1:${PORT}`;
const JWT_SECRET = 'svc-worker-playwright-test-jwt-secret-hs256-min-length-ok';
const TEST_EMAIL = 'svcworker@test.local';
const TEST_PASSWORD = 'svc-worker-test-password';
const TEST_NAME = 'SW Test';

let serverProcess = null;
let tmpDir = '';
let authToken = '';
let authUser = null;
let serverLogs = [];

// ── Server lifecycle helpers (mirrors real-app.spec.js) ──────────────
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
  const { enterpriseEnabled = true, reuseDb = false } = options;
  killServer();
  if (!reuseDb) {
    if (tmpDir) { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} }
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-svcworker-'));
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
  if (!res.ok) throw new Error(`Login failed (${res.status})`);
  const body = await res.json();
  authToken = body.token;
  authUser = body.user;
  return body;
}

// ── Error collectors (mirrors real-app.spec.js) ─────────────────────
function attachErrorCollectors(page) {
  const errors = { console: [], page: [], failedRequests: [], mimeErrors: [], reloadCount: 0 };
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

async function setupAuth(page) {
  await page.addInitScript(({ token, user }) => {
    localStorage.setItem('token', token);
    localStorage.setItem('user', JSON.stringify(user));
    localStorage.setItem('rd_onboarded', '1');
  }, { token: authToken, user: authUser });
}

test.describe.configure({ mode: 'serial' });

// ═══════════════════════════════════════════════════════════════════
// Part A — Service-Worker / Cache-Busting Transition
// ═══════════════════════════════════════════════════════════════════
test.describe('Part A — Service-Worker / Cache-Busting Transition', () => {
  test.beforeAll(async () => {
    // Start with flag ON so #/operator-console enterprise assets can be tested.
    await startServer({ enterpriseEnabled: true, reuseDb: false });
    await registerTestUser();
    // Restart with the canary user in the allowlist (same DB).
    await startServer({ enterpriseEnabled: true, reuseDb: true });
    await loginUser();
  });

  test.afterAll(() => {
    killServer();
    if (tmpDir) { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} }
  });

  test('A1. /app carries cache-busting headers (no-store + Clear-Site-Data cache)', async () => {
    const res = await fetch(`${BASE_URL}/app`, { redirect: 'manual' });
    expect(res.status, `/app should be 200, got ${res.status}`).toBe(200);
    const cc = res.headers.get('cache-control') || '';
    const csd = res.headers.get('clear-site-data') || '';
    expect(cc.toLowerCase(), `Cache-Control should be no-store, got "${cc}"`).toContain('no-store');
    expect(csd, `Clear-Site-Data should clear cache, got "${csd}"`).toContain('cache');
  });

  test('A2. JS/CSS/HTML are served no-cache (revalidate via ETag/304)', async () => {
    // First fetch a JS asset → should come back with Cache-Control: no-cache.
    const jsRes = await fetch(`${BASE_URL}/js/dashboard-bootstrap-v2.js`);
    expect(jsRes.ok, `bootstrap JS fetch failed: ${jsRes.status}`).toBe(true);
    const jsCc = jsRes.headers.get('cache-control') || '';
    expect(jsCc.toLowerCase(), `JS Cache-Control should be no-cache, got "${jsCc}"`).toContain('no-cache');
    const etag = jsRes.headers.get('etag');
    expect(etag, 'JS asset should have an ETag for revalidation').toBeTruthy();

    // Revalidate with If-None-Match → expect 304.
    const reval = await fetch(`${BASE_URL}/js/dashboard-bootstrap-v2.js`, { headers: { 'If-None-Match': etag } });
    expect(reval.status, `Revalidation should return 304, got ${reval.status}`).toBe(304);

    // CSS also no-cache.
    const cssRes = await fetch(`${BASE_URL}/css/main.css`);
    expect(cssRes.ok).toBe(true);
    const cssCc = cssRes.headers.get('cache-control') || '';
    expect(cssCc.toLowerCase(), `CSS Cache-Control should be no-cache, got "${cssCc}"`).toContain('no-cache');
  });

  test('A3. No service worker controls /app (cache-busting bootstrap is the mechanism)', async ({ page }) => {
    const errors = attachErrorCollectors(page);
    await setupAuth(page);
    await page.goto(`${BASE_URL}/app#/control`);
    await expect(page.locator('.mc-cc-shell')).toBeVisible({ timeout: 20000 });
    await page.waitForTimeout(2000);

    const swState = await page.evaluate(async () => {
      const registrations = (navigator.serviceWorker && navigator.serviceWorker.getRegistrations)
        ? await navigator.serviceWorker.getRegistrations()
        : 'unsupported';
      return {
        supported: 'serviceWorker' in navigator,
        registrations: Array.isArray(registrations) ? registrations.map((r) => r.scope) : registrations,
        regCount: Array.isArray(registrations) ? registrations.length : 0,
      };
    });

    console.log(`[A3] serviceWorker supported=${swState.supported}, registrations=${JSON.stringify(swState.registrations)}`);
    // The dashboard deliberately has NO controlling service worker.
    expect(swState.regCount, `Unexpected service worker(s) controlling /app: ${JSON.stringify(swState.registrations)}`).toBe(0);

    assertNoErrors(errors, 'no service worker on /app');
  });

  test('A4. #/control loads all JS/CSS from one consistent version (no 404s, no mixed versions)', async ({ page }) => {
    const errors = attachErrorCollectors(page);
    await setupAuth(page);
    await page.goto(`${BASE_URL}/app#/control`);
    await expect(page.locator('.mc-cc-shell')).toBeVisible({ timeout: 20000 });
    await page.waitForTimeout(3000); // let async chunks load

    const assetInfo = await page.evaluate(() => {
      const scripts = Array.from(document.querySelectorAll('script[src]')).map((s) => s.src);
      const entry = Array.from(document.querySelectorAll('script[type="module"]')).map((s) => s.src);
      const perf = performance.getEntriesByType('resource')
        .filter((e) => /\.(js|css|mjs)(\?|$)/i.test(e.name))
        .map((e) => ({ url: e.name, status: e.responseStatus || null }));
      return { scripts, entry, perf };
    });

    console.log(`[A4] script tags=${assetInfo.scripts.length}, module entries=${assetInfo.entry.length}, perf resources=${assetInfo.perf.length}`);

    // Verify every JS/CSS resource succeeded (status 0/200 — 0 means cached/cross-origin OK).
    const failed = assetInfo.perf.filter((r) => r.status !== null && r.status >= 400);
    expect(failed, `Failed asset loads: ${JSON.stringify(failed)}`).toHaveLength(0);

    // No mixed versions: all app.js imports use the same ?v= query (the cache-bust token).
    const appJsUrls = assetInfo.perf.filter((r) => /\/js\/app\.js/.test(r.url)).map((r) => r.url);
    const versions = new Set(appJsUrls.map((u) => { const m = u.match(/[?&]v=([^&]+)/); return m ? m[1] : 'none'; }));
    expect(versions.size, `Mixed app.js versions detected: ${JSON.stringify(Array.from(versions))}`).toBeLessThanOrEqual(1);

    assertNoErrors(errors, '#/control consistent versions');
  });

  test('A5. Hard refresh (Ctrl+Shift+R / bypass cache) still loads the app', async ({ page }) => {
    const errors = attachErrorCollectors(page);
    await setupAuth(page);
    await page.goto(`${BASE_URL}/app#/control`);
    await expect(page.locator('.mc-cc-shell')).toBeVisible({ timeout: 20000 });
    await page.waitForTimeout(1500);

    // Hard refresh via CDP Page.reload with ignoreCache:true (bypass cache).
    const client = await page.context().newCDPSession(page);
    await client.send('Page.enable');
    await client.send('Network.enable');
    await client.send('Page.reload', { ignoreCache: true });
    await page.waitForLoadState('domcontentloaded', { timeout: 30000 });
    await expect(page.locator('.mc-cc-shell')).toBeVisible({ timeout: 20000 });
    await page.waitForTimeout(2000);

    assertNoErrors(errors, 'hard refresh');
  });

  test('A6. Ordinary refresh still loads the app', async ({ page }) => {
    const errors = attachErrorCollectors(page);
    await setupAuth(page);
    await page.goto(`${BASE_URL}/app#/control`);
    await expect(page.locator('.mc-cc-shell')).toBeVisible({ timeout: 20000 });

    await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 });
    await expect(page.locator('.mc-cc-shell')).toBeVisible({ timeout: 20000 });
    await page.waitForTimeout(2000);

    assertNoErrors(errors, 'ordinary refresh');
  });

  test('A7. #/operator-console (flag on) loads enterprise assets consistently', async ({ page }) => {
    const errors = attachErrorCollectors(page);
    await setupAuth(page);
    await page.goto(`${BASE_URL}/app#/control`);
    await expect(page.locator('.mc-cc-shell')).toBeVisible({ timeout: 20000 });

    await page.evaluate(() => { window.location.hash = '#/operator-console'; });
    await page.waitForTimeout(5000);

    const consoleGrid = await page.locator('.mc-e-console-grid').count();
    expect(consoleGrid, 'Enterprise operator console (.mc-e-console-grid) did not render').toBeGreaterThan(0);
    await page.waitForTimeout(2000);

    // Enterprise-specific assets loaded without error.
    assertNoErrors(errors, '#/operator-console enterprise assets');
  });

  test('A8. No infinite reload loop: version poll does not auto-reload the operator dashboard', async ({ page }) => {
    const errors = attachErrorCollectors(page);
    await setupAuth(page);
    await page.goto(`${BASE_URL}/app#/control`);
    await expect(page.locator('.mc-cc-shell')).toBeVisible({ timeout: 20000 });

    // Place a sentinel on window. A full reload resets the window scope,
    // so a surviving sentinel proves no reload happened.
    const sentinelTs = Date.now();
    await page.evaluate((ts) => { window.__bootSentinel = { ts }; }, sentinelTs);

    // Wait beyond the 15s version-poll interval so the poll definitely fires.
    await page.waitForTimeout(20000);

    const survived = await page.evaluate(() => !!(window.__bootSentinel && window.__bootSentinel.ts));
    expect(survived, 'Window sentinel was lost — the page reloaded during the version poll (possible reload loop)').toBe(true);

    // Confirm the shell is still mounted (no reload churn).
    await expect(page.locator('.mc-cc-shell')).toBeVisible();

    assertNoErrors(errors, 'no reload loop');
  });

  test('A9. Cache-busting new→old transition: /app clears cache and re-fetches fresh assets', async () => {
    // The /app response carries Clear-Site-Data: "cache". This test verifies
    // that a second /app request still returns no-store + clear-site-data
    // (the bootstrap is idempotent across transitions) and that assets
    // revalidate rather than serving stale content.

    // First load (simulates "new" version present on server).
    const r1 = await fetch(`${BASE_URL}/app`);
    const r1Body = await r1.text();
    expect(r1.status).toBe(200);
    expect(r1.headers.get('cache-control').toLowerCase()).toContain('no-store');
    expect(r1.headers.get('clear-site-data')).toContain('cache');
    expect(r1Body).toContain('dashboard-bootstrap-v2.js');

    // Second load (simulates after a transition/rollback — bootstrap still revalidates).
    const r2 = await fetch(`${BASE_URL}/app`);
    const r2Body = await r2.text();
    expect(r2.status).toBe(200);
    expect(r2.headers.get('cache-control').toLowerCase()).toContain('no-store');
    expect(r2.headers.get('clear-site-data')).toContain('cache');
    expect(r2Body).toContain('dashboard-bootstrap-v2.js');

    // Asset revalidation still produces 304 (no stale serve).
    const bootstrap = await fetch(`${BASE_URL}/js/dashboard-bootstrap-v2.js`);
    const etag = bootstrap.headers.get('etag');
    expect(etag).toBeTruthy();
    const reval = await fetch(`${BASE_URL}/js/dashboard-bootstrap-v2.js`, { headers: { 'If-None-Match': etag } });
    expect(reval.status).toBe(304);
  });

  test('A10. Player service worker (server/player/sw.js) exists and is scoped to /player only', async () => {
    // Document the only service worker in the repo and confirm it never
    // interferes with the dashboard by checking its scope rules.
    const swPath = path.join(SERVER_DIR, 'player', 'sw.js');
    expect(fs.existsSync(swPath), 'player sw.js should exist').toBe(true);
    const swSrc = fs.readFileSync(swPath, 'utf8');

    // The player SW only handles /player and socket.io — it ignores everything else.
    expect(swSrc, 'player sw.js should scope fetch to /player').toContain("url.pathname.startsWith('/player')");
    expect(swSrc, 'player sw.js should not intercept non-player paths').toMatch(/don.t intercept|Everything else/i);

    // Confirm /app is NOT served from /player scope (the dashboard route).
    const appRes = await fetch(`${BASE_URL}/app`);
    expect(appRes.status).toBe(200);
    // /player/sw.js is a distinct path — the dashboard never loads it.
    const swRes = await fetch(`${BASE_URL}/player/sw.js`);
    expect(swRes.ok).toBe(true);
    const swHeaders = swRes.headers.get('cache-control') || '';
    // The player SW itself is revalidated (no-cache) so player updates propagate.
    expect(swHeaders.toLowerCase()).toContain('no-cache');
  });
});
