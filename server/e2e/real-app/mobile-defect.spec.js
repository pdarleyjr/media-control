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
    expect(controls.y - (stage.y + stage.height), 'display canvas needs deliberate finger-safe clearance before controls')
      .toBeGreaterThanOrEqual(12);
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

    const libraryTab = page.locator('.mc-library-tab:visible');
    const header = await page.locator('.mc-cc-head').boundingBox();
    const libraryTabBox = await libraryTab.boundingBox();
    expect(libraryTabBox.width).toBeGreaterThanOrEqual(48);
    expect(libraryTabBox.height).toBeGreaterThanOrEqual(48);
    expect(libraryTabBox.y + libraryTabBox.height, 'collapsed Content Library control stays in the header track')
      .toBeLessThanOrEqual(header.y + header.height + 1);

    const lastDockAction = page.locator('[data-dock="add-display"]');
    await lastDockAction.scrollIntoViewIfNeeded();
    const lastDockBox = await lastDockAction.boundingBox();
    expect(lastDockBox.x + lastDockBox.width).toBeLessThanOrEqual(838 + 1);
    expect(lastDockBox.height).toBeGreaterThanOrEqual(48);
    expect(await lastDockAction.evaluate((element) => {
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
      const rail = document.querySelector('.mc-cc-rail');
      const main = document.querySelector('.mc-cc-main');
      const dock = document.querySelector('.mc-action-dock');
      return {
        bodyColumns: getComputedStyle(body).gridTemplateColumns,
        railDirection: getComputedStyle(rail).flexDirection,
        mainOverflowY: getComputedStyle(main).overflowY,
        dockColumns: getComputedStyle(dock).gridTemplateColumns,
        documentWidth: document.documentElement.scrollWidth,
        viewportWidth: window.innerWidth,
      };
    });
    expect(layout.bodyColumns.split(' ').length).toBe(1);
    expect(layout.railDirection).toBe('row');
    expect(layout.mainOverflowY).toBe('auto');
    expect(layout.dockColumns.split(' ').length).toBe(2);
    expect(layout.documentWidth).toBeLessThanOrEqual(layout.viewportWidth + 2);

    const stage = await page.locator('.mc-stage.mc-cc-canvas').boundingBox();
    const controls = await page.locator('.mc-cc-controls').boundingBox();
    expect(controls.y - (stage.y + stage.height)).toBeGreaterThanOrEqual(12);
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
    await page.locator('.mc-library-collapse').tap();
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
        return {
          documentWidth: document.documentElement.scrollWidth,
          viewportWidth: window.innerWidth,
          shellRight: shell?.right,
          shellBottom: shell?.bottom,
          gap: stage && controls ? controls.top - stage.bottom : null,
        };
      });
      expect(geometry.documentWidth, `${width}x${height} horizontal overflow`).toBeLessThanOrEqual(geometry.viewportWidth + 2);
      expect(geometry.shellRight, `${width}x${height} shell right`).toBeLessThanOrEqual(width + 1);
      expect(geometry.shellBottom, `${width}x${height} shell bottom`).toBeLessThanOrEqual(height + 1);
      expect(geometry.gap, `${width}x${height} preview clearance`).toBeGreaterThanOrEqual(12);

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
      await page.waitForTimeout(500);
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
});
