'use strict';

// Task §7 — Ten-minute real-browser lifecycle soak.
//
// Spawns a local server with a temp DB, registers a RESTRICTED test user
// (role: 'user', not superadmin), and exercises the real frontend for a full
// ten minutes in Chromium at 1920x1080. Records stage-render, iframe, socket,
// and memory metrics at one-minute intervals. Acceptance: no iframe recreation
// storm, no listener/observer growth, no duplicate sockets, no unexpected
// reloads, memory reaches a stable plateau.

const { chromium } = require('@playwright/test');
const { spawn, execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const SERVER_DIR = path.resolve(__dirname, '..', '..');
const PORT = 18119;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const JWT_SECRET = 'lifecycle-soak-test-jwt-secret-hs256-min-length-ok';
const TEST_EMAIL = 'soak@test.local';
const TEST_PASSWORD = 'soak-test-password-123';
const SOAK_MINUTES = 10;
const VP = { width: 1920, height: 1080 };

let serverProcess = null;
let tmpDir = '';

function killServer() {
  if (!serverProcess) return;
  const pid = serverProcess.pid;
  try {
    if (process.platform === 'win32') execSync(`taskkill /pid ${pid} /T /F`, { stdio: 'ignore' });
    else process.kill(pid, 'SIGKILL');
  } catch {}
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
    if (serverProcess && serverProcess.exitCode !== null) {
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

async function registerTestUser() {
  const res = await fetch(`${BASE_URL}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: TEST_EMAIL, password: TEST_PASSWORD, name: 'Soak Test' }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(`Registration failed (${res.status}): ${JSON.stringify(body)}`);
  }
  return res.json();
}

(async () => {
  console.log(`[soak] Starting 10-minute lifecycle soak at ${VP.width}x${VP.height} (Chromium)`);
  console.log(`[soak] Test user: ${TEST_EMAIL} (role: user, NOT superadmin)`);
  console.log(`[soak] JWT secret: dedicated test secret (never production)`);
  console.log(`[soak] Token lifetime: server default (will be destroyed with the temp DB)`);

  // Start server
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-lifecycle-soak-'));
  const dbPath = path.join(tmpDir, 'test.db');
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
  console.log('[soak] Server started');

  const { token, user } = await registerTestUser();
  console.log('[soak] Test user registered (restricted role: user)');

  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  const context = await browser.newContext({ viewport: VP, ignoreHTTPSErrors: true });
  const page = await context.newPage();

  // Console collectors
  const collected = {
    jsErrors: [],
    featurePolicy: [],
    clearSiteData: [],
    socketConnectCount: 0,
    reloadCount: 0,
    sourceMapErrors: [],
  };
  page.on('console', (msg) => {
    const text = msg.text();
    if (text.includes('Dashboard connected')) collected.socketConnectCount++;
    if (/feature[\s_-]?policy/i.test(text) || /skipping unsupported feature/i.test(text)) collected.featurePolicy.push(text);
    if (/clear-site-data/i.test(text)) collected.clearSiteData.push(text);
    if (/\.map(\?|$)/i.test(text) && /source map|devtools/i.test(text)) collected.sourceMapErrors.push(text);
  });
  page.on('pageerror', (err) => collected.jsErrors.push(err.message));
  page.on('page', () => collected.reloadCount++);

  // Set auth
  await page.addInitScript(({ token, user }) => {
    localStorage.setItem('token', token);
    localStorage.setItem('user', JSON.stringify(user));
    localStorage.setItem('rd_onboarded', '1');
  }, { token, user });

  // Navigate to control view
  await page.goto(`${BASE_URL}/app#/control`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#app', { timeout: 30000 });
  await page.waitForTimeout(3000);
  console.log('[soak] Dashboard mounted at /app#/control');

  // Exercise: navigate through views
  const exercises = [
    () => page.goto(`${BASE_URL}/app#/control`, { waitUntil: 'domcontentloaded' }).then(() => page.waitForTimeout(2000)),
    () => page.goto(`${BASE_URL}/app#/content`, { waitUntil: 'domcontentloaded' }).then(() => page.waitForTimeout(2000)),
    () => page.goto(`${BASE_URL}/app#/control`, { waitUntil: 'domcontentloaded' }).then(() => page.waitForTimeout(2000)),
  ];

  // Record metrics at 1-minute intervals
  function getMetrics() {
    return page.evaluate(() => {
      const m = window.__mcStageMetrics || {};
      const perf = performance.memory || {};
      return {
        renders: m.renders || 0,
        iframeCreates: m.iframeCreates || 0,
        iframeRemoves: m.iframeRemoves || 0,
        inPlacePatches: m.inPlacePatches || 0,
        jsHeapUsed: perf.usedJSHeapSize || 0,
        jsHeapTotal: perf.totalJSHeapSize || 0,
        jsHeapLimit: perf.jsHeapSizeLimit || 0,
        socketCount: (window.__socketMetrics && window.__socketMetrics.connections) || 0,
      };
    });
  }

  const snapshots = [];
  const startTime = Date.now();

  for (let minute = 0; minute <= SOAK_MINUTES; minute++) {
    const elapsed = Math.round((Date.now() - startTime) / 1000);
    const metrics = await getMetrics();
    const snapshot = {
      minute,
      elapsed_s: elapsed,
      ...metrics,
      socketConnectCount: collected.socketConnectCount,
      reloadCount: collected.reloadCount,
      jsErrors: collected.jsErrors.length,
      featurePolicyWarnings: collected.featurePolicy.length,
      clearSiteDataWarnings: collected.clearSiteData.length,
      sourceMapErrors: collected.sourceMapErrors.length,
    };
    snapshots.push(snapshot);
    console.log(`[soak] t=${minute}min (${elapsed}s): renders=${snapshot.renders} iframeCreates=${snapshot.iframeCreates} iframeRemoves=${snapshot.iframeRemoves} patches=${snapshot.inPlacePatches} heapUsed=${(snapshot.jsHeapUsed / 1024 / 1024).toFixed(1)}MB sockets=${snapshot.socketConnectCount} reloads=${snapshot.reloadCount} jsErrors=${snapshot.jsErrors} fpWarnings=${snapshot.featurePolicyWarnings}`);

    if (minute < SOAK_MINUTES) {
      // Exercise the UI during each minute
      const exercise = exercises[minute % exercises.length];
      try { await exercise(); } catch (e) { console.log(`[soak] exercise error: ${e.message}`); }
      // Resize to trigger ResizeObserver
      if (minute === 3) { await page.setViewportSize({ width: 1440, height: 900 }); await page.waitForTimeout(1000); await page.setViewportSize(VP); }
      if (minute === 7) { await page.setViewportSize({ width: 1366, height: 768 }); await page.waitForTimeout(1000); await page.setViewportSize(VP); }
      // Wait for the rest of the minute
      const waitMs = 60000 - (Date.now() - startTime - minute * 60000);
      if (waitMs > 0) await page.waitForTimeout(Math.min(waitMs, 60000));
    }
  }

  // Final acceptance checks
  const first = snapshots[0];
  const last = snapshots[snapshots.length - 1];
  console.log('\n[soak] === ACCEPTANCE ===');
  const checks = [
    ['No continuing iframe recreation (creates plateaued)', last.iframeCreates - first.iframeCreates <= 2],
    ['No iframe removal growth (removes plateaued)', last.iframeRemoves - first.iframeRemoves <= 2],
    ['No duplicate Socket.IO connections', collected.socketConnectCount <= 1],
    ['No unintended page reloads', collected.reloadCount <= 1],
    ['No JavaScript errors', collected.jsErrors.length === 0],
    ['No Feature Policy warnings', collected.featurePolicy.length === 0],
    ['No Clear-Site-Data warnings', collected.clearSiteData.length === 0],
    ['No application-owned source-map errors', collected.sourceMapErrors.filter(m => !/installHook/i.test(m)).length === 0],
    ['Memory stable (heap growth < 50MB)', (last.jsHeapUsed - first.jsHeapUsed) < 50 * 1024 * 1024],
  ];
  let allPass = true;
  for (const [name, pass] of checks) {
    console.log(`  ${pass ? 'PASS' : 'FAIL'}: ${name}`);
    if (!pass) allPass = false;
  }
  console.log(`\n[soak] RESULT: ${allPass ? 'ALL CHECKS PASSED' : 'SOME CHECKS FAILED'}`);

  // Cleanup
  await browser.close();
  killServer();
  if (tmpDir) { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} }
  console.log('[soak] Cleanup complete (temp DB + browser profile destroyed)');

  process.exit(allPass ? 0 : 1);
})().catch((err) => {
  console.error('[soak] FATAL:', err);
  killServer();
  if (tmpDir) { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} }
  process.exit(1);
});
