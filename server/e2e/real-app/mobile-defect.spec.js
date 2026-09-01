'use strict';

// Mobile defect reproduction + acceptance test.
// Boots the REAL Media Control server, logs in, opens the operator console,
// and audits computed styles / DOM at iPhone viewports.
//
// Proves:
//   1. `.mc-cc-target` (target-nav host) is NOT hidden (display:none) on phones.
//   2. Target wall tabs are visible and 48px-class tappable.
//   3. Content Library is reachable on mobile (not display:none).
//   4. No horizontal page overflow.
//   5. Transport touch targets >= 44px.
//
// Runs on Chromium AND WebKit (iPhone emulation).

const { test, expect } = require('@playwright/test');
const { spawn, execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const SERVER_DIR = path.resolve(__dirname, '..', '..');
const PORT = 18098;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const JWT_SECRET = 'mobile-repro-test-jwt-secret-hs256-min-length-ok';
const TEST_EMAIL = 'mobile@test.local';
const TEST_PASSWORD = 'mobile-test-password';

let serverProcess = null;
let tmpDir = '';
let authToken = '';
let userId = '';

function killServer() {
  if (!serverProcess) return;
  try {
    if (process.platform === 'win32') {
      execSync(`taskkill /pid ${serverProcess.pid} /T /F`, { stdio: 'ignore' });
    } else {
      process.kill(serverProcess.pid, 'SIGKILL');
    }
  } catch { /* best-effort */ }
  serverProcess = null;
}

async function startServer() {
  killServer();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-mobile-'));
  const dbPath = path.join(tmpDir, 'test.db');
  const env = {
    ...process.env,
    PORT: String(PORT),
    DB_PATH: dbPath,
    JWT_SECRET,
    NODE_ENV: 'development',
    DISABLE_REGISTRATION: 'false',
    SELF_HOSTED: 'true',
    ENTERPRISE_OPERATOR_UI_ENABLED: 'true',
    ENTERPRISE_OPERATOR_UI_USERS: '',
    PLAYER_DEBUG_REPORTING: 'off',
    CLASSROOM_MODE_ENABLED: 'false',
  };
  serverProcess = spawn(process.execPath, ['server.js'], {
    cwd: SERVER_DIR, env, stdio: ['pipe', 'pipe', 'pipe'],
  });
  const logs = [];
  serverProcess.stderr.on('data', (d) => logs.push(d.toString()));
  const start = Date.now();
  while (Date.now() - start < 45000) {
    if (serverProcess.exitCode !== null && serverProcess.exitCode !== undefined) {
      throw new Error(`Server exited code=${serverProcess.exitCode}\n${logs.slice(-30).join('')}`);
    }
    try {
      const r = await fetch(`${BASE_URL}/api/version`);
      if (r.ok) return;
    } catch { /* wait */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('Server did not start');
}

async function registerAndAuth() {
  const reg = await fetch(`${BASE_URL}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: TEST_EMAIL, password: TEST_PASSWORD, name: 'Mobile Test' }),
  });
  const regData = await reg.json();
  authToken = regData.token;
  userId = regData.user.id;
  // Authorize the user for enterprise UI.
  killServer();
  const env = {
    ...process.env,
    PORT: String(PORT),
    DB_PATH: path.join(tmpDir, 'test.db'),
    JWT_SECRET,
    NODE_ENV: 'development',
    DISABLE_REGISTRATION: 'true',
    SELF_HOSTED: 'true',
    ENTERPRISE_OPERATOR_UI_ENABLED: 'true',
    ENTERPRISE_OPERATOR_UI_USERS: userId,
    PLAYER_DEBUG_REPORTING: 'off',
    CLASSROOM_MODE_ENABLED: 'false',
  };
  serverProcess = spawn(process.execPath, ['server.js'], {
    cwd: SERVER_DIR, env, stdio: ['pipe', 'pipe', 'pipe'],
  });
  const start = Date.now();
  while (Date.now() - start < 45000) {
    if (serverProcess.exitCode !== null) throw new Error('Server exited on restart');
    try { const r = await fetch(`${BASE_URL}/api/version`); if (r.ok) return; } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('Server did not restart');
}

function seedCommandCenterFixture() {
  const Database = require('better-sqlite3');
  const database = new Database(path.join(tmpDir, 'test.db'), { timeout: 10000 });
  database.pragma('busy_timeout = 10000');
  try {
    const workspaceId = database.prepare(
      'SELECT workspace_id FROM workspace_members WHERE user_id = ? LIMIT 1'
    ).get(userId)?.workspace_id;
    if (!workspaceId) throw new Error('Mobile fixture workspace was not resolved');
    // The dual-browser suite is intentionally serial and can run for several
    // minutes. Keep the synthetic wall inside the online freshness window for
    // the whole run; no real device heartbeat exists in this isolated fixture.
    const now = Math.floor(Date.now() / 1000) + 3600;
    database.transaction(() => {
      const insertDevice = database.prepare(`
        INSERT INTO devices (id, user_id, workspace_id, name, pairing_code, status, last_heartbeat, wall_id, screen_on)
        VALUES (?, ?, ?, ?, ?, 'online', ?, 'mobile-command-wall', 1)
      `);
      for (const [index, name] of ['Front Left', 'Front Center', 'Front Right'].entries()) {
        const id = `mobile-wall-display-${index + 1}`;
        insertDevice.run(id, userId, workspaceId, name, `82000${index + 1}`, now);
        database.prepare(`
          INSERT INTO display_states
            (target_type, target_id, workspace_id, screen_on, command_revision, state_revision, updated_at)
          VALUES ('display', ?, ?, 1, 'fixture-on', 1, ?)
        `).run(id, workspaceId, Date.now());
      }
      database.prepare(`
        INSERT INTO video_walls (id, user_id, workspace_id, name, grid_cols, grid_rows, is_locked, layout_mode)
        VALUES ('mobile-command-wall', ?, ?, 'Classroom 1 Primary Wall', 3, 1, 1, 'span')
      `).run(userId, workspaceId);
      database.prepare(`
        INSERT INTO video_wall_devices
          (wall_id, device_id, grid_col, grid_row, canvas_x, canvas_y, canvas_width, canvas_height)
        VALUES
          ('mobile-command-wall', 'mobile-wall-display-1', 0, 0, 0, 0, 1920, 1080),
          ('mobile-command-wall', 'mobile-wall-display-2', 1, 0, 1920, 0, 1920, 1080),
          ('mobile-command-wall', 'mobile-wall-display-3', 2, 0, 3840, 0, 1920, 1080)
      `).run();
    })();
  } finally {
    database.close();
  }
}

async function openAuthedControl(browser, contextOptions = {}) {
  const context = await browser.newContext({ serviceWorkers: 'block', ...contextOptions });
  const page = await context.newPage();
  await page.addInitScript(({ token, user }) => {
    localStorage.setItem('token', token);
    localStorage.setItem('user', JSON.stringify(user));
    localStorage.setItem('rd_onboarded', '1');
  }, { token: authToken, user: { id: userId, email: TEST_EMAIL, name: 'Mobile Test', role: 'platform_admin' } });
  await page.goto(`${BASE_URL}/app#/control`, { waitUntil: 'networkidle' });
  await expect(page.locator('.mc-cc-shell')).toBeVisible();
  await expect(page.locator('.mc-target-wall-btn').first()).toBeVisible();
  return { context, page };
}

async function waitForCommandCenterVisualReady(page) {
  await page.evaluate(async () => {
    if (document.fonts && document.fonts.ready) await document.fonts.ready;
    await Promise.all(Array.from(document.images, (image) => {
      if (image.complete) return undefined;
      return new Promise((resolve) => {
        image.addEventListener('load', resolve, { once: true });
        image.addEventListener('error', resolve, { once: true });
      });
    }));
  });

  await expect.poll(async () => page.locator('.mc-cam-health-label').textContent())
    .not.toMatch(/^\s*(?:Checking cameras)?\s*$/);
  await expect.poll(async () => page.locator('[data-live-state]').textContent())
    .not.toMatch(/^\s*(?:—)?\s*$/);

  const deadline = Date.now() + 15000;
  let previousGeometry = '';
  let stableSamples = 0;
  while (Date.now() < deadline) {
    const geometry = await page.evaluate(() => {
      const selectors = [
        '.mc-cc-main',
        '.mc-stage.mc-cc-canvas',
        '.mc-wall-grid',
        '.mc-cc-controls',
        '.mc-action-dock',
      ];
      return selectors.map((selector) => {
        const element = document.querySelector(selector);
        if (!element) return `${selector}:missing`;
        const box = element.getBoundingClientRect();
        return [selector, box.x, box.y, box.width, box.height]
          .map((value) => typeof value === 'number' ? value.toFixed(2) : value)
          .join(':');
      }).join('|');
    });
    stableSamples = geometry === previousGeometry ? stableSamples + 1 : 1;
    if (stableSamples >= 4) return;
    previousGeometry = geometry;
    await page.waitForTimeout(250);
  }
  throw new Error('Command Center geometry did not settle before visual capture');
}

async function waitForLibraryDrawerSettled(page) {
  const drawer = page.locator('#mc-library-drawer');
  await expect.poll(async () => drawer.evaluate((element) => {
    const box = element.getBoundingClientRect();
    return Math.abs(box.bottom - window.innerHeight);
  })).toBeLessThanOrEqual(1);
}

test.describe.configure({ mode: 'serial' });

test.describe('Mobile operator console — defect reproduction + acceptance', () => {
  test.beforeAll(async () => {
    await startServer();
    await registerAndAuth();
    seedCommandCenterFixture();
  });
  test.afterAll(() => { killServer(); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} });

  // iPhone portrait + landscape + tablet viewports.
  const VIEWPORTS = [
    { name: 'iPhone-SE-375x667', width: 375, height: 667 },
    { name: 'iPhone-12-390x844', width: 390, height: 844 },
    { name: 'iPhone-14-393x852', width: 393, height: 852 },
    { name: 'Pixel-412x915', width: 412, height: 915 },
    { name: 'iPhone-14-Pro-Max-430x932', width: 430, height: 932 },
    { name: 'iPad-768x1024', width: 768, height: 1024 },
    { name: 'iPhone-12-land-844x390', width: 844, height: 390 },
    { name: 'iPhone-14-land-932x430', width: 932, height: 430 },
  ];

  for (const vp of VIEWPORTS) {
    test(`[${vp.name}] target nav host .mc-cc-target is visible (not display:none)`, async ({ browser }) => {
      const context = await browser.newContext({
        viewport: { width: vp.width, height: vp.height },
        deviceScaleFactor: 2,
        isMobile: true,
        hasTouch: true,
      });
      const page = await context.newPage();
      await page.addInitScript(({ token, user }) => {
        localStorage.setItem('token', token);
        localStorage.setItem('user', JSON.stringify(user));
        localStorage.setItem('rd_onboarded', '1');
      }, { token: authToken, user: { id: userId, email: TEST_EMAIL, name: 'Mobile Test', role: 'platform_admin' } });
      await page.goto(`${BASE_URL}/app#/control`, { waitUntil: 'networkidle' });
      await page.waitForTimeout(2500);

      const targetHost = page.locator('.mc-cc-target').first();
      await expect(targetHost).toBeAttached();
      const display = await targetHost.evaluate((el) => window.getComputedStyle(el).display);
      // The host must NOT be display:none — that is the root defect.
      expect(display, `.mc-cc-target display at ${vp.width}px must not be none`).not.toBe('none');
      await context.close();
    });

    test(`[${vp.name}] target wall tabs are visible and >=48px`, async ({ browser }) => {
      const context = await browser.newContext({
        viewport: { width: vp.width, height: vp.height },
        deviceScaleFactor: 2, isMobile: true, hasTouch: true,
      });
      const page = await context.newPage();
      await page.addInitScript(({ token, user }) => {
        localStorage.setItem('token', token);
        localStorage.setItem('user', JSON.stringify(user));
        localStorage.setItem('rd_onboarded', '1');
      }, { token: authToken, user: { id: userId, email: TEST_EMAIL, name: 'Mobile Test', role: 'platform_admin' } });
      await page.goto(`${BASE_URL}/app#/control`, { waitUntil: 'networkidle' });
      await page.waitForTimeout(2000);
      const tabs = page.locator('.mc-target-wall-btn');
      const count = await tabs.count();
      if (count > 0) {
        const firstTab = tabs.first();
        await expect(firstTab).toBeVisible();
        const box = await firstTab.boundingBox();
        expect(box.height, `wall tab height at ${vp.width}px`).toBeGreaterThanOrEqual(48);
      }
      await context.close();
    });

    test(`[${vp.name}] no horizontal page overflow`, async ({ browser }) => {
      const context = await browser.newContext({
        viewport: { width: vp.width, height: vp.height },
        deviceScaleFactor: 2, isMobile: true, hasTouch: true,
      });
      const page = await context.newPage();
      await page.addInitScript(({ token, user }) => {
        localStorage.setItem('token', token);
        localStorage.setItem('user', JSON.stringify(user));
        localStorage.setItem('rd_onboarded', '1');
      }, { token: authToken, user: { id: userId, email: TEST_EMAIL, name: 'Mobile Test', role: 'platform_admin' } });
      await page.goto(`${BASE_URL}/app#/control`, { waitUntil: 'networkidle' });
      await page.waitForTimeout(2000);
      const overflow = await page.evaluate(() => ({
        scrollW: document.documentElement.scrollWidth,
        clientW: document.documentElement.clientWidth,
      }));
      expect(overflow.scrollW, `scrollWidth must not exceed clientWidth at ${vp.width}px`)
        .toBeLessThanOrEqual(overflow.clientW + 2);
      await context.close();
    });
  }

  test('Content Library is reachable on mobile (not display:none on body)', async ({ browser }) => {
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true,
    });
    const page = await context.newPage();
    await page.addInitScript(({ token, user }) => {
        localStorage.setItem('token', token);
        localStorage.setItem('user', JSON.stringify(user));
        localStorage.setItem('rd_onboarded', '1');
      }, { token: authToken, user: { id: userId, email: TEST_EMAIL, name: 'Mobile Test', role: 'platform_admin' } });
    await page.goto(`${BASE_URL}/app#/control`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(2000);
    // The library drawer host must exist; when opened it must be visible.
    const drawer = page.locator('#mc-library-drawer').first();
    await expect(drawer).toBeAttached();
    // Toggle open if there's a tab.
    const libTab = page.locator('[data-library-toggle]').first();
    if (await libTab.isVisible().catch(() => false)) {
      await libTab.click();
      await page.waitForTimeout(800);
    }
    const display = await drawer.evaluate((el) => window.getComputedStyle(el).display);
    expect(display, 'library drawer must not be permanently display:none on mobile').not.toBe('none');
    await context.close();
  });

  test('bottom Content Library shelf preserves stage and wall geometry while open', async ({ browser }, testInfo) => {
    const { context, page } = await openAuthedControl(browser, {
      viewport: { width: 838, height: 500 },
      deviceScaleFactor: 1,
      isMobile: false,
      hasTouch: true,
    });
    await waitForCommandCenterVisualReady(page);

    const measureStage = () => page.evaluate(() => {
      const rect = (element) => {
        const box = element?.getBoundingClientRect();
        return box ? { x: box.x, y: box.y, width: box.width, height: box.height } : null;
      };
      return {
        stage: rect(document.querySelector('.mc-stage.mc-cc-canvas')),
        cells: Array.from(document.querySelectorAll('.mc-wall-cell')).map(rect),
      };
    });

    const before = await measureStage();
    const shelf = page.locator('#mc-library-drawer');
    const handle = shelf.locator(':scope > [data-library-toggle]');
    const handleBox = await handle.boundingBox();
    const collapsedStyle = await shelf.evaluate((element) => ({
      position: getComputedStyle(element).position,
      open: element.dataset.open,
    }));

    expect(collapsedStyle).toEqual({ position: 'fixed', open: 'false' });
    expect(handleBox.height).toBeGreaterThanOrEqual(48);
    expect(handleBox.height).toBeLessThanOrEqual(64);
    expect(handleBox.width).toBeGreaterThanOrEqual(148);
    expect(handleBox.width).toBeLessThanOrEqual(190);
    expect(handleBox.y + handleBox.height).toBeLessThanOrEqual(501);

    await handle.click();
    await expect(shelf).toHaveAttribute('data-open', 'true');
    await waitForLibraryDrawerSettled(page);
    const after = await measureStage();

    for (const key of ['x', 'y', 'width', 'height']) {
      expect(Math.abs(after.stage[key] - before.stage[key]), `stage ${key} delta`).toBeLessThanOrEqual(1);
    }
    expect(after.cells.length).toBe(before.cells.length);
    for (let index = 0; index < before.cells.length; index += 1) {
      for (const key of ['x', 'y', 'width', 'height']) {
        expect(Math.abs(after.cells[index][key] - before.cells[index][key]), `wall cell ${index} ${key} delta`).toBeLessThanOrEqual(1);
      }
    }

    const expandedBox = await shelf.boundingBox();
    expect(expandedBox.width).toBeGreaterThanOrEqual(764);
    expect(expandedBox.height).toBeGreaterThanOrEqual(180);
    expect(expandedBox.y + expandedBox.height).toBeLessThanOrEqual(501);
    expect(await page.locator('.mc-library-backdrop, [data-library-backdrop]').count()).toBe(0);
    expect(await page.locator('.mc-stage.mc-cc-canvas').getAttribute('inert')).toBeNull();
    expect(await page.locator('.mc-stage.mc-cc-canvas').getAttribute('aria-hidden')).toBeNull();

    const stageHit = await page.locator('.mc-stage.mc-cc-canvas').evaluate((stage) => {
      const box = stage.getBoundingClientRect();
      const hit = document.elementFromPoint(box.left + box.width / 2, box.top + 8);
      return hit === stage || stage.contains(hit);
    });
    expect(stageHit, 'the uncovered stage remains pointer-interactive while the shelf is open').toBe(true);

    const overflow = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      innerWidth: window.innerWidth,
    }));
    expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.innerWidth + 2);
    await page.screenshot({ path: testInfo.outputPath('command-center-bottom-shelf-open.png'), fullPage: true });
    await context.close();
  });

  test('expanded Lenovo shelf keeps the stage and persistent safety controls unobscured', async ({ browser }, testInfo) => {
    const { context, page } = await openAuthedControl(browser, {
      viewport: { width: 838, height: 500 },
      deviceScaleFactor: 1,
      isMobile: false,
      hasTouch: true,
    });
    await page.route('**/api/live-stream/operator-state*', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          stream_state: 'on_air',
          stream_active: true,
          recording_state: 'active',
          recording_active: true,
          publisher: { active: true, mode: 'fixed_compositor' },
          capabilities: { stream_state: 'on_air' },
          camera_edge: {
            anpviz_stream: true,
            active_source: 'anpviz',
            microphone_connected: true,
            recording_active: true,
          },
        }),
      });
    });
    await page.reload({ waitUntil: 'networkidle' });
    await waitForCommandCenterVisualReady(page);
    await expect(page.locator('[data-dock="stop-live"]')).toBeVisible();
    await expect(page.locator('#mc-dock-record-btn')).toHaveText('Stop Recording');

    const measureStage = () => page.locator('.mc-stage.mc-cc-canvas').evaluate((stage) => {
      const box = stage.getBoundingClientRect();
      return { x: box.x, y: box.y, width: box.width, height: box.height };
    });
    const before = await measureStage();
    await page.locator('#mc-library-drawer > [data-library-toggle]').click();
    await expect(page.locator('#mc-library-drawer')).toHaveAttribute('data-open', 'true');
    await waitForLibraryDrawerSettled(page);
    const after = await measureStage();
    for (const key of ['x', 'y', 'width', 'height']) {
      expect(Math.abs(after[key] - before[key]), `stage ${key} delta`).toBeLessThanOrEqual(1);
    }
    expect(after.width, 'the stage uses the width reclaimed from the removed left rail').toBeGreaterThanOrEqual(800);

    const geometry = await page.evaluate(() => {
      const rect = (element) => {
        const box = element.getBoundingClientRect();
        return { left: box.left, top: box.top, right: box.right, bottom: box.bottom, width: box.width, height: box.height };
      };
      const overlaps = (a, b) => a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
      const visible = (element) => {
        const style = getComputedStyle(element);
        const box = element.getBoundingClientRect();
        return !element.hidden && style.display !== 'none' && style.visibility !== 'hidden' && box.width > 0 && box.height > 0;
      };
      const shelf = rect(document.querySelector('#mc-library-drawer'));
      const stageElement = document.querySelector('.mc-stage.mc-cc-canvas');
      const stage = rect(stageElement);
      const stripElement = document.querySelector('.mc-persistent-controls') || document.querySelector('.mc-cc-controls');
      const strip = rect(stripElement);
      const dropSelector = [
        '.mc-wall-region[data-layout-group-id][data-wall-id]',
        '.mc-display-card[data-device-id]',
        '.mc-wall-cell[data-device-id]',
        '.mc-wall-split-half[data-device-id][data-split-half]',
        '.mc-wall-all[data-wall-ids]',
        '.mc-wall-group-region[data-layout-group-id][data-wall-id]',
        '.mc-wall[data-wall-id]',
        '.mc-display-card-tile[data-display-id]',
      ].join(',');
      const targets = Array.from(stageElement.querySelectorAll(dropSelector)).filter(visible).map((element) => {
        const box = rect(element);
        const x = Math.min(innerWidth - 1, Math.max(0, box.left + box.width / 2));
        const y = Math.min(innerHeight - 1, Math.max(0, box.top + box.height / 2));
        const hit = document.elementFromPoint(x, y);
        return {
          box,
          inViewport: box.left >= 0 && box.top >= 0 && box.right <= innerWidth && box.bottom <= innerHeight,
          unobscured: !overlaps(box, shelf) && !!hit && stageElement.contains(hit),
          hit: hit ? `${hit.tagName}.${hit.className || ''}` : null,
        };
      });
      return {
        shelf,
        stage,
        strip,
        stageShelfOverlap: overlaps(stage, shelf),
        stripShelfOverlap: overlaps(strip, shelf),
        targetCount: targets.length,
        targets,
      };
    });
    expect(geometry.targetCount, 'at least one visible stage drop target is required').toBeGreaterThan(0);
    expect(geometry.stageShelfOverlap, `stage ${JSON.stringify(geometry.stage)} vs shelf ${JSON.stringify(geometry.shelf)}`).toBe(false);
    expect(geometry.stripShelfOverlap, `strip ${JSON.stringify(geometry.strip)} vs shelf ${JSON.stringify(geometry.shelf)}`).toBe(false);
    for (const [index, target] of geometry.targets.entries()) {
      expect(target.inViewport, `drop target ${index} remains fully inside the viewport`).toBe(true);
      expect(target.unobscured, `drop target ${index} ${JSON.stringify(target)} remains hit-testable above the shelf`).toBe(true);
    }

    const persistentButtons = [
      '[data-cc-tp="prev"]',
      '[data-cc-tp="restart"]',
      '[data-cc-tp="play_pause"]',
      '[data-cc-tp="next"]',
      '#mc-dock-blank-btn',
      '[data-dock="stop-live"]',
      '#mc-dock-record-btn',
    ];
    await page.evaluate((selectors) => {
      window.__mcPersistentAcceptanceClicks = [];
      selectors.forEach((selector) => {
        document.querySelector(selector)?.addEventListener('click', (event) => {
          event.preventDefault();
          event.stopImmediatePropagation();
          window.__mcPersistentAcceptanceClicks.push(selector);
        }, { capture: true, once: true });
      });
    }, persistentButtons);
    for (const selector of persistentButtons) {
      const button = page.locator(selector);
      await expect(button, `${selector} remains visible with the shelf expanded`).toBeVisible();
      const box = await button.boundingBox();
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.y).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(839);
      expect(box.y + box.height).toBeLessThanOrEqual(501);
      expect(box.width, `${selector} preserves a touch-safe width`).toBeGreaterThanOrEqual(48);
      expect(box.height, `${selector} preserves a touch-safe height`).toBeGreaterThanOrEqual(48);
      expect(box.y + box.height, `${selector} ends before the shelf begins`).toBeLessThanOrEqual(geometry.shelf.top + 1);
      await button.focus();
      await expect(button).toBeFocused();
      await button.click();
    }
    expect(await page.evaluate(() => window.__mcPersistentAcceptanceClicks)).toEqual(persistentButtons);
    await page.screenshot({ path: testInfo.outputPath('command-center-lenovo-expanded-persistent-controls.png'), fullPage: true });
    await context.close();
  });

  test('six-category shelf uses detected MIME and keeps Screensavers as a clearable Images filter', async ({ browser }, testInfo) => {
    const { context, page } = await openAuthedControl(browser, {
      viewport: { width: 838, height: 500 },
      deviceScaleFactor: 1,
      isMobile: false,
      hasTouch: true,
    });
    const contentRequests = [];
    const content = [
      { id: 'video-detected', filename: 'detected-video.jpg', mime_type: 'image/jpeg', detected_mime_type: 'video/mp4' },
      { id: 'image-detected', filename: 'detected-image.bin', mime_type: 'application/octet-stream', media: { detected_mime_type: 'image/png' } },
      { id: 'pdf-detected', filename: 'runbook.bin', mime_type: 'application/octet-stream', detected_mime_type: 'application/pdf' },
      { id: 'office-detected', filename: 'briefing.bin', mime_type: 'application/octet-stream', media: { detected_mime_type: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' } },
      { id: 'odf-detected', filename: 'staffing.bin', mime_type: 'application/octet-stream', detected_mime_type: 'application/vnd.oasis.opendocument.spreadsheet' },
      { id: 'unsupported-app', filename: 'archive.zip', mime_type: 'application/zip' },
      { id: 'standalone-audio', filename: 'dispatch-audio.mp3', mime_type: 'audio/mpeg', detected_mime_type: 'audio/mpeg' },
    ];
    await page.route('**/api/content*', async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname !== '/api/content') return route.continue();
      contentRequests.push(url.toString());
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(content) });
    });
    await page.route('**/api/presentations*', async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname !== '/api/presentations') return route.continue();
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([{ id: 'deck-1', title: 'Incident Command Deck' }]) });
    });
    await page.reload({ waitUntil: 'networkidle' });
    await waitForCommandCenterVisualReady(page);
    await page.locator('#mc-library-drawer > [data-library-toggle]').click();

    const tabs = page.locator('.mc-tb-tab');
    await expect(tabs).toHaveCount(6);
    expect(await tabs.allTextContents()).toEqual(['Videos', 'Images', 'Docs', 'Sources', 'Live Feeds', 'Additional Controls']);
    await expect(page.locator('.mc-tb-tab[aria-selected="true"]')).toHaveCount(1);
    await expect(page.locator('.mc-tb-tab[aria-selected="true"]')).toHaveText('Videos');
    await expect(page.locator('#mc-toolbox .mc-tile-label')).toHaveText(['detected-video.jpg']);
    await page.screenshot({ path: testInfo.outputPath('command-center-six-category-shelf.png'), fullPage: true });

    await page.locator('.mc-tb-tab[data-tab="images"]').click();
    await expect(page.locator('#mc-toolbox .mc-tile-label')).toHaveText(['detected-image.bin']);

    await page.locator('.mc-tb-tab[data-tab="docs"]').click();
    await expect(page.locator('#mc-toolbox .mc-tile-label')).toHaveText([
      'runbook.bin',
      'briefing.bin',
      'staffing.bin',
      'Incident Command Deck',
    ]);
    await expect(page.locator('#mc-toolbox')).not.toContainText('archive.zip');
    await expect(page.locator('#mc-toolbox')).not.toContainText('dispatch-audio.mp3');

    await page.locator('.mc-tb-tab[data-tab="additional"]').click();
    await page.locator('.mc-cc-controls .mc-cc-saver-select').selectOption('folder:Screensavers');
    await expect(page.locator('.mc-tb-tab[data-tab="images"]')).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('[data-context-filter="Screensavers"]')).toContainText('Screensavers');
    await expect(page.locator('[data-clear-context-filter]')).toBeVisible();
    expect(contentRequests.some((url) => new URL(url).searchParams.get('folder') === 'Screensavers')).toBe(true);
    await page.locator('[data-clear-context-filter]').click();
    await expect(page.locator('[data-context-filter]')).toHaveCount(0);
    expect(new URL(contentRequests.at(-1)).searchParams.has('folder')).toBe(false);
    expect(await page.locator('.mc-tb-tab').allTextContents()).not.toContain('Screensavers');
    await context.close();
  });

  test('Sources and Live Feeds use disjoint catalogs and one managed refresh lifecycle', async ({ browser }) => {
    const { context, page } = await openAuthedControl(browser, {
      viewport: { width: 838, height: 500 },
      deviceScaleFactor: 1,
      isMobile: false,
      hasTouch: true,
    });
    const managedRequestTimes = [];
    await page.route('**/api/live-sources*', async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname !== '/api/live-sources') return route.continue();
      managedRequestTimes.push(Date.now());
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          edge_available: true,
          sources: [
            { id: 'anpviz', available: true, signal: { video_online: true, microphone_connected: true, audio_online: true } },
            { id: 'podium-computer', available: true, signal: { resolution: '1920x1080', frame_rate: 60, embedded_audio_detected: true } },
            { id: 'guest-computer', available: false, signal: { resolution: null, frame_rate: null, embedded_audio_detected: false } },
          ],
        }),
      });
    });
    await page.reload({ waitUntil: 'networkidle' });
    await waitForCommandCenterVisualReady(page);
    await page.locator('#mc-library-drawer > [data-library-toggle]').click();
    await page.locator('.mc-tb-tab[data-tab="sources"]').click();

    const sourceTiles = page.locator('#mc-toolbox .mc-live-source-tile');
    await expect(sourceTiles).toHaveCount(3);
    await expect(sourceTiles.locator('.mc-tile-label')).toHaveText([
      'Anpviz Camera',
      'Podium Computer',
      'Guest Computer',
    ]);
    expect(await sourceTiles.evaluateAll((items) => items.map((item) => ({
      label: item.querySelector('.mc-tile-label')?.textContent?.trim(),
      disabled: item.disabled,
      draggable: item.getAttribute('draggable'),
      hasPayload: item.hasAttribute('data-drag-source'),
    })))).toEqual([
      { label: 'Anpviz Camera', disabled: false, draggable: 'true', hasPayload: true },
      { label: 'Podium Computer', disabled: false, draggable: 'true', hasPayload: true },
      { label: 'Guest Computer', disabled: true, draggable: null, hasPayload: false },
    ]);
    await expect(page.locator('#mc-toolbox .mc-live-news-tile')).toHaveCount(0);
    await expect(page.locator('#mc-toolbox')).not.toContainText('CBS News Miami');
    await expect(page.locator('#mc-toolbox')).not.toContainText('1st Street Beach');
    await expect.poll(() => managedRequestTimes.length, { timeout: 7_000 }).toBe(2);
    expect(managedRequestTimes[1] - managedRequestTimes[0], 'managed catalog retains its five-second cadence').toBeGreaterThanOrEqual(4_500);

    await page.locator('.mc-tb-tab[data-tab="livefeeds"]').click();
    await expect(page.locator('#mc-toolbox .mc-live-source-tile')).toHaveCount(0);
    await expect(page.locator('#mc-toolbox .mc-live-news-tile')).toHaveCount(12);
    await expect(page.locator('#mc-toolbox')).toContainText('CBS News Miami');
    await expect(page.locator('#mc-toolbox')).toContainText('1st Street Beach');
    const requestsAtLiveFeeds = managedRequestTimes.length;
    await page.waitForTimeout(5_500);
    expect(managedRequestTimes.length, 'public Live Feeds does not start or retain a managed-source poller').toBe(requestsAtLiveFeeds);
    await context.close();
  });

  test('Multiview v1 storage retains Screen Share and geometry while translating known absolute legacy Zowie URLs to Podium', async ({ browser }) => {
    const { context, page } = await openAuthedControl(browser, {
      viewport: { width: 838, height: 500 },
      deviceScaleFactor: 1,
      isMobile: false,
      hasTouch: true,
    });
    await page.evaluate(() => {
      localStorage.removeItem('mc_multiview_cells_v2');
      localStorage.removeItem('mc_multiview_geoms_v2');
      localStorage.setItem('mc_multiview_cells_v1', JSON.stringify({
        C1: {
          cellUrl: 'https://media.mbfdhub.com/player/live-source.html?source=guest-computer&fit=cover',
          monitorUrl: 'https://media-control.mbfdhub.com/player/live-source.html?source=guest-computer&audio=1',
          kind: 'i',
          label: 'Legacy Zowie',
        },
        C2: {
          cellUrl: null,
          monitorUrl: null,
          kind: 'share',
          label: 'Screen Share',
          deviceIds: ['mobile-wall-display-1'],
        },
      }));
      localStorage.setItem('mc_multiview_geoms_v1', JSON.stringify({
        C1: { x: 25, y: 0, w: 50, h: 50 },
        C2: { x: 25, y: 50, w: 50, h: 50 },
      }));
    });
    await page.reload({ waitUntil: 'networkidle' });
    await waitForCommandCenterVisualReady(page);
    await page.locator('#mc-library-drawer > [data-library-toggle]').click();
    await page.locator('.mc-tb-tab[data-tab="additional"]').click();
    await page.locator('[data-dock="multiview"]').click();
    await expect(page.locator('.mc-multiview-host:not([hidden]) .mc-mv-stage')).toBeVisible();

    const persisted = await page.evaluate(() => ({
      cells: JSON.parse(localStorage.getItem('mc_multiview_cells_v2') || '{}'),
      geoms: JSON.parse(localStorage.getItem('mc_multiview_geoms_v2') || '{}'),
    }));
    expect(persisted.cells.C1).toMatchObject({
      cellUrl: '/player/live-source.html?source=podium-computer&fit=cover',
      monitorUrl: '/player/live-source.html?source=podium-computer&audio=1',
      kind: 'i',
      label: 'Legacy Zowie',
    });
    expect(persisted.cells.C2).toMatchObject({
      cellUrl: null,
      monitorUrl: null,
      kind: 'share',
      label: 'Screen Share',
      deviceIds: ['mobile-wall-display-1'],
    });
    expect(persisted.geoms).toEqual({
      C1: { x: 25, y: 0, w: 50, h: 50 },
      C2: { x: 25, y: 50, w: 50, h: 50 },
    });
    await context.close();
  });

  test('one action controller keeps safety stops persistent and secondary actions in Additional Controls', async ({ browser }, testInfo) => {
    const { context, page } = await openAuthedControl(browser, {
      viewport: { width: 838, height: 500 },
      deviceScaleFactor: 1,
      isMobile: false,
      hasTouch: true,
    });
    let operatorMode = 'idle';
    let operatorRequests = 0;
    await page.route('**/api/live-stream/operator-state*', async (route) => {
      operatorRequests += 1;
      if (operatorMode === 'failed') {
        await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'unavailable' }) });
        return;
      }
      const active = operatorMode === 'active';
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          stream_state: active ? 'on_air' : 'ready',
          stream_active: active,
          recording_state: active ? 'active' : 'idle',
          recording_active: active,
          publisher: { active, mode: 'direct_camera' },
          capabilities: {
            stream_state: active ? 'on_air' : 'ready',
            publisher_mode: 'direct_camera',
            publisher_available: true,
            publisher_ready: true,
            operator_start_allowed: true,
          },
          camera_edge: {
            anpviz_stream: true,
            active_source: 'anpviz',
            microphone_connected: true,
            recording_active: active,
          },
        }),
      });
    });
    await page.reload({ waitUntil: 'networkidle' });
    await waitForCommandCenterVisualReady(page);
    await page.locator('#mc-library-drawer > [data-library-toggle]').click();
    await page.locator('.mc-tb-tab[data-tab="additional"]').click();

    const persistent = page.locator('.mc-action-dock-persistent');
    const secondary = page.locator('#mc-toolbox .mc-action-dock-secondary');
    await expect(persistent).toHaveCount(1);
    await expect(secondary).toHaveCount(1);
    await expect(page.locator('#mc-toolbox .mc-cc-sub-row')).toHaveCount(0);
    await expect(page.locator('.mc-cc-controls > .mc-cc-sub-row')).toBeVisible();
    await expect(persistent.locator('#mc-dock-blank-btn')).toBeVisible();
    await expect(persistent.locator('[data-dock="multiview"], [data-dock="whiteboard"], [data-dock="share"], [data-dock="start-live"]')).toHaveCount(0);
    await expect(secondary.locator('[data-dock="multiview"]')).toBeVisible();
    await expect(secondary.locator('[data-dock="whiteboard"]')).toBeVisible();
    await expect(secondary.locator('[data-dock="share"]')).toBeVisible();
    await expect(secondary.locator('#mc-dock-start-record-btn')).toBeEnabled();
    await expect(secondary.locator('[data-dock="start-live"]')).toBeEnabled();
    await expect(secondary.locator('[data-camera-health]')).toBeVisible();
    await expect(persistent.locator('.mc-cam-health-wrap')).toBeHidden();
    await expect(page.locator('#mc-toolbox h3', { hasText: /^Actions$/ })).toHaveCount(0);
    await expect(page.locator('#mc-toolbox')).toContainText('Playlists');
    await expect(page.locator('#mc-toolbox')).toContainText('Scenes');
    await expect(page.locator('#mc-broadcast-chip')).toHaveCount(1);
    await page.screenshot({ path: testInfo.outputPath('command-center-additional-controls.png'), fullPage: true });
    const requestsAfterAttach = operatorRequests;
    await page.waitForTimeout(5_500);
    expect(operatorRequests - requestsAfterAttach, 'attaching a second presentation host does not duplicate the poller').toBeLessThanOrEqual(1);

    operatorMode = 'active';
    await expect.poll(() => operatorRequests, { timeout: 7_000 }).toBeGreaterThan(requestsAfterAttach + 1);
    await expect(persistent.locator('[data-dock="stop-live"]')).toBeVisible();
    await expect(persistent.locator('#mc-dock-record-btn')).toBeVisible();
    await expect(persistent.locator('#mc-dock-record-btn')).toHaveText('Stop Recording');
    await expect(secondary.locator('[data-dock="start-live"]')).toBeHidden();
    await expect(secondary.locator('#mc-dock-start-record-btn')).toBeHidden();

    await page.locator('.mc-tb-tab[data-tab="videos"]').click();
    await page.locator('#mc-library-drawer > [data-library-toggle]').click();
    await expect(page.locator('#mc-library-drawer')).toHaveAttribute('data-open', 'false');
    await expect(persistent.locator('[data-dock="stop-live"]')).toBeVisible();
    await expect(persistent.locator('#mc-dock-record-btn')).toBeVisible();
    const persistentStrip = await page.locator('.mc-persistent-controls').boundingBox();
    expect(persistentStrip.height, 'the permanent operational strip stays compact').toBeLessThanOrEqual(52);
    await page.screenshot({ path: testInfo.outputPath('command-center-persistent-stops.png'), fullPage: true });

    operatorMode = 'failed';
    const requestsBeforeFailure = operatorRequests;
    await expect.poll(() => operatorRequests, { timeout: 7_000 }).toBeGreaterThan(requestsBeforeFailure);
    await expect(persistent.locator('[data-dock="stop-live"]')).toBeHidden();
    await expect(persistent.locator('#mc-dock-record-btn')).toBeHidden();
    await page.locator('#mc-library-drawer > [data-library-toggle]').click();
    await page.locator('.mc-tb-tab[data-tab="additional"]').click();
    await expect(page.locator('#mc-toolbox #mc-dock-start-record-btn')).toBeDisabled();
    await expect(page.locator('#mc-toolbox [data-dock="start-live"]')).toBeDisabled();
    await expect(page.locator('#mc-toolbox [data-camera-health] .mc-cam-health-label')).toContainText(/unavailable/i);
    await context.close();
  });

  test('Phase 5 visual checkpoint matches the approved Command Center composition', async ({ browser }, testInfo) => {
    const { context, page } = await openAuthedControl(browser, {
      viewport: { width: 1440, height: 900 },
      deviceScaleFactor: 1,
    });
    await page.route('**/api/content*', async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname !== '/api/content') return route.continue();
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([
          { id: 'visual-video-1', filename: 'Incident Command Briefing.mp4', mime_type: 'video/mp4', detected_mime_type: 'video/mp4' },
          { id: 'visual-video-2', filename: 'Extrication Training.mp4', mime_type: 'video/mp4', detected_mime_type: 'video/mp4' },
          { id: 'visual-image-1', filename: 'MBFD Wallpaper.png', mime_type: 'image/png', detected_mime_type: 'image/png' },
        ]),
      });
    });
    await page.route('**/api/live-sources*', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          edge_available: true,
          sources: [
            { id: 'anpviz', name: 'Anpviz Camera', type: 'camera', available: true },
            { id: 'podium-computer', name: 'Podium Computer', type: 'computer', available: true },
            { id: 'guest-computer', name: 'Guest Computer', type: 'computer', available: true },
          ],
        }),
      });
    });
    await page.reload({ waitUntil: 'networkidle' });
    await waitForCommandCenterVisualReady(page);

    await expect(page.locator('.mc-cc-rail')).toHaveCount(0);
    await expect(page.locator('.sidebar')).toBeVisible();
    await expect(page.locator('.mc-cc-overview .mc-wall-head:visible, .mc-cc-overview .mc-wall-hint:visible')).toHaveCount(0);
    await expect(page.locator('.mc-cc-controls > .mc-cc-sub-row')).toBeVisible();
    await expect(page.locator('.mc-action-dock-persistent .mc-cam-health-wrap')).toBeHidden();
    await expect(page.locator('.mc-action-dock-persistent .mc-live-ladder[data-state="ready"]')).toBeHidden();

    const desktopGeometry = await page.evaluate(() => {
      const stageElement = document.querySelector('.mc-stage.mc-cc-canvas');
      const stage = stageElement.getBoundingClientRect();
      const canvas = document.querySelector('.mc-cc-canvas-area').getBoundingClientRect();
      const main = document.querySelector('.mc-cc-main').getBoundingClientRect();
      const stageStyle = getComputedStyle(stageElement);
      const handle = document.querySelector('[data-library-toggle]').getBoundingClientRect();
      return {
        viewportWidth: innerWidth,
        mainWidth: main.width,
        canvasWidth: canvas.width,
        stageWidth: stage.width,
        stageHeight: stage.height,
        computedWidth: stageStyle.width,
        computedMaxWidth: stageStyle.maxWidth,
        computedHeight: stageStyle.height,
        computedAspectRatio: stageStyle.aspectRatio,
        handleWidth: handle.width,
      };
    });
    expect(desktopGeometry.stageWidth, JSON.stringify(desktopGeometry)).toBeGreaterThanOrEqual(1280);
    expect(desktopGeometry.handleWidth).toBeGreaterThanOrEqual(148);
    expect(desktopGeometry.handleWidth).toBeLessThanOrEqual(190);
    await page.screenshot({ path: testInfo.outputPath('phase5-main-collapsed-1440x900.png'), fullPage: true });

    const stageBeforeOpen = await page.locator('.mc-stage.mc-cc-canvas').boundingBox();
    const controlsBeforeOpen = await page.locator('.mc-cc-controls').boundingBox();
    await page.locator('#mc-library-drawer > [data-library-toggle]').click();
    await expect(page.locator('#mc-library-drawer')).toHaveAttribute('data-open', 'true');
    await waitForLibraryDrawerSettled(page);
    const stageAfterOpen = await page.locator('.mc-stage.mc-cc-canvas').boundingBox();
    const controlsAfterOpen = await page.locator('.mc-cc-controls').boundingBox();
    expect(stageAfterOpen).toEqual(stageBeforeOpen);
    expect(controlsAfterOpen).toEqual(controlsBeforeOpen);
    const tabs = page.locator('.mc-tb-tab');
    await expect(tabs).toHaveCount(6);
    expect(await tabs.allTextContents()).toEqual(['Videos', 'Images', 'Docs', 'Sources', 'Live Feeds', 'Additional Controls']);
    const tabGeometry = await page.evaluate(() => {
      const tabs = Array.from(document.querySelectorAll('.mc-tb-tab')).map((element) => element.getBoundingClientRect());
      return { firstLeft: tabs[0].left, lastRight: tabs[tabs.length - 1].right, maxWidth: Math.max(...tabs.map((box) => box.width)) };
    });
    expect(tabGeometry.firstLeft).toBeGreaterThanOrEqual(72);
    expect(tabGeometry.firstLeft).toBeLessThan(120);
    expect(tabGeometry.lastRight).toBeLessThan(720);
    expect(tabGeometry.maxWidth).toBeLessThan(180);
    await expect(page.locator('#mc-media-grid .mc-tile-cell')).toHaveCount(2);
    const openVideosGeometry = await page.evaluate(() => {
      const rect = (selector) => {
        const box = document.querySelector(selector)?.getBoundingClientRect();
        return box ? { top: box.top, bottom: box.bottom, width: box.width, height: box.height } : null;
      };
      return {
        shelf: rect('#mc-library-drawer'),
        controls: rect('.mc-cc-controls'),
        tiles: Array.from(document.querySelectorAll('#mc-media-grid .mc-tile-cell')).map((tile) => {
          const box = tile.getBoundingClientRect();
          return { top: box.top, bottom: box.bottom, width: box.width, height: box.height };
        }),
        viewportHeight: innerHeight,
      };
    });
    expect(openVideosGeometry.shelf?.height, JSON.stringify(openVideosGeometry)).toBeGreaterThanOrEqual(340);
    expect(openVideosGeometry.shelf?.top, JSON.stringify(openVideosGeometry)).toBeGreaterThanOrEqual(openVideosGeometry.controls.bottom);
    for (const tile of openVideosGeometry.tiles) {
      expect(tile.bottom, JSON.stringify(openVideosGeometry)).toBeLessThanOrEqual(openVideosGeometry.viewportHeight);
    }
    await page.screenshot({ path: testInfo.outputPath('phase5-videos-open-1440x900.png'), fullPage: true });

    await page.locator('.mc-tb-tab[data-tab="sources"]').click();
    await expect(page.locator('.mc-tb-tab[data-tab="sources"]')).toHaveAttribute('aria-selected', 'true');
    await page.screenshot({ path: testInfo.outputPath('phase5-sources-open-1440x900.png'), fullPage: true });

    await page.locator('.mc-tb-tab[data-tab="additional"]').click();
    await expect(page.locator('#mc-toolbox h3', { hasText: /^Actions$/ })).toHaveCount(0);
    await expect(page.locator('#mc-toolbox .mc-action-dock-secondary')).toBeVisible();
    await expect(page.locator('.mc-cc-controls > .mc-cc-sub-row')).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath('phase5-additional-open-1440x900.png'), fullPage: true });

    await page.setViewportSize({ width: 838, height: 500 });
    await expect(page.locator('#mc-library-drawer')).toHaveAttribute('data-open', 'true');
    await page.locator('.mc-tb-tab[data-tab="videos"]').click();
    await page.waitForTimeout(150);
    const lenovoGeometry = await page.evaluate(() => {
      const rect = (selector) => {
        const box = document.querySelector(selector)?.getBoundingClientRect();
        return box ? { top: box.top, bottom: box.bottom, width: box.width, height: box.height } : null;
      };
      return {
        stage: rect('.mc-stage.mc-cc-canvas'),
        wall: rect('.mc-cc-overview > .mc-wall'),
        grid: rect('.mc-cc-overview > .mc-wall .mc-wall-grid'),
        targets: Array.from(document.querySelectorAll('.mc-cc-overview .mc-wall-cell'))
          .map((target) => {
            const box = target.getBoundingClientRect();
            return { top: box.top, bottom: box.bottom, width: box.width, height: box.height };
          }),
      };
    });
    expect(lenovoGeometry.stage?.height, JSON.stringify(lenovoGeometry)).toBeGreaterThanOrEqual(110);
    expect(lenovoGeometry.wall?.height, JSON.stringify(lenovoGeometry)).toBeGreaterThanOrEqual(100);
    expect(lenovoGeometry.grid?.height, JSON.stringify(lenovoGeometry)).toBeGreaterThanOrEqual(90);
    expect(lenovoGeometry.targets.length, JSON.stringify(lenovoGeometry)).toBeGreaterThan(0);
    for (const target of lenovoGeometry.targets) {
      expect(target.height, JSON.stringify(lenovoGeometry)).toBeGreaterThanOrEqual(70);
      expect(target.top, JSON.stringify(lenovoGeometry)).toBeGreaterThanOrEqual(0);
      expect(target.bottom, JSON.stringify(lenovoGeometry)).toBeLessThanOrEqual(500);
    }
    await page.screenshot({ path: testInfo.outputPath('phase5-shelf-open-838x500.png'), fullPage: true });

    await page.setViewportSize({ width: 500, height: 838 });
    await expect(page.locator('#mc-library-drawer')).toHaveAttribute('data-open', 'true');
    await page.waitForTimeout(150);
    await page.screenshot({ path: testInfo.outputPath('phase5-shelf-open-500x838.png'), fullPage: true });
    await context.close();
  });

  test('After-hours horizontal shelf preserves fallback, pagination, search, sort, mouse drag, and tap routing', async ({ browser }, testInfo) => {
    const { context, page } = await openAuthedControl(browser, {
      viewport: { width: 838, height: 500 },
      deviceScaleFactor: 1,
      isMobile: false,
      hasTouch: true,
    });
    const longName = `extended-incident-command-briefing-${'very-long-'.repeat(10)}.mp4`;
    const videos = Array.from({ length: 65 }, (_, index) => ({
      id: `large-card-video-${index + 1}`,
      filename: index === 0 ? longName : `training-video-${String(index + 1).padStart(2, '0')}.mp4`,
      mime_type: 'video/mp4',
      detected_mime_type: 'video/mp4',
      thumbnail_url: index === 1 ? '/missing-command-center-thumbnail.jpg' : '',
      filepath: index === 0 ? '/srv/media/after-hours-download-check.mp4' : '',
      created_at: 65 - index,
    }));
    await page.route('**/api/content*', async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname !== '/api/content') return route.continue();
      const offset = Number(url.searchParams.get('offset') || 0);
      const limit = Number(url.searchParams.get('limit') || 60);
      const search = String(url.searchParams.get('search') || '').toLowerCase();
      const filtered = search
        ? videos.filter((video) => video.filename.toLowerCase().includes(search))
        : videos;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(filtered.slice(offset, offset + limit)),
      });
    });
    await page.reload({ waitUntil: 'networkidle' });
    await waitForCommandCenterVisualReady(page);
    await page.locator('#mc-library-drawer > [data-library-toggle]').click();

    const labels = page.locator('#mc-toolbox .mc-tile-label');
    await expect(labels).toHaveCount(60);
    const firstTile = page.locator('#mc-toolbox .mc-tile[data-drag-source]').first();
    await firstTile.scrollIntoViewIfNeeded();
    const geometry = await firstTile.evaluate((element) => {
      const box = element.getBoundingClientRect();
      const thumb = element.querySelector('.mc-tile-thumb-fallback').getBoundingClientRect();
      const label = element.querySelector('.mc-tile-label');
      const style = getComputedStyle(label);
      const track = element.closest('.mc-tile-grid');
      const trackStyle = getComputedStyle(track);
      const toolbar = document.querySelector('.mc-tb-media-toolbar');
      const toolbarStyle = getComputedStyle(toolbar);
      const search = document.querySelector('#mc-media-search');
      const sort = document.querySelector('#mc-media-sort');
      const searchBox = search.getBoundingClientRect();
      const sortBox = sort.getBoundingClientRect();
      return {
        width: box.width,
        height: box.height,
        thumbWidth: thumb.width,
        thumbHeight: thumb.height,
        whiteSpace: style.whiteSpace,
        textOverflow: style.textOverflow,
        labelOverflow: label.scrollWidth > label.clientWidth,
        trackFlexWrap: trackStyle.flexWrap,
        trackOverflowX: trackStyle.overflowX,
        trackOverflowY: trackStyle.overflowY,
        trackScrollable: track.scrollWidth > track.clientWidth,
        toolbarDirection: toolbarStyle.flexDirection,
        toolbarWrap: toolbarStyle.flexWrap,
        toolbarOneRow: Math.abs(searchBox.top - sortBox.top) <= 1,
        searchWidth: searchBox.width,
      };
    });
    expect(geometry.width).toBeGreaterThanOrEqual(168);
    expect(geometry.width).toBeLessThanOrEqual(200);
    expect(geometry.height).toBeGreaterThanOrEqual(132);
    expect(geometry.thumbWidth).toBeGreaterThanOrEqual(152);
    expect(geometry.thumbHeight).toBeGreaterThanOrEqual(72);
    expect(geometry.whiteSpace).toBe('nowrap');
    expect(geometry.textOverflow).toBe('ellipsis');
    expect(geometry.labelOverflow).toBe(true);
    expect(geometry.trackFlexWrap).toBe('nowrap');
    expect(geometry.trackOverflowX).toBe('auto');
    expect(geometry.trackOverflowY).toBe('hidden');
    expect(geometry.trackScrollable).toBe(true);
    expect(geometry.toolbarDirection).toBe('row');
    expect(geometry.toolbarWrap).toBe('nowrap');
    expect(geometry.toolbarOneRow).toBe(true);
    expect(geometry.searchWidth).toBeLessThanOrEqual(260);

    await page.evaluate(() => {
      window.__afterHoursShelfSwipeDrops = [];
      document.addEventListener('mc:source-drop', (event) => {
        window.__afterHoursShelfSwipeDrops.push(event.detail?.source || null);
        event.preventDefault();
        event.stopImmediatePropagation();
      }, { capture: true });
      document.querySelector('#mc-media-grid').scrollLeft = 0;
    });
    if (testInfo.project.name.startsWith('chromium')) {
      const swipeTile = page.locator('#mc-toolbox .mc-tile[data-drag-source]').nth(2);
      const swipeBox = await swipeTile.boundingBox();
      const swipeY = swipeBox.y + swipeBox.height / 2;
      const cdp = await context.newCDPSession(page);
      await cdp.send('Input.dispatchTouchEvent', {
        type: 'touchStart',
        touchPoints: [{ x: swipeBox.x + swipeBox.width / 2, y: swipeY, id: 91 }],
      });
      for (const deltaX of [40, 80, 120, 160]) {
        await cdp.send('Input.dispatchTouchEvent', {
          type: 'touchMove',
          touchPoints: [{ x: swipeBox.x + swipeBox.width / 2 - deltaX, y: swipeY + 2, id: 91 }],
        });
        await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(resolve)));
      }
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      await cdp.detach();
    } else {
      const trackBox = await page.locator('#mc-media-grid').boundingBox();
      await page.mouse.move(trackBox.x + trackBox.width / 2, trackBox.y + trackBox.height / 2);
      await page.mouse.wheel(180, 0);
    }
    await expect.poll(() => page.locator('#mc-media-grid').evaluate((element) => element.scrollLeft)).toBeGreaterThan(30);
    expect(await page.evaluate(() => window.__afterHoursShelfSwipeDrops)).toEqual([]);

    const downloadButton = page.locator('[data-download-id="large-card-video-1"]');
    await expect(downloadButton).toBeVisible();
    const downloadBox = await downloadButton.boundingBox();
    expect(downloadBox.width).toBeGreaterThanOrEqual(48);
    expect(downloadBox.height).toBeGreaterThanOrEqual(48);

    const brokenThumbTile = page.locator('[data-label="training-video-02.mp4"]');
    await brokenThumbTile.scrollIntoViewIfNeeded();
    await expect(brokenThumbTile.locator('[data-thumb-fallback]')).toBeVisible();
    await expect(brokenThumbTile.locator('img[data-media-thumb]')).toBeHidden();

    expect(JSON.parse(await firstTile.getAttribute('data-drag-source'))).toEqual({ content_id: 'large-card-video-1' });
    const dragPayload = await firstTile.evaluate((element) => {
      const transfer = new DataTransfer();
      element.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: transfer }));
      return JSON.parse(transfer.getData('application/x-mc-source'));
    });
    expect(dragPayload).toEqual({ content_id: 'large-card-video-1' });

    await firstTile.click();
    await expect(page.locator('dialog.mc-target-picker[open]')).toBeVisible();
    await page.locator('[data-target-cancel]').click();

    await page.locator('#mc-media-search').fill('training-video-64');
    await expect(labels).toHaveCount(1);
    await expect(labels.first()).toHaveText('training-video-64.mp4');
    await page.locator('#mc-media-search').fill('');
    await expect(labels).toHaveCount(60);
    await page.locator('#mc-media-sort').selectOption('name');
    await expect(labels.first()).toHaveText(longName);

    await page.locator('#mc-media-loadmore').click();
    await expect(labels).toHaveCount(65);
    await expect(page.locator('#mc-media-loadmore')).toHaveCount(0);
    await page.locator('.mc-library-body').evaluate((element) => { element.scrollTop = 0; });
    await page.screenshot({ path: testInfo.outputPath('lenovo-fallback-838x500-touch-shelf-toolbar.png'), fullPage: true });
    await firstTile.scrollIntoViewIfNeeded();
    await page.screenshot({ path: testInfo.outputPath('lenovo-fallback-838x500-touch-shelf-cards.png'), fullPage: true });

    await page.setViewportSize({ width: 500, height: 838 });
    await expect(page.locator('#mc-library-drawer')).toHaveAttribute('data-open', 'true');
    const portraitTrack = await page.locator('#mc-media-grid').evaluate((element) => ({
      flexWrap: getComputedStyle(element).flexWrap,
      overflowX: getComputedStyle(element).overflowX,
      pageOverflow: document.documentElement.scrollWidth - innerWidth,
    }));
    expect(portraitTrack).toEqual({ flexWrap: 'nowrap', overflowX: 'auto', pageOverflow: 0 });

    await page.setViewportSize({ width: 1440, height: 900 });
    const desktopTrack = await page.locator('#mc-media-grid').evaluate((element) => ({
      flexWrap: getComputedStyle(element).flexWrap,
      overflowX: getComputedStyle(element).overflowX,
      pageOverflow: document.documentElement.scrollWidth - innerWidth,
    }));
    expect(desktopTrack).toEqual({ flexWrap: 'nowrap', overflowX: 'auto', pageOverflow: 0 });
    await context.close();
  });

  test('Phase 6 keyboard navigation, focus, touch sizing, and inspector precedence remain accessible', async ({ browser }) => {
    const { context, page } = await openAuthedControl(browser, {
      viewport: { width: 838, height: 500 },
      deviceScaleFactor: 1,
      isMobile: false,
      hasTouch: true,
    });
    await waitForCommandCenterVisualReady(page);

    const toggle = page.locator('#mc-library-drawer > [data-library-toggle]');
    await toggle.focus();
    const focusStyle = await toggle.evaluate((element) => {
      const style = getComputedStyle(element);
      return { outlineStyle: style.outlineStyle, outlineWidth: parseFloat(style.outlineWidth) };
    });
    expect(focusStyle.outlineStyle).not.toBe('none');
    expect(focusStyle.outlineWidth).toBeGreaterThanOrEqual(3);
    await page.keyboard.press('Enter');
    await expect(page.locator('#mc-library-drawer')).toHaveAttribute('data-open', 'true');
    await toggle.focus();
    await page.keyboard.press('Space');
    await expect(page.locator('#mc-library-drawer')).toHaveAttribute('data-open', 'false');
    await page.keyboard.press('Enter');
    await expect(page.locator('#mc-library-drawer')).toHaveAttribute('data-open', 'true');

    const tabs = page.locator('.mc-tb-tab');
    await expect(tabs).toHaveCount(6);
    expect(await tabs.allTextContents()).toEqual(['Videos', 'Images', 'Docs', 'Sources', 'Live Feeds', 'Additional Controls']);
    const tabState = await tabs.evaluateAll((elements) => elements.map((element) => ({
      height: element.getBoundingClientRect().height,
      selected: element.getAttribute('aria-selected'),
      tabIndex: element.tabIndex,
    })));
    expect(tabState.every(({ height }) => height >= 48)).toBe(true);
    expect(tabState.filter(({ selected }) => selected === 'true')).toHaveLength(1);
    expect(tabState.filter(({ tabIndex }) => tabIndex === 0)).toHaveLength(1);

    await tabs.first().focus();
    await page.keyboard.press('ArrowRight');
    await expect(page.locator('.mc-tb-tab[data-tab="images"]')).toBeFocused();
    await expect(page.locator('.mc-tb-tab[data-tab="images"]')).toHaveAttribute('aria-selected', 'true');
    await page.keyboard.press('End');
    await expect(page.locator('.mc-tb-tab[data-tab="additional"]')).toBeFocused();
    await expect(page.locator('.mc-tb-tab[data-tab="additional"]')).toHaveAttribute('aria-selected', 'true');
    await page.keyboard.press('Home');
    await expect(page.locator('.mc-tb-tab[data-tab="videos"]')).toBeFocused();
    await page.keyboard.press('ArrowLeft');
    await expect(page.locator('.mc-tb-tab[data-tab="additional"]')).toBeFocused();

    await page.locator('.mc-wall-cell[data-device-id]').first().evaluate((element) => element.click());
    await expect(page.locator('#mc-inspector')).toBeVisible();
    await expect(page.locator('#mc-library-drawer')).toHaveAttribute('inert', '');
    await expect(page.locator('#mc-library-drawer')).toHaveAttribute('aria-hidden', 'true');
    await page.locator('#mc-inspector [data-insp-close]').click();
    await expect(page.locator('#mc-inspector')).toBeHidden();
    await expect(page.locator('#mc-library-drawer')).not.toHaveAttribute('inert', '');
    await expect(page.locator('#mc-library-drawer')).not.toHaveAttribute('aria-hidden', 'true');
    await context.close();
  });

  test('Phase 6 shelf scroll, mouse drag, touch drag, and release-outside safety preserve routing intent', async ({ browser }) => {
    const { context, page } = await openAuthedControl(browser, {
      viewport: { width: 838, height: 500 },
      deviceScaleFactor: 1,
      isMobile: false,
      hasTouch: true,
    });
    const videos = Array.from({ length: 65 }, (_, index) => ({
      id: `phase6-video-${index + 1}`,
      filename: `phase6-training-video-${String(index + 1).padStart(2, '0')}.mp4`,
      mime_type: 'video/mp4',
      detected_mime_type: 'video/mp4',
      created_at: 65 - index,
    }));
    await page.route('**/api/content*', async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname !== '/api/content') return route.continue();
      const offset = Number(url.searchParams.get('offset') || 0);
      const limit = Number(url.searchParams.get('limit') || 60);
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(videos.slice(offset, offset + limit)),
      });
    });
    await page.reload({ waitUntil: 'networkidle' });
    await waitForCommandCenterVisualReady(page);
    await page.locator('#mc-library-drawer > [data-library-toggle]').click();
    await waitForLibraryDrawerSettled(page);

    const scrollBody = page.locator('.mc-library-body');
    const scrollGeometry = await scrollBody.evaluate((element) => ({
      clientHeight: element.clientHeight,
      scrollHeight: element.scrollHeight,
      touchAction: getComputedStyle(element).touchAction,
    }));
    expect(scrollGeometry.scrollHeight).toBeGreaterThan(scrollGeometry.clientHeight);
    expect(scrollGeometry.touchAction).not.toBe('none');
    const scrollBox = await scrollBody.boundingBox();
    await page.mouse.move(scrollBox.x + 20, scrollBox.y + scrollBox.height - 20);
    await page.mouse.wheel(0, 360);
    await expect.poll(() => scrollBody.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);

    const firstTile = page.locator('#mc-toolbox .mc-tile[data-drag-source]').first();
    const stageTarget = page.locator('.mc-wall-all[data-wall-ids], #mc-stage').first();
    await firstTile.scrollIntoViewIfNeeded();
    await page.evaluate(() => {
      window.__phase6MouseDrop = null;
      window.__phase6MouseDragSource = '';
      document.addEventListener('dragstart', (event) => {
        window.__phase6MouseDragSource = event.dataTransfer?.getData('application/x-mc-source')
          || event.dataTransfer?.getData('text/plain')
          || '';
      }, { once: true });
      document.addEventListener('drop', (event) => {
        const target = event.target.closest('.mc-wall-all[data-wall-ids], .mc-wall-cell[data-device-id], #mc-stage');
        window.__phase6MouseDrop = {
          target: target?.className || target?.id || '',
        };
        event.preventDefault();
        event.stopImmediatePropagation();
      }, { capture: true, once: true });
    });
    await firstTile.dragTo(stageTarget);
    await expect.poll(() => page.evaluate(() => window.__phase6MouseDrop)).not.toBeNull();
    expect(await page.evaluate(() => window.__phase6MouseDrop.target)).not.toBe('');
    expect(JSON.parse(await page.evaluate(() => window.__phase6MouseDragSource))).toEqual({ content_id: 'phase6-video-1' });

    await page.evaluate(() => {
      window.__phase6TouchDrops = [];
      document.addEventListener('mc:source-drop', (event) => {
        window.__phase6TouchDrops.push({
          detail: event.detail,
          target: event.target.className || event.target.id || '',
        });
        event.preventDefault();
        event.stopImmediatePropagation();
      }, { capture: true });
    });
    const tileBox = await firstTile.boundingBox();
    const targetBox = await stageTarget.boundingBox();
    await firstTile.evaluate((element, points) => {
      const dispatch = (type, x, y) => element.dispatchEvent(new PointerEvent(type, {
        bubbles: true,
        cancelable: true,
        pointerId: 61,
        pointerType: 'touch',
        isPrimary: true,
        buttons: type === 'pointerup' ? 0 : 1,
        clientX: x,
        clientY: y,
      }));
      dispatch('pointerdown', points.start.x, points.start.y);
      dispatch('pointermove', points.end.x, points.end.y);
      dispatch('pointerup', points.end.x, points.end.y);
    }, {
      start: { x: tileBox.x + tileBox.width / 2, y: tileBox.y + tileBox.height / 2 },
      end: { x: targetBox.x + targetBox.width / 2, y: targetBox.y + targetBox.height / 2 },
    });
    await expect.poll(() => page.evaluate(() => window.__phase6TouchDrops.length)).toBe(1);
    expect(await page.evaluate(() => window.__phase6TouchDrops[0].detail.source)).toEqual({ content_id: 'phase6-video-1' });

    await page.evaluate(() => { window.__phase6TouchDrops = []; });
    await firstTile.evaluate((element, point) => {
      const dispatch = (type, x, y) => element.dispatchEvent(new PointerEvent(type, {
        bubbles: true,
        cancelable: true,
        pointerId: 62,
        pointerType: 'touch',
        isPrimary: true,
        buttons: type === 'pointerup' ? 0 : 1,
        clientX: x,
        clientY: y,
      }));
      dispatch('pointerdown', point.x, point.y);
      dispatch('pointermove', 2, 2);
      dispatch('pointerup', 2, 2);
    }, { x: tileBox.x + tileBox.width / 2, y: tileBox.y + tileBox.height / 2 });
    await page.waitForTimeout(100);
    expect(await page.evaluate(() => window.__phase6TouchDrops)).toEqual([]);
    await expect(page.locator('dialog.mc-target-picker[open]')).toHaveCount(0);
    await context.close();
  });

  test('After-hours touch acquisition repeats across five targets, edges, hit slop, and ambiguous gaps', async ({ browser }) => {
    const { context, page } = await openAuthedControl(browser, {
      viewport: { width: 838, height: 500 },
      deviceScaleFactor: 1,
      isMobile: false,
      hasTouch: true,
    });
    await page.route('**/api/content*', async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname !== '/api/content') return route.continue();
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([{
          id: 'after-hours-touch-video',
          filename: 'After-hours touch acceptance.mp4',
          mime_type: 'video/mp4',
          detected_mime_type: 'video/mp4',
          created_at: 1,
        }]),
      });
    });
    await page.reload({ waitUntil: 'networkidle' });
    await waitForCommandCenterVisualReady(page);
    await page.locator('#mc-library-drawer > [data-library-toggle]').click();
    await waitForLibraryDrawerSettled(page);

    await page.evaluate(() => {
      window.__afterHoursTouchDrops = [];
      window.__afterHoursMouseDrops = [];
      document.addEventListener('mc:source-drop', (event) => {
        window.__afterHoursTouchDrops.push({
          target: event.target.dataset.testTouchTarget || '',
          source: event.detail?.source || null,
        });
        event.preventDefault();
        event.stopImmediatePropagation();
      }, { capture: true });

      const fixture = document.createElement('div');
      fixture.id = 'mc-after-hours-touch-fixture';
      const addTarget = (id, left, top, width, height, {
        className = 'mc-display-card',
        data = { deviceId: `fixture-${id}` },
        nestedClassName = '',
        nestedData = {},
      } = {}) => {
        const target = document.createElement('div');
        target.className = className;
        Object.assign(target.dataset, data);
        target.dataset.testTouchTarget = id;
        Object.assign(target.style, {
          position: 'fixed', left: `${left}px`, top: `${top}px`,
          width: `${width}px`, height: `${height}px`, zIndex: '9000',
          pointerEvents: 'auto', background: '#fff',
        });
        const preview = document.createElement('span');
        preview.className = nestedClassName;
        Object.assign(preview.dataset, nestedData);
        preview.dataset.testNested = id;
        Object.assign(preview.style, { position: 'absolute', inset: '0 0 18px' });
        const caption = document.createElement('span');
        caption.dataset.testCaption = id;
        Object.assign(caption.style, { position: 'absolute', left: '0', right: '0', bottom: '0', height: '18px' });
        target.append(preview, caption);
        target.addEventListener('dragover', (event) => event.preventDefault());
        target.addEventListener('drop', (event) => {
          event.preventDefault();
          window.__afterHoursMouseDrops.push(id);
        });
        fixture.appendChild(target);
      };
      ['tv1', 'tv2', 'tv3', 'tv4', 'tv5'].forEach((id, index) => {
        addTarget(id, 20 + (index * 160), 78, 120, 64);
      });
      ['primary-1', 'primary-2', 'primary-3'].forEach((id, index) => {
        addTarget(id, 20 + (index * 130), 154, 100, 54, {
          className: 'mc-wall-split-half',
          data: { deviceId: `fixture-${id}`, wallRegionId: `region-${index + 1}` },
        });
      });
      ['secondary-1', 'secondary-2'].forEach((id, index) => {
        addTarget(id, 530 + (index * 140), 154, 110, 54, {
          className: 'mc-wall-region',
          data: { layoutGroupId: `fixture-group-${index + 1}`, wallId: 'fixture-secondary-wall' },
          nestedClassName: 'mc-wall-cell',
          nestedData: { deviceId: `fixture-secondary-member-${index + 1}` },
        });
      });
      addTarget('whole-wall', 20, 230, 150, 54, {
        className: 'mc-wall-all',
        data: { wallIds: 'fixture-tv1,fixture-tv2,fixture-tv3' },
      });
      addTarget('gap-left', 300, 230, 80, 54);
      addTarget('gap-right', 420, 230, 80, 54);
      addTarget('cross-class-display', 300, 300, 80, 54);
      addTarget('cross-class-split', 410, 300, 80, 54, {
        className: 'mc-wall-split-half',
        data: { deviceId: 'fixture-cross-class-split', wallRegionId: 'region-cross-class-split' },
      });
      document.body.appendChild(fixture);
    });

    const tile = page.locator('#mc-toolbox .mc-tile[data-drag-source]').first();
    await tile.scrollIntoViewIfNeeded();
    const tileBox = await tile.boundingBox();
    const start = { x: tileBox.x + tileBox.width / 2, y: tileBox.y + tileBox.height / 2 };
    let pointerId = 700;

    const dispatchPointer = async (type, point, id, pointerType = 'touch') => tile.evaluate((element, args) => {
      element.dispatchEvent(new PointerEvent(args.type, {
        bubbles: true,
        cancelable: true,
        pointerId: args.id,
        pointerType: args.pointerType,
        isPrimary: true,
        buttons: args.type === 'pointerup' || args.type === 'pointercancel' ? 0 : 1,
        clientX: args.point.x,
        clientY: args.point.y,
      }));
    }, { type, point, id, pointerType });
    const beginDrag = async (point, id, pointerType = 'touch') => {
      await dispatchPointer('pointerdown', start, id, pointerType);
      await dispatchPointer('pointermove', { x: start.x, y: start.y - 18 }, id, pointerType);
      await dispatchPointer('pointermove', point, id, pointerType);
      await page.waitForTimeout(34);
    };

    const targetPoints = await page.evaluate(() => Object.fromEntries(
      Array.from(document.querySelectorAll('[data-test-touch-target^="tv"]')).map((element) => {
        const box = element.getBoundingClientRect();
        return [element.dataset.testTouchTarget, {
          center: { x: box.left + box.width / 2, y: box.top + box.height / 2 },
          leftEdge: { x: box.left + 1, y: box.top + box.height / 2 },
          rightEdge: { x: box.right - 1, y: box.top + box.height / 2 },
          caption: { x: box.left + box.width / 2, y: box.bottom - 6 },
          nearTop: { x: box.left + box.width / 2, y: box.top - 20 },
        }];
      }),
    ));
    const regionPoints = await page.evaluate(() => Object.fromEntries(
      Array.from(document.querySelectorAll('[data-test-touch-target^="primary-"], [data-test-touch-target^="secondary-"], [data-test-touch-target="whole-wall"]')).map((element) => {
        const box = element.getBoundingClientRect();
        return [element.dataset.testTouchTarget, {
          center: { x: box.left + box.width / 2, y: box.top + box.height / 2 },
          caption: { x: box.left + box.width / 2, y: box.bottom - 6 },
        }];
      }),
    ));

    let expectedDrops = 0;
    for (let repeat = 0; repeat < 2; repeat += 1) {
      for (const targetId of ['tv1', 'tv2', 'tv3', 'tv4', 'tv5']) {
        for (const [position, point] of Object.entries(targetPoints[targetId])) {
          const id = pointerId++;
          await beginDrag(point, id);
          const target = page.locator(`[data-test-touch-target="${targetId}"]`);
          await expect(target, `${targetId} ${position} repeat ${repeat + 1}`).toHaveClass(/mc-card-dragover/);
          expect(await target.evaluate((element) => getComputedStyle(element, '::before').pointerEvents)).toBe('none');
          await dispatchPointer('pointerup', point, id);
          expectedDrops += 1;
          await expect.poll(() => page.evaluate(() => window.__afterHoursTouchDrops.length)).toBe(expectedDrops);
          expect(await page.evaluate(() => window.__afterHoursTouchDrops.at(-1).target)).toBe(targetId);
          await expect(target).not.toHaveClass(/mc-card-dragover/);
          await expect(page.locator('.mc-touch-drag-ghost')).toHaveCount(0);
        }
      }
    }

    for (const targetId of ['primary-1', 'primary-2', 'primary-3', 'secondary-1', 'secondary-2', 'whole-wall']) {
      for (const point of Object.values(regionPoints[targetId])) {
        const id = pointerId++;
        await beginDrag(point, id);
        const target = page.locator(`[data-test-touch-target="${targetId}"]`);
        await expect(target).toHaveClass(targetId === 'whole-wall' ? /mc-wall-all-dragover/ : /mc-card-dragover/);
        expect(await target.evaluate((element) => getComputedStyle(element, '::before').pointerEvents)).toBe('none');
        await dispatchPointer('pointerup', point, id);
        expectedDrops += 1;
        await expect.poll(() => page.evaluate(() => window.__afterHoursTouchDrops.length)).toBe(expectedDrops);
        expect(await page.evaluate(() => window.__afterHoursTouchDrops.at(-1).target)).toBe(targetId);
        await expect(target).not.toHaveClass(/mc-card-dragover|mc-wall-all-dragover/);
      }
    }

    const childTransitionId = pointerId++;
    await beginDrag(targetPoints.tv1.center, childTransitionId);
    await dispatchPointer('pointermove', targetPoints.tv1.caption, childTransitionId);
    await expect(page.locator('[data-test-touch-target="tv1"]')).toHaveClass(/mc-card-dragover/);
    await dispatchPointer('pointerup', targetPoints.tv1.caption, childTransitionId);
    expectedDrops += 1;
    await expect.poll(() => page.evaluate(() => window.__afterHoursTouchDrops.length)).toBe(expectedDrops);

    const penId = pointerId++;
    await beginDrag(targetPoints.tv2.center, penId, 'pen');
    await expect(page.locator('[data-test-touch-target="tv2"]')).toHaveClass(/mc-card-dragover/);
    await dispatchPointer('pointerup', targetPoints.tv2.center, penId, 'pen');
    expectedDrops += 1;
    await expect.poll(() => page.evaluate(() => window.__afterHoursTouchDrops.length)).toBe(expectedDrops);

    const ambiguousPoint = { x: 400, y: 257 };
    const ambiguousId = pointerId++;
    await beginDrag(ambiguousPoint, ambiguousId);
    await expect(page.locator('[data-test-touch-target="gap-left"]')).not.toHaveClass(/mc-card-dragover/);
    await expect(page.locator('[data-test-touch-target="gap-right"]')).not.toHaveClass(/mc-card-dragover/);
    await dispatchPointer('pointerup', ambiguousPoint, ambiguousId);
    await page.waitForTimeout(50);
    expect(await page.evaluate(() => window.__afterHoursTouchDrops.length)).toBe(expectedDrops);

    const nearerDisplayPoint = { x: 390, y: 327 };
    const nearerDisplayId = pointerId++;
    await beginDrag(nearerDisplayPoint, nearerDisplayId);
    await expect(page.locator('[data-test-touch-target="cross-class-display"]')).toHaveClass(/mc-card-dragover/);
    await expect(page.locator('[data-test-touch-target="cross-class-split"]')).not.toHaveClass(/mc-card-dragover/);
    await dispatchPointer('pointerup', nearerDisplayPoint, nearerDisplayId);
    expectedDrops += 1;
    await expect.poll(() => page.evaluate(() => window.__afterHoursTouchDrops.length)).toBe(expectedDrops);
    expect(await page.evaluate(() => window.__afterHoursTouchDrops.at(-1).target)).toBe('cross-class-display');

    const crossClassAmbiguousPoint = { x: 395, y: 327 };
    const crossClassAmbiguousId = pointerId++;
    await beginDrag(crossClassAmbiguousPoint, crossClassAmbiguousId);
    await expect(page.locator('[data-test-touch-target="cross-class-display"]')).not.toHaveClass(/mc-card-dragover/);
    await expect(page.locator('[data-test-touch-target="cross-class-split"]')).not.toHaveClass(/mc-card-dragover/);
    await dispatchPointer('pointerup', crossClassAmbiguousPoint, crossClassAmbiguousId);
    await page.waitForTimeout(50);
    expect(await page.evaluate(() => window.__afterHoursTouchDrops.length)).toBe(expectedDrops);

    const cancelTarget = targetPoints.tv3.center;
    const cancelId = pointerId++;
    await beginDrag(cancelTarget, cancelId);
    await expect(page.locator('[data-test-touch-target="tv3"]')).toHaveClass(/mc-card-dragover/);
    await dispatchPointer('pointercancel', cancelTarget, cancelId);
    await expect(page.locator('[data-test-touch-target="tv3"]')).not.toHaveClass(/mc-card-dragover/);
    await expect(page.locator('.mc-touch-drag-ghost')).toHaveCount(0);

    const repaintId = pointerId++;
    await beginDrag(targetPoints.tv2.center, repaintId);
    await expect(page.locator('[data-test-touch-target="tv2"]')).toHaveClass(/mc-card-dragover/);
    await page.evaluate(async () => {
      const state = await import('/js/services/display-state.js');
      const display = state.getAll()[0];
      state.applyConfirmedState(display.id, {
        state_revision: Number(display.state_revision || 0) + 1,
        screen_on: !display.screen_on,
      });
    });
    await expect(page.locator('[data-test-touch-target="tv2"]')).not.toHaveClass(/mc-card-dragover/);
    await expect(page.locator('.mc-touch-drag-ghost')).toHaveCount(0);

    const resizeId = pointerId++;
    await beginDrag(targetPoints.tv3.center, resizeId);
    await expect(page.locator('[data-test-touch-target="tv3"]')).toHaveClass(/mc-card-dragover/);
    await page.setViewportSize({ width: 837, height: 500 });
    await expect(page.locator('[data-test-touch-target="tv3"]')).not.toHaveClass(/mc-card-dragover/);
    await expect(page.locator('.mc-touch-drag-ghost')).toHaveCount(0);
    await page.setViewportSize({ width: 838, height: 500 });
    await page.waitForTimeout(50);

    const blurId = pointerId++;
    await beginDrag(targetPoints.tv4.center, blurId);
    await page.evaluate(() => window.dispatchEvent(new Event('blur')));
    await expect(page.locator('[data-test-touch-target="tv4"]')).not.toHaveClass(/mc-card-dragover/);
    await expect(page.locator('.mc-touch-drag-ghost')).toHaveCount(0);

    const closeId = pointerId++;
    await beginDrag(targetPoints.tv5.center, closeId);
    await page.locator('#mc-library-drawer > [data-library-toggle]').click();
    await expect(page.locator('#mc-library-drawer')).toHaveAttribute('data-open', 'false');
    await expect(page.locator('[data-test-touch-target="tv5"]')).not.toHaveClass(/mc-card-dragover/);
    await expect(page.locator('.mc-touch-drag-ghost')).toHaveCount(0);
    await page.locator('#mc-library-drawer > [data-library-toggle]').click();

    const swipeId = pointerId++;
    await dispatchPointer('pointerdown', start, swipeId);
    await dispatchPointer('pointermove', { x: start.x + 56, y: start.y + 3 }, swipeId);
    await dispatchPointer('pointerup', { x: start.x + 56, y: start.y + 3 }, swipeId);
    await tile.evaluate((element) => element.click());
    await expect(page.locator('dialog.mc-target-picker[open]')).toHaveCount(0);
    expect(await tile.evaluate((element) => getComputedStyle(element).touchAction)).toContain('pan-x');

    await tile.click();
    await expect(page.locator('dialog.mc-target-picker[open]')).toHaveCount(1);
    await page.locator('[data-target-cancel]').click();

    await tile.dragTo(page.locator('[data-test-touch-target="tv1"]'));
    await expect.poll(() => page.evaluate(() => window.__afterHoursMouseDrops.length)).toBe(1);
    expect(await page.evaluate(() => window.__afterHoursMouseDrops)).toEqual(['tv1']);

    expect(await page.evaluate(() => window.__afterHoursTouchDrops.every(
      (drop) => drop.source?.content_id === 'after-hours-touch-video'
    ))).toBe(true);
    await context.close();
  });

  test('Phase 6 Lenovo landscape remains operable with 200 percent text', async ({ browser }) => {
    const { context, page } = await openAuthedControl(browser, {
      viewport: { width: 838, height: 500 },
      deviceScaleFactor: 1,
      isMobile: false,
      hasTouch: true,
    });
    await waitForCommandCenterVisualReady(page);
    await page.addStyleTag({ content: `
      .mc-cc-shell button,
      .mc-cc-shell select,
      .mc-cc-shell .mc-library-tab-label,
      .mc-cc-shell .mc-tb-tab { font-size: 200% !important; line-height: 1.2 !important; }
    ` });
    const toggle = page.locator('#mc-library-drawer > [data-library-toggle]');
    await toggle.focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('#mc-library-drawer')).toHaveAttribute('data-open', 'true');

    const overflow = await page.evaluate(() => ({
      clientWidth: document.documentElement.clientWidth,
      scrollWidth: document.documentElement.scrollWidth,
    }));
    expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.clientWidth + 1);
    const tabs = page.locator('.mc-tb-tab');
    await expect(tabs).toHaveCount(6);
    for (let index = 0; index < 6; index += 1) {
      const tab = tabs.nth(index);
      await tab.scrollIntoViewIfNeeded();
      await expect(tab).toBeVisible();
      expect(await tab.evaluate((element) => element.getBoundingClientRect().height)).toBeGreaterThanOrEqual(48);
    }

    const reachability = await page.evaluate(() => {
      const shelf = document.querySelector('#mc-library-drawer').getBoundingClientRect();
      const targets = Array.from(document.querySelectorAll('.mc-wall-cell[data-device-id]')).map((element) => {
        const box = element.getBoundingClientRect();
        return { top: box.top, bottom: box.bottom, width: box.width, height: box.height };
      });
      return { shelfTop: shelf.top, targets };
    });
    for (const selector of [
      '[data-cc-tp="prev"]',
      '[data-cc-tp="restart"]',
      '[data-cc-tp="play_pause"]',
      '[data-cc-tp="next"]',
      '#mc-dock-blank-btn',
    ]) {
      const control = page.locator(selector);
      await control.scrollIntoViewIfNeeded();
      await expect(control).toBeVisible();
      const geometry = await control.evaluate((element) => {
        const box = element.getBoundingClientRect();
        const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
        return {
          box: { left: box.left, right: box.right, top: box.top, bottom: box.bottom, width: box.width },
          viewport: { width: innerWidth, height: innerHeight },
          height: box.height,
          insideViewport: box.left >= -1 && box.right <= innerWidth + 1 && box.top >= -1 && box.bottom <= innerHeight + 1,
          hit: hit === element || element.contains(hit),
        };
      });
      expect(geometry.height, JSON.stringify({ selector, geometry })).toBeGreaterThanOrEqual(48);
      expect(geometry.insideViewport, JSON.stringify({ selector, geometry })).toBe(true);
      expect(geometry.hit, JSON.stringify({ selector, geometry })).toBe(true);
    }
    for (const target of reachability.targets) {
      expect(target.bottom, JSON.stringify({ target, shelfTop: reachability.shelfTop })).toBeLessThanOrEqual(reachability.shelfTop);
    }

    await toggle.focus();
    await page.keyboard.press('Space');
    await expect(page.locator('#mc-library-drawer')).toHaveAttribute('data-open', 'false');
    await context.close();
  });

  test('Lenovo tablet can add and remove a ready image from the wallpaper menu', async ({ browser }) => {
    const context = await browser.newContext({
      viewport: { width: 838, height: 500 }, hasTouch: true, serviceWorkers: 'block',
    });
    const page = await context.newPage();
    await page.addInitScript(({ token, user }) => {
      localStorage.setItem('token', token);
      localStorage.setItem('user', JSON.stringify(user));
      localStorage.setItem('rd_onboarded', '1');
    }, { token: authToken, user: { id: userId, email: TEST_EMAIL, name: 'Mobile Test', role: 'platform_admin' } });

    let item = {
      id: 'wallpaper-image',
      filename: 'Classroom Map.png',
      filepath: 'classroom-map.png',
      mime_type: 'image/png',
      file_size: 4096,
      processing_status: 'ready',
      version: 7,
      is_wallpaper_menu: false,
      visibility: { access_level: 'workspace_shared', archived_at: null, owner_name: 'Mobile Test' },
      permissions: { can_edit: true, can_archive: true, can_delete: true },
    };
    const mutations = [];
    await page.route('**/api/content/wallpaper-image/wallpaper-menu', async route => {
      const body = route.request().postDataJSON();
      mutations.push(body);
      item = { ...item, is_wallpaper_menu: body.enabled === true };
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(item) });
    });
    await page.route('**/api/content?**', async route => {
      const url = new URL(route.request().url());
      if (url.pathname !== '/api/content' || route.request().method() !== 'GET') {
        await route.fallback();
        return;
      }
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([item]) });
    });

    await page.goto(`${BASE_URL}/app#/content`, { waitUntil: 'networkidle' });
    const add = page.getByRole('button', { name: 'Add to wallpaper menu' });
    await expect(add).toBeVisible();
    expect((await add.boundingBox()).height).toBeGreaterThanOrEqual(48);
    await add.click();
    await expect(page.getByRole('button', { name: 'Remove from wallpaper menu' })).toBeVisible();
    expect(mutations).toEqual([{ enabled: true, expected_version: 7 }]);

    await page.getByRole('button', { name: 'Remove from wallpaper menu' }).click();
    await expect(page.getByRole('button', { name: 'Add to wallpaper menu' })).toBeVisible();
    expect(mutations).toEqual([
      { enabled: true, expected_version: 7 },
      { enabled: false, expected_version: 7 },
    ]);
    await context.close();
  });

  for (const vp of [
    { name: 'Lenovo-Tab-One-landscape', width: 838, height: 500 },
    { name: 'Lenovo-Tab-One-portrait', width: 500, height: 838 },
    { name: 'Phone', width: 390, height: 844 },
    { name: 'Lenovo-text-200', width: 838, height: 500, textScale: 2 },
    { name: 'Desktop', width: 1440, height: 900 },
  ]) {
    test(`[${vp.name}] Media Library keeps primary media visible and touch-safe`, async ({ browser }, testInfo) => {
      const context = await browser.newContext({
        viewport: { width: vp.width, height: vp.height },
        deviceScaleFactor: 1,
        isMobile: vp.width < 1025,
        hasTouch: vp.width < 1025,
      });
      const page = await context.newPage();
      await page.addInitScript(({ token, user }) => {
        localStorage.setItem('token', token);
        localStorage.setItem('user', JSON.stringify(user));
        localStorage.setItem('rd_onboarded', '1');
      }, { token: authToken, user: { id: userId, email: TEST_EMAIL, name: 'Mobile Test', role: 'platform_admin' } });

      await page.goto(`${BASE_URL}/app#/content`, { waitUntil: 'networkidle' });
      if (vp.textScale) {
        await page.addStyleTag({
          content: `
            .media-library-page,
            .media-library-add-sheet { font-size: ${vp.textScale}em !important; }
            .media-library-page .btn,
            .media-library-page .input,
            .media-library-page button,
            .media-library-page select,
            .media-library-page input,
            .media-library-add-sheet .btn,
            .media-library-add-sheet .input,
            .media-library-add-sheet button,
            .media-library-add-sheet select,
            .media-library-add-sheet input { font-size: 1em !important; }
          `,
        });
      }
      await expect(page.getByRole('heading', { name: 'Media Library' })).toBeVisible();
      const addMediaButton = page.locator('#openAddMedia');
      await expect(addMediaButton).toBeVisible();
      await expect(page.locator('#contentGrid')).toBeInViewport();

      const overflow = await page.evaluate(() => ({
        scrollW: document.documentElement.scrollWidth,
        clientW: document.documentElement.clientWidth,
      }));
      expect(overflow.scrollW).toBeLessThanOrEqual(overflow.clientW + 2);

      if (vp.width < 1025) {
        const addBox = await addMediaButton.boundingBox();
        expect(addBox.height).toBeGreaterThanOrEqual(48);
        await addMediaButton.click();
        const dialog = page.getByRole('dialog', { name: 'Add media' });
        await expect(dialog).toBeVisible();
        const sourceControls = dialog.locator('[role="tab"], .media-library-source-link');
        for (let index = 0; index < await sourceControls.count(); index += 1) {
          const box = await sourceControls.nth(index).boundingBox();
          expect(box.height, `source ${index} touch height at ${vp.width}px`).toBeGreaterThanOrEqual(48);
        }
        await dialog.getByRole('tab', { name: 'Remote URL' }).click();
        await expect(dialog.getByLabel('Remote URL')).toBeVisible();
        if (vp.name === 'Lenovo-Tab-One-landscape') {
          await page.screenshot({
            path: testInfo.outputPath(`${vp.name}-add-media-${testInfo.project.name}.png`),
            fullPage: true,
          });
        }
        await page.keyboard.press('Escape');
        await expect(dialog).toBeHidden();
        await expect(addMediaButton).toBeFocused();
      }

      await page.screenshot({
        path: testInfo.outputPath(`${vp.name}-${testInfo.project.name}.png`),
        fullPage: true,
      });
      await context.close();
    });
  }

  for (const vp of [
    { name: 'Downloader-desktop', width: 1440, height: 900 },
    { name: 'Downloader-Lenovo-landscape', width: 838, height: 500 },
    { name: 'Downloader-phone', width: 390, height: 844 },
  ]) {
    test(`[${vp.name}] YouTube Downloader is clear, touch-safe, and submits once`, async ({ browser }, testInfo) => {
      const context = await browser.newContext({
        viewport: { width: vp.width, height: vp.height },
        deviceScaleFactor: 1,
        isMobile: vp.width < 1025,
        hasTouch: vp.width < 1025,
        serviceWorkers: 'block',
      });
      const page = await context.newPage();
      await page.addInitScript(({ token, user }) => {
        localStorage.setItem('token', token);
        localStorage.setItem('user', JSON.stringify(user));
        localStorage.setItem('rd_onboarded', '1');
      }, { token: authToken, user: { id: userId, email: TEST_EMAIL, name: 'Mobile Test', role: 'platform_admin' } });

      let createCalls = 0;
      await page.route('**/api/downloads', async (route) => {
        if (route.request().method() !== 'POST') return route.continue();
        createCalls += 1;
        await route.fulfill({
          status: 202,
          contentType: 'application/json',
          body: JSON.stringify({ id: 'download-e2e', status: 'pending', content_id: 'content-e2e', media_job_id: 'job-e2e' }),
        });
      });

      await page.goto(`${BASE_URL}/app#/downloads`, { waitUntil: 'networkidle' });
      await expect(page.getByRole('heading', { name: 'YouTube Downloader' })).toBeVisible();
      await expect(page.getByText('Paste a YouTube video link below, then select Download.')).toBeVisible();
      await expect(page.locator('a[data-view="downloads"] span')).toHaveText('YouTube Downloader');

      const logo = page.locator('.mc-downloader-wordmark');
      await expect(logo).toBeVisible();
      expect(await logo.evaluate((image) => image.complete && image.naturalWidth > 0)).toBe(true);

      const input = page.getByLabel('YouTube video link');
      const submit = page.getByRole('button', { name: 'Download' });
      expect((await input.boundingBox()).height).toBeGreaterThanOrEqual(48);
      expect((await submit.boundingBox()).height).toBeGreaterThanOrEqual(48);

      const layout = await page.locator('#dlForm').evaluate((form) => ({
        display: getComputedStyle(form).display,
        direction: getComputedStyle(form).flexDirection,
      }));
      if (vp.width <= 760) {
        expect(layout.display).toBe('flex');
        expect(layout.direction).toBe('column');
      } else {
        expect(layout.display).toBe('grid');
      }

      const overflow = await page.evaluate(() => ({
        scrollW: document.documentElement.scrollWidth,
        clientW: document.documentElement.clientWidth,
      }));
      expect(overflow.scrollW).toBeLessThanOrEqual(overflow.clientW + 2);

      await input.fill('https://www.youtube.com/watch?v=example');
      await input.press('Enter');
      await expect.poll(() => createCalls).toBe(1);
      await expect(page.getByText('Download queued')).toBeVisible();

      if (vp.name === 'Downloader-Lenovo-landscape') {
        await page.screenshot({
          path: testInfo.outputPath(`${vp.name}-${testInfo.project.name}.png`),
          fullPage: true,
        });
      }
      await context.close();
    });
  }

  test('Lenovo tablet can use advanced filters and persist a saved library view without overflow', async ({ browser }) => {
    const context = await browser.newContext({
      viewport: { width: 838, height: 500 },
      hasTouch: true,
      serviceWorkers: 'block',
    });
    const page = await context.newPage();
    await page.addInitScript(({ token, user }) => {
      localStorage.setItem('token', token);
      localStorage.setItem('user', JSON.stringify(user));
      localStorage.setItem('rd_onboarded', '1');
    }, { token: authToken, user: { id: userId, email: TEST_EMAIL, name: 'Mobile Test', role: 'platform_admin' } });

    await page.goto(`${BASE_URL}/app#/content`, { waitUntil: 'networkidle' });
    const favoriteScope = page.getByRole('button', { name: 'Favorites' });
    await expect(favoriteScope).toBeVisible();
    expect((await favoriteScope.boundingBox()).height).toBeGreaterThanOrEqual(48);

    const filters = page.locator('.media-library-advanced-filters');
    await filters.locator('summary').click();
    for (const id of [
      'contentProcessingFilter',
      'contentCodecFilter',
      'contentDimensionsFilter',
      'contentSourceFilter',
      'contentThumbnailFilter',
      'contentP3Filter',
    ]) {
      const control = page.locator(`#${id}`);
      await expect(control).toBeVisible();
      expect((await control.boundingBox()).height, `${id} touch height`).toBeGreaterThanOrEqual(48);
    }
    await page.locator('#contentProcessingFilter').selectOption('ready');
    await page.locator('#contentDimensionsFilter').selectOption('hd');

    await page.locator('[data-save-view]').click();
    const saveDialog = page.getByRole('dialog', { name: 'Save this library view' });
    await saveDialog.locator('#mediaLibraryPromptInput').fill('Class-ready HD');
    await saveDialog.getByRole('button', { name: 'Save current view' }).click();
    await expect(page.locator('[data-saved-view]')).toHaveValue(/.+/);
    await expect(page.locator('[data-saved-view] option:checked')).toHaveText('Class-ready HD');

    await page.locator('[data-saved-view]').selectOption({ label: 'Class-ready HD' });
    await expect(page.locator('#contentProcessingFilter')).toHaveValue('ready');
    await expect(page.locator('#contentDimensionsFilter')).toHaveValue('hd');

    const overflow = await page.evaluate(() => ({
      scrollW: document.documentElement.scrollWidth,
      clientW: document.documentElement.clientWidth,
    }));
    expect(overflow.scrollW).toBeLessThanOrEqual(overflow.clientW + 2);

    await page.locator('[data-delete-view]').click();
    const deleteDialog = page.getByRole('dialog', { name: 'Delete view' });
    await deleteDialog.getByRole('button', { name: 'Delete view' }).click();
    await expect(page.locator('[data-saved-view] option', { hasText: 'Class-ready HD' })).toHaveCount(0);
    await context.close();
  });

  test('Lenovo tablet can inspect and recover durable processing jobs', async ({ browser }) => {
    const context = await browser.newContext({
      viewport: { width: 838, height: 500 },
      hasTouch: true,
      serviceWorkers: 'block',
    });
    const page = await context.newPage();
    await page.addInitScript(({ token, user }) => {
      localStorage.setItem('token', token);
      localStorage.setItem('user', JSON.stringify(user));
      localStorage.setItem('rd_onboarded', '1');
    }, { token: authToken, user: { id: userId, email: TEST_EMAIL, name: 'Mobile Test', role: 'platform_admin' } });

    const item = {
      id: 'poster-video',
      filename: 'Training video.mp4',
      filepath: 'training-video.mp4',
      mime_type: 'video/mp4',
      file_url: 'data:video/mp4;base64,',
      thumbnail_url: 'data:image/gif;base64,R0lGODlhAQABAAAAACw=',
      thumbnail_path: 'thumb_training.jpg',
      file_size: 1024,
      duration_sec: 90,
      created_at: '2026-01-01T00:00:00.000Z',
      processing_status: 'ready',
      version: 4,
      visibility: { access_level: 'private', owner_name: 'Mobile Test' },
      permissions: {
        can_edit: true,
        can_duplicate: true,
        can_transfer: true,
        can_archive: true,
        can_delete: true,
      },
      media: {
        thumbnail_generation: 2,
        thumbnail_provenance: 'video_timestamp:10:center',
      },
    };
    await page.route('**/api/content?**', async route => {
      const url = new URL(route.request().url());
      if (url.pathname !== '/api/content' || route.request().method() !== 'GET') {
        await route.fallback();
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([item]),
      });
    });
    await page.route('**/api/content/jobs?**', async route => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([
          {
            id: 'job-running',
            content_id: item.id,
            job_type: 'thumbnail_studio',
            status: 'running',
            stage: 'thumbnail',
            progress_pct: 35,
            attempts: 1,
            max_attempts: 3,
            retryable: false,
            started_at: Math.floor(Date.now() / 1000) - 12,
          },
          {
            id: 'job-failed',
            content_id: item.id,
            job_type: 'video_normalize',
            status: 'failed',
            stage: 'failed',
            progress_pct: 55,
            attempts: 3,
            max_attempts: 3,
            retryable: true,
            error_code: 'source_missing',
            started_at: Math.floor(Date.now() / 1000) - 30,
          },
        ]),
      });
    });
    let retryCalls = 0;
    let cancelCalls = 0;
    await page.route('**/api/content/jobs/job-failed/retry', async route => {
      retryCalls += 1;
      await route.fulfill({ status: 202, contentType: 'application/json', body: '{}' });
    });
    await page.route('**/api/content/jobs/job-running/cancel', async route => {
      cancelCalls += 1;
      await route.fulfill({ status: 202, contentType: 'application/json', body: '{}' });
    });

    await page.goto(`${BASE_URL}/app#/content`, { waitUntil: 'networkidle' });
    await page.getByRole('button', { name: 'Recent' }).click();
    await expect(page.locator('#contentSort')).toHaveValue('recent');

    await page.getByRole('button', { name: 'Processing center' }).click();
    const processing = page.locator('.media-processing-center');
    await expect(processing).toBeVisible();
    await expect(processing).toContainText('Creating poster');
    await expect(processing).toContainText('The source file is missing');
    for (const action of [
      processing.locator('[data-media-job-retry]'),
      processing.locator('[data-media-job-cancel]'),
    ]) {
      expect((await action.boundingBox()).height).toBeGreaterThanOrEqual(48);
    }
    await processing.locator('[data-media-job-retry]').click();
    await expect.poll(() => retryCalls).toBe(1);
    await processing.locator('[data-media-job-cancel]').click();
    await expect.poll(() => cancelCalls).toBe(1);
    await processing.locator('[data-close-dialog]').first().click();
    await expect(processing).toBeHidden();
    await expect(page).toHaveURL(`${BASE_URL}/app#/content`);
    await context.close();
  });

  test('Lenovo tablet keeps Poster Studio on Media Library with authenticated caption loading', async ({ browser }, testInfo) => {
    const context = await browser.newContext({
      viewport: { width: 838, height: 500 },
      hasTouch: true,
      serviceWorkers: 'block',
    });
    const page = await context.newPage();
    const diagnostics = [];
    const record = (type, details) => diagnostics.push({
      type,
      at: new Date().toISOString(),
      ...details,
    });
    page.on('pageerror', error => record('pageerror', { message: error.message }));
    page.on('console', message => {
      if (message.type() === 'error') {
        record('console-error', { message: message.text(), url: message.location().url || '' });
      }
    });
    page.on('requestfailed', request => record('request-failed', {
      method: request.method(),
      url: request.url(),
      failure: request.failure()?.errorText || '',
    }));
    page.on('framenavigated', frame => {
      if (frame === page.mainFrame()) record('navigation', { url: frame.url() });
    });

    try {
      await page.addInitScript(({ token, user }) => {
        localStorage.setItem('token', token);
        localStorage.setItem('user', JSON.stringify(user));
        localStorage.setItem('rd_onboarded', '1');
      }, { token: authToken, user: { id: userId, email: TEST_EMAIL, name: 'Mobile Test', role: 'platform_admin' } });

      const item = {
        id: 'poster-video',
        filename: 'Training video.mp4',
        filepath: 'training-video.mp4',
        mime_type: 'video/mp4',
        file_url: 'data:video/mp4;base64,',
        thumbnail_url: 'data:image/gif;base64,R0lGODlhAQABAAAAACw=',
        thumbnail_path: 'thumb_training.jpg',
        file_size: 1024,
        duration_sec: 90,
        created_at: '2026-01-01T00:00:00.000Z',
        processing_status: 'ready',
        version: 4,
        visibility: { access_level: 'private', owner_name: 'Mobile Test' },
        permissions: {
          can_edit: true,
          can_duplicate: true,
          can_transfer: true,
          can_archive: true,
          can_delete: true,
        },
        media: {
          thumbnail_generation: 2,
          thumbnail_provenance: 'video_timestamp:10:center',
        },
      };
      await page.route('**/api/content?**', async route => {
        const url = new URL(route.request().url());
        if (url.pathname !== '/api/content' || route.request().method() !== 'GET') {
          await route.fallback();
          return;
        }
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify([item]),
        });
      });
      let posterCalls = 0;
      let captionRequestSeen = false;
      let captionRequestAuthenticated = false;
      page.on('request', request => {
        const url = new URL(request.url());
        if (url.pathname !== '/api/captions/content/poster-video') return;
        captionRequestSeen = true;
        captionRequestAuthenticated = /^Bearer\s+\S+$/.test(
          request.headers().authorization || '',
        );
      });
      await page.route('**/api/content/poster-video/thumbnail/studio', async route => {
        posterCalls += 1;
        await route.fulfill({ status: 202, contentType: 'application/json', body: '{"id":"poster-job"}' });
      });

      await page.goto(`${BASE_URL}/app#/content`, { waitUntil: 'networkidle' });
      record('checkpoint', { name: 'before-poster-studio', url: page.url() });
      await page.locator('[data-thumbnail-studio="poster-video"]').click();
      record('checkpoint', { name: 'after-poster-studio-click', url: page.url() });

      const preview = page.locator('.media-preview-dialog');
      await expect(preview).toBeVisible();
      await expect(preview.locator('[data-thumbnail-studio-panel]')).toBeVisible();
      await expect.poll(() => captionRequestSeen).toBe(true);
      expect(captionRequestAuthenticated).toBe(true);
      await expect(page).toHaveURL(`${BASE_URL}/app#/content`);
      await preview.locator('[data-thumbnail-timestamp]').fill('12.5');
      await preview.locator('[data-thumbnail-position]').selectOption('top');
      await preview.locator('[data-thumbnail-generate]').click();
      await expect.poll(() => posterCalls).toBe(1);
      expect((await preview.locator('[data-thumbnail-generate]').boundingBox()).height)
        .toBeGreaterThanOrEqual(48);
      const overflow = await preview.evaluate(element => ({
        scrollW: element.scrollWidth,
        clientW: element.clientWidth,
      }));
      expect(overflow.scrollW).toBeLessThanOrEqual(overflow.clientW + 2);
    } finally {
      await testInfo.attach('poster-studio-route-diagnostics', {
        body: Buffer.from(JSON.stringify(diagnostics, null, 2)),
        contentType: 'application/json',
      });
      await context.close();
    }
  });

  test('Media Library keeps first, middle, and final page actions live after 73-item pagination', async ({ browser }) => {
    const context = await browser.newContext({
      viewport: { width: 838, height: 500 },
      hasTouch: true,
      serviceWorkers: 'block',
    });
    const page = await context.newPage();
    await page.addInitScript(({ token, user }) => {
      localStorage.setItem('token', token);
      localStorage.setItem('user', JSON.stringify(user));
      localStorage.setItem('rd_onboarded', '1');
    }, { token: authToken, user: { id: userId, email: TEST_EMAIL, name: 'Mobile Test', role: 'platform_admin' } });
    const items = Array.from({ length: 73 }, (_, index) => ({
      id: `content-${index + 1}`,
      filename: `Media ${String(index + 1).padStart(3, '0')}`,
      mime_type: 'image/png',
      file_url: 'data:image/gif;base64,R0lGODlhAQABAAAAACw=',
      file_size: index,
      created_at: new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString(),
      processing_status: 'ready',
      visibility: { access_level: 'private', owner_name: 'Mobile Test' },
      permissions: {
        can_edit: true,
        can_duplicate: true,
        can_transfer: true,
        can_archive: true,
        can_delete: true,
      },
      workspace_id: 'workspace-test',
      user_id: userId,
    }));
    await page.route('**/api/content?**', async route => {
      const url = new URL(route.request().url());
      if (url.pathname !== '/api/content' || route.request().method() !== 'GET') {
        await route.fallback();
        return;
      }
      const offset = Number(url.searchParams.get('offset') || 0);
      const limit = Number(url.searchParams.get('limit') || 60);
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(items.slice(offset, offset + limit)) });
    });

    await page.goto(`${BASE_URL}/app#/content`, { waitUntil: 'networkidle' });
    await expect(page.locator('.content-item')).toHaveCount(60);
    await page.locator('#contentLoadMore').tap();
    await expect(page.locator('.content-item')).toHaveCount(73);

    for (const id of ['content-1', 'content-37', 'content-73']) {
      const preview = page.locator(`[data-preview-content="${id}"]`);
      await preview.scrollIntoViewIfNeeded();
      await preview.click();
      const dialog = page.locator('.media-preview-dialog');
      await expect(dialog).toBeVisible();
      await expect(dialog).toContainText(items.find(item => item.id === id).filename);
      await dialog.locator('[data-close-dialog]').first().click();
      await expect(dialog).toBeHidden();
    }
    await context.close();
  });

  test('bulk permanent erase preserves zero-complete selection and retries only unfinished IDs after partial completion', async ({ browser }) => {
    const context = await browser.newContext({
      viewport: { width: 838, height: 500 },
      hasTouch: true,
      serviceWorkers: 'block',
    });
    const page = await context.newPage();
    await page.addInitScript(({ token, user }) => {
      localStorage.setItem('token', token);
      localStorage.setItem('user', JSON.stringify(user));
      localStorage.setItem('rd_onboarded', '1');
    }, { token: authToken, user: { id: userId, email: TEST_EMAIL, name: 'Mobile Test', role: 'platform_admin' } });

    const allItems = [
      { id: 'erase-alpha', filename: 'Alpha', file_size: 1 },
      { id: 'erase-bravo', filename: 'Bravo', file_size: 2 },
      { id: 'erase-charlie', filename: 'Charlie', file_size: 3 },
    ].map(item => ({
      ...item,
      mime_type: 'image/png',
      created_at: '2026-01-01T00:00:00.000Z',
      processing_status: 'ready',
      visibility: { access_level: 'private', owner_name: 'Mobile Test' },
      permissions: { can_delete: true },
      workspace_id: 'workspace-test',
      user_id: userId,
    }));
    let visibleIds = allItems.map(item => item.id);
    let listCalls = 0;
    let summaryCalls = 0;
    const eraseRequests = [];
    await page.route('**/api/content**', async route => {
      const request = route.request();
      const url = new URL(request.url());
      if (url.pathname === '/api/content' && request.method() === 'GET') {
        listCalls += 1;
        const rows = allItems.filter(item => visibleIds.includes(item.id));
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(rows) });
        return;
      }
      if (url.pathname === '/api/content/library-summary' && request.method() === 'GET') {
        summaryCalls += 1;
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ total_items: visibleIds.length, storage_bytes: visibleIds.length }),
        });
        return;
      }
      if (/^\/api\/content\/[^/]+\/erase-impact$/.test(url.pathname) && request.method() === 'GET') {
        const contentId = decodeURIComponent(url.pathname.split('/')[3]);
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ content_id: contentId, blockers: [], categories: {}, files: [] }),
        });
        return;
      }
      if (url.pathname === '/api/content/permanent-erase' && request.method() === 'POST') {
        const payload = request.postDataJSON();
        eraseRequests.push(payload.content_ids);
        if (eraseRequests.length === 1) {
          await route.fulfill({
            status: 409,
            contentType: 'application/json',
            body: JSON.stringify({
              code: 'ERASE_JOB_QUIESCENCE_REQUIRED',
              error: 'Permanent erase could not be completed safely.',
              completed_content_ids: [],
              failed_content_id: 'erase-alpha',
              impact: { blockers: [{ reason: 'The active job has not stopped.' }] },
            }),
          });
          return;
        }
        if (eraseRequests.length === 2) {
          visibleIds = ['erase-charlie'];
          await route.fulfill({
            status: 409,
            contentType: 'application/json',
            body: JSON.stringify({
              code: 'ERASE_DEPENDENCY_BLOCKED',
              error: 'Permanent erase could not be completed safely.',
              completed_content_ids: ['erase-alpha', 'erase-bravo'],
              failed_content_id: 'erase-charlie',
              impact: { blockers: [{ reason: 'A protected dependency remains.' }] },
            }),
          });
          return;
        }
        visibleIds = [];
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ success: true, results: [{ content_id: 'erase-charlie', success: true }] }),
        });
        return;
      }
      await route.fallback();
    });

    const confirmBulkErase = async () => {
      await page.locator('[data-bulk-erase]').click();
      const dialog = page.locator('.content-erase-dialog');
      await expect(dialog).toBeVisible();
      await dialog.locator('[data-erase-ack]').check();
      await dialog.locator('[data-confirm-erase]').click();
    };

    await page.goto(`${BASE_URL}/app#/content`, { waitUntil: 'networkidle' });
    for (const item of allItems) {
      await page.locator(`[data-select-content="${item.id}"]`).check({ force: true });
    }
    const initialListCalls = listCalls;
    const initialSummaryCalls = summaryCalls;

    await confirmBulkErase();
    await expect(page.locator('.toast.error').last()).toContainText('The media could not be permanently erased.');
    await expect(page.locator('#contentSelectedCount')).toHaveText('3 selected');
    expect(eraseRequests[0]).toEqual(['erase-alpha', 'erase-bravo', 'erase-charlie']);
    expect(listCalls).toBe(initialListCalls);
    expect(summaryCalls).toBe(initialSummaryCalls);
    await expect(page.locator('.toast.success').filter({ hasText: '3 media items were permanently erased.' })).toHaveCount(0);

    await confirmBulkErase();
    await expect(page.locator('.toast.error').last()).toContainText('2 media items were permanently erased.');
    await expect(page.locator('.toast.error').last()).toContainText('1 media item, “Charlie”, was not erased.');
    await expect(page.locator('.toast.error').last()).toContainText('The failed item has a dependency that cannot be detached safely.');
    await expect(page.locator('.toast.error').last()).toContainText('Retry will apply only to the 1 remaining item; already-erased media will not be retried.');
    await expect(page.locator('#contentSelectedCount')).toHaveText('1 selected');
    await expect(page.locator('[data-select-content="erase-charlie"]')).toBeChecked();
    await expect(page.locator('[data-content-id="erase-alpha"]')).toHaveCount(0);
    expect(eraseRequests[1]).toEqual(['erase-alpha', 'erase-bravo', 'erase-charlie']);
    expect(listCalls).toBeGreaterThan(initialListCalls);
    expect(summaryCalls).toBeGreaterThan(initialSummaryCalls);
    await expect(page.locator('.toast.success').filter({ hasText: '3 media items were permanently erased.' })).toHaveCount(0);

    await confirmBulkErase();
    await expect(page.locator('.toast.success').last()).toContainText('1 media item was permanently erased.');
    expect(eraseRequests[2]).toEqual(['erase-charlie']);
    await expect(page.locator('#contentBulkToolbar')).toBeHidden();
    await expect(page.locator('.content-item')).toHaveCount(0);
    await context.close();
  });

  test('bulk permanent erase keeps the failed item and untouched tail selected when the first item succeeds', async ({ browser }) => {
    const context = await browser.newContext({
      viewport: { width: 838, height: 500 },
      hasTouch: true,
      serviceWorkers: 'block',
    });
    const page = await context.newPage();
    await page.addInitScript(({ token, user }) => {
      localStorage.setItem('token', token);
      localStorage.setItem('user', JSON.stringify(user));
      localStorage.setItem('rd_onboarded', '1');
    }, { token: authToken, user: { id: userId, email: TEST_EMAIL, name: 'Mobile Test', role: 'platform_admin' } });

    const items = ['Alpha', 'Bravo', 'Charlie'].map(name => ({
      id: `quiesce-${name.toLowerCase()}`,
      filename: name,
      mime_type: 'image/png',
      file_size: 1,
      created_at: '2026-01-01T00:00:00.000Z',
      processing_status: 'ready',
      visibility: { access_level: 'private', owner_name: 'Mobile Test' },
      permissions: { can_delete: true },
      workspace_id: 'workspace-test',
      user_id: userId,
    }));
    let visibleIds = items.map(item => item.id);
    let eraseRequest = null;
    await page.route('**/api/content**', async route => {
      const request = route.request();
      const url = new URL(request.url());
      if (url.pathname === '/api/content' && request.method() === 'GET') {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(items.filter(item => visibleIds.includes(item.id))),
        });
        return;
      }
      if (/^\/api\/content\/[^/]+\/erase-impact$/.test(url.pathname) && request.method() === 'GET') {
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ blockers: [], categories: {}, files: [] }) });
        return;
      }
      if (url.pathname === '/api/content/permanent-erase' && request.method() === 'POST') {
        eraseRequest = request.postDataJSON().content_ids;
        visibleIds = ['quiesce-bravo', 'quiesce-charlie'];
        await route.fulfill({
          status: 409,
          contentType: 'application/json',
          body: JSON.stringify({
            code: 'ERASE_JOB_QUIESCENCE_REQUIRED',
            error: 'Permanent erase could not be completed safely.',
            completed_content_ids: ['quiesce-alpha'],
            failed_content_id: 'quiesce-bravo',
          }),
        });
        return;
      }
      await route.fallback();
    });

    await page.goto(`${BASE_URL}/app#/content`, { waitUntil: 'networkidle' });
    for (const item of items) {
      await page.locator(`[data-select-content="${item.id}"]`).check({ force: true });
    }
    await page.locator('[data-bulk-erase]').click();
    const dialog = page.locator('.content-erase-dialog');
    await dialog.locator('[data-erase-ack]').check();
    await dialog.locator('[data-confirm-erase]').click();

    expect(eraseRequest).toEqual(['quiesce-alpha', 'quiesce-bravo', 'quiesce-charlie']);
    await expect(page.locator('#contentSelectedCount')).toHaveText('2 selected');
    await expect(page.locator('[data-select-content="quiesce-bravo"]')).toBeChecked();
    await expect(page.locator('[data-select-content="quiesce-charlie"]')).toBeChecked();
    await expect(page.locator('.toast.error').last()).toContainText('1 media item was permanently erased.');
    await expect(page.locator('.toast.error').last()).toContainText('2 media items were not erased; “Bravo” was the first unfinished item.');
    await expect(page.locator('.toast.error').last()).toContainText('An active media job must stop safely before the failed item can be erased.');
    await expect(page.locator('.toast.success').filter({ hasText: '3 media items were permanently erased.' })).toHaveCount(0);
    await context.close();
  });

  test('Media Library ignores a slow stale search response after a newer search', async ({ browser }) => {
    const context = await browser.newContext({
      viewport: { width: 838, height: 500 },
      hasTouch: true,
      serviceWorkers: 'block',
    });
    const page = await context.newPage();
    await page.addInitScript(({ token, user }) => {
      localStorage.setItem('token', token);
      localStorage.setItem('user', JSON.stringify(user));
      localStorage.setItem('rd_onboarded', '1');
    }, { token: authToken, user: { id: userId, email: TEST_EMAIL, name: 'Mobile Test', role: 'platform_admin' } });
    const result = (id, filename) => [{
      id,
      filename,
      mime_type: 'image/png',
      file_url: 'data:image/gif;base64,R0lGODlhAQABAAAAACw=',
      file_size: 1,
      created_at: '2026-01-01T00:00:00.000Z',
      processing_status: 'ready',
      visibility: { access_level: 'private', owner_name: 'Mobile Test' },
      permissions: {},
    }];
    await page.route('**/api/content?**', async route => {
      const url = new URL(route.request().url());
      if (url.pathname !== '/api/content' || route.request().method() !== 'GET') {
        await route.fallback();
        return;
      }
      const search = url.searchParams.get('search') || '';
      if (search === 'slow') {
        await new Promise(resolve => setTimeout(resolve, 900));
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(result('slow', 'Slow stale result')) });
        return;
      }
      if (search === 'latest') {
        await new Promise(resolve => setTimeout(resolve, 20));
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(result('latest', 'Latest result')) });
        return;
      }
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(result('initial', 'Initial result')) });
    });

    await page.goto(`${BASE_URL}/app#/content`, { waitUntil: 'networkidle' });
    const search = page.locator('#contentSearch');
    await search.fill('slow');
    await page.waitForTimeout(300);
    await search.fill('latest');
    await expect(page.getByText('Latest result', { exact: true })).toBeVisible();
    await page.waitForTimeout(1000);
    await expect(page.getByText('Latest result', { exact: true })).toBeVisible();
    await expect(page.getByText('Slow stale result', { exact: true })).toHaveCount(0);
    await context.close();
  });

  test('transport buttons meet 48px touch target on mobile', async ({ browser }) => {
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true,
    });
    const page = await context.newPage();
    await page.addInitScript(({ token, user }) => {
        localStorage.setItem('token', token);
        localStorage.setItem('user', JSON.stringify(user));
        localStorage.setItem('rd_onboarded', '1');
      }, { token: authToken, user: { id: userId, email: TEST_EMAIL, name: 'Mobile Test', role: 'platform_admin' } });
    await page.goto(`${BASE_URL}/app#/control`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(2500);
    const transportBtns = page.locator('.mc-cc-tp-btn:visible');
    const count = await transportBtns.count();
    if (count > 0) {
      const box = await transportBtns.first().boundingBox();
      expect(box.height, 'transport button height').toBeGreaterThanOrEqual(48);
    }
    await context.close();
  });

  test('Lenovo 838x500 landscape keeps the display canvas above 48px transport controls with app chrome', async ({ browser }, testInfo) => {
    const context = await browser.newContext({
      viewport: { width: 838, height: 500 }, deviceScaleFactor: 1, isMobile: false, hasTouch: true,
    });
    const page = await context.newPage();
    await page.addInitScript(({ token, user }) => {
      localStorage.setItem('token', token);
      localStorage.setItem('user', JSON.stringify(user));
      localStorage.setItem('rd_onboarded', '1');
    }, { token: authToken, user: { id: userId, email: TEST_EMAIL, name: 'Mobile Test', role: 'platform_admin' } });
    await page.goto(`${BASE_URL}/app#/control`, { waitUntil: 'networkidle' });
    await expect(page.locator('.mc-cc-shell')).toBeVisible();
    await page.evaluate(() => {
      // Reproduce production app chrome that reserves space above #app. The
      // Command Center shell must consume its parent, not another full viewport.
      document.body.classList.add('has-classroom-banner');
      const transport = document.querySelector('.mc-cc-tp-row');
      if (transport) transport.hidden = false;
    });
    await page.waitForTimeout(250);

    const shell = await page.locator('.mc-cc-shell').boundingBox();
    const stage = await page.locator('.mc-stage.mc-cc-canvas').boundingBox();
    const controls = await page.locator('.mc-cc-controls').boundingBox();
    await page.screenshot({ path: testInfo.outputPath('command-center-current.png'), fullPage: true });
    expect(shell.y + shell.height, 'Command Center shell remains inside the usable viewport')
      .toBeLessThanOrEqual(500);
    expect(stage.y + stage.height, 'display canvas must end before controls begin').toBeLessThanOrEqual(controls.y + 1);
    expect(controls.y - (stage.y + stage.height), 'display canvas keeps a compact visible separation before controls')
      .toBeGreaterThanOrEqual(4);
    expect(controls.y + controls.height, 'controls remain inside the viewport').toBeLessThanOrEqual(500);

    const transportButtons = page.locator('.mc-cc-tp-btn:visible');
    expect(await transportButtons.count()).toBeGreaterThan(0);
    for (let index = 0; index < await transportButtons.count(); index += 1) {
      const box = await transportButtons.nth(index).boundingBox();
      expect(box.height, `transport button ${index} touch height`).toBeGreaterThanOrEqual(48);
    }
    const overflow = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      innerWidth: window.innerWidth,
    }));
    expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.innerWidth);

    const subRowGeometry = await page.locator('.mc-cc-controls > .mc-cc-sub-row').evaluate((row) => ({
      clientWidth: row.clientWidth,
      scrollWidth: row.scrollWidth,
      controls: Array.from(row.querySelectorAll('button, select')).map((element) => {
        const box = element.getBoundingClientRect();
        return { label: element.textContent?.trim() || element.getAttribute('aria-label'), left: box.left, right: box.right };
      }),
      viewportWidth: window.innerWidth,
    }));
    expect(subRowGeometry.scrollWidth, 'Span/Split and Screensaver controls fit without horizontal clipping')
      .toBeLessThanOrEqual(subRowGeometry.clientWidth + 1);
    for (const control of subRowGeometry.controls) {
      expect(control.left, `${control.label} starts inside the viewport`).toBeGreaterThanOrEqual(0);
      expect(control.right, `${control.label} ends inside the viewport`).toBeLessThanOrEqual(subRowGeometry.viewportWidth + 1);
    }

    const libraryTab = page.locator('.mc-library-tab:visible');
    const libraryTabBox = await libraryTab.boundingBox();
    expect(libraryTabBox.width).toBeGreaterThanOrEqual(48);
    expect(libraryTabBox.height).toBeGreaterThanOrEqual(48);
    expect(libraryTabBox.y, 'collapsed Content Library control remains attached to the viewport bottom')
      .toBeGreaterThanOrEqual(500 - libraryTabBox.height - 1);
    expect(libraryTabBox.y + libraryTabBox.height, 'collapsed Content Library control remains fully visible')
      .toBeLessThanOrEqual(501);

    const persistentSafetyAction = page.locator('#mc-dock-blank-btn');
    await persistentSafetyAction.scrollIntoViewIfNeeded();
    const safetyBox = await persistentSafetyAction.boundingBox();
    expect(safetyBox.x + safetyBox.width).toBeLessThanOrEqual(838 + 1);
    expect(safetyBox.height).toBeGreaterThanOrEqual(48);
    expect(await persistentSafetyAction.evaluate((element) => {
      const box = element.getBoundingClientRect();
      const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
      return hit === element || element.contains(hit);
    })).toBe(true);
    await context.close();
  });

  test('Lenovo Android portrait is a scrollable touch layout with truthful blank state', async ({ browser }) => {
    const { context, page } = await openAuthedControl(browser, {
      viewport: { width: 500, height: 838 },
      screen: { width: 800, height: 1340 },
      deviceScaleFactor: 1.6,
      isMobile: true,
      hasTouch: true,
      userAgent: 'Mozilla/5.0 (Linux; Android 14; Lenovo Tab One) AppleWebKit/537.36 Chrome/127 Mobile Safari/537.36',
    });
    const layout = await page.evaluate(() => {
      const body = document.querySelector('.mc-cc-body');
      const main = document.querySelector('.mc-cc-main');
      const dock = document.querySelector('.mc-action-dock-persistent');
      const mobileMenu = document.querySelector('.mobile-menu-btn');
      return {
        bodyColumns: getComputedStyle(body).gridTemplateColumns,
        internalRailPresent: !!document.querySelector('.mc-cc-rail'),
        mobileMenuVisible: !!mobileMenu && getComputedStyle(mobileMenu).display !== 'none'
          && mobileMenu.getBoundingClientRect().width > 0,
        mainOverflowY: getComputedStyle(main).overflowY,
        dockDisplay: getComputedStyle(dock).display,
        documentWidth: document.documentElement.scrollWidth,
        viewportWidth: window.innerWidth,
      };
    });
    expect(layout.bodyColumns.split(' ').length).toBe(1);
    expect(layout.internalRailPresent).toBe(false);
    expect(layout.mobileMenuVisible).toBe(true);
    expect(['auto', 'hidden']).toContain(layout.mainOverflowY);
    expect(layout.dockDisplay).toBe('flex');
    expect(layout.documentWidth).toBeLessThanOrEqual(layout.viewportWidth + 2);

    const stage = await page.locator('.mc-stage.mc-cc-canvas').boundingBox();
    const controls = await page.locator('.mc-cc-controls').boundingBox();
    expect(controls.y - (stage.y + stage.height)).toBeGreaterThanOrEqual(4);
    for (const button of await page.locator('.mc-cc-tp-btn:visible').all()) {
      const box = await button.boundingBox();
      expect(box.height).toBeGreaterThanOrEqual(48);
      expect(box.width).toBeGreaterThanOrEqual(48);
    }

    const blank = page.locator('#mc-dock-blank-btn');
    await blank.scrollIntoViewIfNeeded();
    await expect(page.locator('[data-blank-status]')).toHaveText('On');
    await expect(blank).toHaveText('Blank wall');
    await blank.tap();
    await expect(page.locator('[data-blank-status]')).not.toHaveText('Blanked');
    await expect(blank).not.toHaveText('Unblank wall');
    await context.close();
  });

  test('orientation change preserves target and keeps Content Library usable without reload', async ({ browser }) => {
    const { context, page } = await openAuthedControl(browser, {
      viewport: { width: 838, height: 500 },
      screen: { width: 1340, height: 800 },
      deviceScaleFactor: 1.6,
      isMobile: true,
      hasTouch: true,
    });
    const activeLabel = await page.locator('.mc-target-wall-btn.is-active').textContent();
    await page.locator('[data-cc-tp="next"]').tap();

    await page.setViewportSize({ width: 500, height: 838 });
    await expect(page.locator('.mc-cc-shell')).toBeVisible();
    await expect(page.locator('.mc-target-wall-btn.is-active')).toHaveText(activeLabel.trim());
    const headerBox = await page.locator('.mc-cc-head').boundingBox();
    const closedLibraryTab = await page.locator('.mc-library-tab:visible').boundingBox();
    expect(closedLibraryTab.width).toBeGreaterThanOrEqual(48);
    expect(closedLibraryTab.height).toBeGreaterThanOrEqual(48);
    expect(closedLibraryTab.y).toBeGreaterThanOrEqual(headerBox.y + headerBox.height);
    await page.locator('[data-library-toggle]').first().tap();
    const drawer = page.locator('#mc-library-drawer');
    await expect(drawer).toHaveAttribute('data-open', 'true');
    const drawerBox = await drawer.boundingBox();
    expect(drawerBox.width).toBeLessThanOrEqual(501);
    expect(drawerBox.y).toBeGreaterThanOrEqual(headerBox.y + headerBox.height);
    await page.locator('[data-library-toggle]').first().tap();
    await expect(drawer).toHaveAttribute('data-open', 'false');

    await page.setViewportSize({ width: 838, height: 500 });
    await expect(page.locator('.mc-target-wall-btn.is-active')).toHaveText(activeLabel.trim());
    const overflow = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      innerWidth: window.innerWidth,
    }));
    expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.innerWidth + 2);
    await context.close();
  });

  test('responsive breakpoint and desktop matrix has no overflow, overlap, or occluded transport targets', async ({ browser }) => {
    const mobileViewports = [
      [767, 700], [768, 700], [769, 700], [800, 600],
      [837, 500], [838, 500], [839, 500], [900, 600],
      [1023, 600], [1024, 600], [768, 1024], [800, 1280], [1024, 768],
    ];
    const desktopViewports = [[1025, 600], [1280, 800], [1366, 768], [1440, 900], [1920, 1080]];

    async function audit(page, width, height, touch) {
      await page.setViewportSize({ width, height });
      await page.waitForTimeout(80);
      const geometry = await page.evaluate(() => {
        const stage = document.querySelector('.mc-stage.mc-cc-canvas')?.getBoundingClientRect();
        const controls = document.querySelector('.mc-cc-controls')?.getBoundingClientRect();
        const shell = document.querySelector('.mc-cc-shell')?.getBoundingClientRect();
        const subRow = document.querySelector('.mc-cc-controls > .mc-cc-sub-row');
        return {
          documentWidth: document.documentElement.scrollWidth,
          viewportWidth: window.innerWidth,
          shellRight: shell?.right,
          shellBottom: shell?.bottom,
          gap: stage && controls ? controls.top - stage.bottom : null,
          subRowClientWidth: subRow?.clientWidth,
          subRowScrollWidth: subRow?.scrollWidth,
        };
      });
      expect(geometry.documentWidth, `${width}x${height} horizontal overflow`).toBeLessThanOrEqual(geometry.viewportWidth + 2);
      expect(geometry.shellRight, `${width}x${height} shell right`).toBeLessThanOrEqual(width + 1);
      expect(geometry.shellBottom, `${width}x${height} shell bottom`).toBeLessThanOrEqual(height + 1);
      expect(geometry.gap, `${width}x${height} preview clearance`).toBeGreaterThanOrEqual(4);
      expect(geometry.subRowScrollWidth, `${width}x${height} primary sub-row content is not clipped`)
        .toBeLessThanOrEqual(geometry.subRowClientWidth + 1);

      const buttons = page.locator('.mc-cc-tp-btn:visible');
      for (let index = 0; index < await buttons.count(); index += 1) {
        const button = buttons.nth(index);
        await button.scrollIntoViewIfNeeded();
        const box = await button.boundingBox();
        if (touch) {
          expect(box.height, `${width}x${height} transport ${index} height`).toBeGreaterThanOrEqual(48);
          expect(box.width, `${width}x${height} transport ${index} width`).toBeGreaterThanOrEqual(48);
        }
        const receivesCenterTap = await button.evaluate((element) => {
          const box = element.getBoundingClientRect();
          const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
          return hit === element || element.contains(hit);
        });
        expect(receivesCenterTap, `${width}x${height} transport ${index} center hit`).toBe(true);
      }
    }

    const mobile = await openAuthedControl(browser, {
      viewport: { width: 838, height: 500 }, isMobile: true, hasTouch: true, deviceScaleFactor: 1.6,
    });
    for (const [width, height] of mobileViewports) await audit(mobile.page, width, height, true);
    await mobile.context.close();

    const desktop = await openAuthedControl(browser, { viewport: { width: 1280, height: 800 } });
    for (const [width, height] of desktopViewports) await audit(desktop.page, width, height, false);
    await desktop.context.close();
  });

  for (const visual of [
    { name: 'lenovo-landscape', width: 838, height: 500, mobile: true },
    { name: 'lenovo-portrait', width: 500, height: 838, mobile: true },
    { name: 'desktop', width: 1440, height: 900, mobile: false },
  ]) {
    test(`Command Center visual regression — ${visual.name}`, async ({ browser }, testInfo) => {
      const { context, page } = await openAuthedControl(browser, {
        viewport: { width: visual.width, height: visual.height },
        isMobile: visual.mobile,
        hasTouch: visual.mobile,
        deviceScaleFactor: visual.mobile ? 1.6 : 1,
      });
      await waitForCommandCenterVisualReady(page);
      await expect(page).toHaveScreenshot(`command-center-${visual.name}-${testInfo.project.name}.png`, {
        animations: 'disabled',
        caret: 'hide',
        mask: [page.locator('#mc-cam-health'), page.locator('#mc-live-ladder')],
        maxDiffPixelRatio: 0.01,
      });
      await context.close();
    });
  }

  test('desktop baseline 1920x1080 — target nav still visible', async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
    const page = await context.newPage();
    await page.addInitScript(({ token, user }) => {
        localStorage.setItem('token', token);
        localStorage.setItem('user', JSON.stringify(user));
        localStorage.setItem('rd_onboarded', '1');
      }, { token: authToken, user: { id: userId, email: TEST_EMAIL, name: 'Mobile Test', role: 'platform_admin' } });
    await page.goto(`${BASE_URL}/app#/control`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(2000);
    const targetHost = page.locator('.mc-cc-target').first();
    await expect(targetHost).toBeAttached();
    const display = await targetHost.evaluate((el) => window.getComputedStyle(el).display);
    expect(display).not.toBe('none');
    await context.close();
  });

  test('an operator wall click wins over a delayed startup preference response', async ({ browser }) => {
    const Database = require('better-sqlite3');
    const dbPath = path.join(tmpDir, 'test.db');
    const database = new Database(dbPath, { timeout: 10000 });
    const workspaceId = database.prepare(
      'SELECT workspace_id FROM workspace_members WHERE user_id = ? LIMIT 1'
    ).get(userId)?.workspace_id;
    const now = Math.floor(Date.now() / 1000) + 3600;
    database.transaction(() => {
      database.prepare(`
        INSERT INTO devices (id, user_id, workspace_id, name, pairing_code, status, last_heartbeat, wall_id, screen_on)
        VALUES ('mobile-secondary-display', ?, ?, 'Secondary Display', '820099', 'online', ?, 'mobile-secondary-wall', 1)
      `).run(userId, workspaceId, now);
      database.prepare(`
        INSERT INTO display_states
          (target_type, target_id, workspace_id, screen_on, command_revision, state_revision, updated_at)
        VALUES ('display', 'mobile-secondary-display', ?, 1, 'fixture-on', 1, ?)
      `).run(workspaceId, Date.now());
      database.prepare(`
        INSERT INTO video_walls (id, user_id, workspace_id, name, grid_cols, grid_rows, is_locked, layout_mode)
        VALUES ('mobile-secondary-wall', ?, ?, 'Classroom 1 Secondary Wall', 1, 1, 1, 'span')
      `).run(userId, workspaceId);
      database.prepare(`
        INSERT INTO video_wall_devices
          (wall_id, device_id, grid_col, grid_row, canvas_x, canvas_y, canvas_width, canvas_height)
        VALUES ('mobile-secondary-wall', 'mobile-secondary-display', 0, 0, 0, 0, 1920, 1080)
      `).run();
      database.prepare(`
        UPDATE video_walls
        SET layout_mode = 'groups', layout_revision = 7, layout_json = ?
        WHERE id = 'mobile-command-wall'
      `).run(JSON.stringify({
        version: 1,
        revision: 7,
        preset: 'span-left',
        groups: [
          {
            id: 'mobile-primary-pair',
            name: 'Front Pair',
            layout: 'span',
            member_ids: ['mobile-wall-display-1', 'mobile-wall-display-2'],
            leader_device_id: 'mobile-wall-display-1',
          },
          {
            id: 'mobile-primary-solo',
            name: 'Front Right',
            layout: 'solo',
            member_ids: ['mobile-wall-display-3'],
            leader_device_id: 'mobile-wall-display-3',
          },
        ],
      }));
    })();
    database.close();

    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    try {
      await page.addInitScript(() => {
        const nativeFetch = window.fetch.bind(window);
        const state = {
          mode: 'operator',
          operator_ref: 'wall:mobile-command-wall',
          operator_loads: 0,
          restore_ref: 'wall:mobile-secondary-wall',
          restore_loads: 0,
          lifecycle_loads: 0,
        };
        window.__mcPreferenceTestState = state;
        window.fetch = async (input, init = {}) => {
          const requestUrl = new URL(typeof input === 'string' ? input : input.url, window.location.origin);
          const method = String(init.method || (typeof input === 'object' && input.method) || 'GET').toUpperCase();
          if (method !== 'GET' || requestUrl.pathname !== '/api/displays/control-preferences') {
            return nativeFetch(input, init);
          }
          const mode = state.mode;
          const operatorLoadNumber = mode === 'operator' ? ++state.operator_loads : 0;
          const restoreLoadNumber = mode === 'restore' ? ++state.restore_loads : 0;
          const loadNumber = mode === 'lifecycle' ? ++state.lifecycle_loads : 0;
          if (mode === 'operator' || loadNumber === 1) {
            await new Promise((resolve) => setTimeout(resolve, 1500));
          }
          const restoredRef = mode === 'operator'
            ? state.operator_ref
            : (mode === 'restore'
              ? state.restore_ref
              : (loadNumber === 1 ? 'wall:mobile-command-wall' : 'wall:mobile-secondary-wall'));
          return new Response(JSON.stringify({
            room_id: 'classroom-1',
            last_focused_target_ref: restoredRef,
            pinned_target_refs: [],
            revision: Math.max(1, operatorLoadNumber, restoreLoadNumber, loadNumber),
          }), { status: 200, headers: { 'Content-Type': 'application/json' } });
        };
      });
      await page.addInitScript(({ token, user }) => {
        localStorage.setItem('token', token);
        localStorage.setItem('user', JSON.stringify(user));
        localStorage.setItem('rd_onboarded', '1');
      }, {
        token: authToken,
        user: {
          id: userId,
          email: TEST_EMAIL,
          name: 'Mobile Test',
          role: 'platform_admin',
          current_workspace_id: workspaceId,
        },
      });
      await page.goto(`${BASE_URL}/app#/control`, { waitUntil: 'domcontentloaded' });
      const secondary = page.locator('.mc-target-wall-btn[data-target-value="wall:mobile-secondary-wall"]');
      const visibleWallStages = page.locator('#mc-stage > [data-wall-id]:visible');
      await test.step('Scenario B: Wall 2 wins over a delayed Wall 1 preference', async () => {
        await expect(secondary).toBeVisible();
        await expect.poll(() => page.evaluate(() => window.__mcPreferenceTestState.operator_loads))
          .toBeGreaterThanOrEqual(1);
        await secondary.click();
        await expect(secondary).toHaveAttribute('aria-selected', 'true');
        await expect(secondary).toHaveClass(/is-active/);
        await page.waitForTimeout(2000);
        await expect(secondary).toHaveAttribute('aria-selected', 'true');
        await expect(secondary).toHaveClass(/is-active/);
        await expect(visibleWallStages).toHaveCount(1);
        await expect(visibleWallStages).toHaveAttribute('data-wall-id', 'mobile-secondary-wall');
      });

      await test.step('Scenario A: Wall 1 wins over a delayed Wall 2 preference', async () => {
        await page.evaluate(() => {
          Object.assign(window.__mcPreferenceTestState, {
            mode: 'operator',
            operator_ref: 'wall:mobile-secondary-wall',
            operator_loads: 0,
          });
          window.location.hash = '#/content';
        });
        await expect(page.locator('.media-library-page')).toBeVisible();
        await page.evaluate(() => { window.location.hash = '#/control'; });
        await expect.poll(() => page.evaluate(() => window.__mcPreferenceTestState.operator_loads)).toBe(1);
        const primary = page.locator('.mc-target-wall-btn[data-target-value="wall:mobile-command-wall"]');
        await primary.click();
        await expect(primary).toHaveAttribute('aria-selected', 'true');
        await page.waitForTimeout(2000);
        await expect(primary).toHaveAttribute('aria-selected', 'true');
        await expect(primary).toHaveClass(/is-active/);
        await expect(visibleWallStages).toHaveCount(1);
        await expect(visibleWallStages).toHaveAttribute('data-wall-id', 'mobile-command-wall');
      });

      await test.step('Scenario C: a wall group wins over a delayed wall preference', async () => {
        await page.evaluate(() => {
          Object.assign(window.__mcPreferenceTestState, {
            mode: 'operator',
            operator_ref: 'wall:mobile-secondary-wall',
            operator_loads: 0,
          });
          window.location.hash = '#/content';
        });
        await expect(page.locator('.media-library-page')).toBeVisible();
        await page.evaluate(() => { window.location.hash = '#/control'; });
        await expect.poll(() => page.evaluate(() => window.__mcPreferenceTestState.operator_loads)).toBe(1);
        await page.locator('.mc-target-select').selectOption('group:mobile-primary-pair');
        const group = page.locator('.mc-wall-region[data-layout-group-id="mobile-primary-pair"]');
        await expect(group).toHaveClass(/is-active/);
        await page.waitForTimeout(2000);
        await expect(group).toHaveClass(/is-active/);
      });

      await test.step('Scenario D: no intervention restores the persisted target', async () => {
        await page.evaluate(() => {
          Object.assign(window.__mcPreferenceTestState, {
            mode: 'restore',
            restore_ref: 'wall:mobile-secondary-wall',
            restore_loads: 0,
          });
          window.location.hash = '#/content';
        });
        await expect(page.locator('.media-library-page')).toBeVisible();
        await page.evaluate(() => { window.location.hash = '#/control'; });
        await expect.poll(() => page.evaluate(() => window.__mcPreferenceTestState.restore_loads)).toBe(1);
        await expect(secondary).toHaveAttribute('aria-selected', 'true');
        await expect(secondary).toHaveClass(/is-active/);
      });

      await test.step('Scenario E: an unmounted restore cannot overwrite the next rendered control view', async () => {
        await page.evaluate(({ key, value }) => {
          window.__mcPreferenceTestState.mode = 'lifecycle';
          window.__mcPreferenceTestState.lifecycle_loads = 0;
          localStorage.setItem(key, JSON.stringify(value));
          window.location.hash = '#/content';
        }, {
          key: `mc:control-prefs:v2:${userId}:${workspaceId}:classroom-1`,
          value: {
            room_id: 'classroom-1',
            last_focused_target_ref: 'wall:mobile-command-wall',
            pinned_target_refs: [],
            revision: 1,
          },
        });
        await expect(page.locator('.media-library-page')).toBeVisible();

        await page.evaluate(() => { window.location.hash = '#/control'; });
        await expect(page.locator('.mc-cc-shell')).toBeVisible();
        await expect.poll(() => page.evaluate(() => window.__mcPreferenceTestState.lifecycle_loads)).toBe(1);
        await page.evaluate(() => { window.location.hash = '#/content'; });
        await expect(page.locator('.media-library-page')).toBeVisible();
        await page.evaluate(() => { window.location.hash = '#/control'; });
        await expect.poll(() => page.evaluate(() => window.__mcPreferenceTestState.lifecycle_loads))
          .toBeGreaterThanOrEqual(2);
        await expect(secondary).toHaveAttribute('aria-selected', 'true');
        await expect(secondary).toHaveClass(/is-active/);
        await page.waitForTimeout(2000);
        await expect(secondary).toHaveAttribute('aria-selected', 'true');
        await expect(secondary).toHaveClass(/is-active/);
      });
    } finally {
      await context.close();
      const cleanup = new Database(dbPath, { timeout: 10000 });
      cleanup.transaction(() => {
        cleanup.prepare(`
          UPDATE video_walls
          SET layout_mode = 'span', layout_json = NULL, layout_revision = 0
          WHERE id = 'mobile-command-wall'
        `).run();
        cleanup.prepare('DELETE FROM control_preferences WHERE user_id = ?').run(userId);
        cleanup.prepare("DELETE FROM video_wall_devices WHERE wall_id='mobile-secondary-wall'").run();
        cleanup.prepare("DELETE FROM display_states WHERE target_id='mobile-secondary-display'").run();
        cleanup.prepare("DELETE FROM video_walls WHERE id='mobile-secondary-wall'").run();
        cleanup.prepare("DELETE FROM devices WHERE id='mobile-secondary-display'").run();
      })();
      cleanup.close();
    }
  });
});
