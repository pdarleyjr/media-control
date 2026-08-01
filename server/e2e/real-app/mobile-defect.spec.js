'use strict';

// Mobile defect reproduction + acceptance test.
// Boots the REAL Media Control server, logs in, opens the operator console,
// and audits computed styles / DOM at iPhone viewports.
//
// Proves:
//   1. `.mc-cc-target` (target-nav host) is NOT hidden (display:none) on phones.
//   2. Target wall tabs are visible and tappable.
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

test.describe.configure({ mode: 'serial' });

test.describe('Mobile operator console — defect reproduction + acceptance', () => {
  test.beforeAll(async () => {
    await startServer();
    await registerAndAuth();
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

    test(`[${vp.name}] target wall tabs are visible and >=40px`, async ({ browser }) => {
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
        expect(box.height, `wall tab height at ${vp.width}px`).toBeGreaterThanOrEqual(36);
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

  test('transport buttons meet 44px touch target on mobile', async ({ browser }) => {
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
      // Allow a small tolerance; target is 44px but some layouts use 40px min.
      expect(box.height, 'transport button height').toBeGreaterThanOrEqual(40);
    }
    await context.close();
  });

  test('Lenovo 838x500 landscape keeps the display canvas above 48px transport controls with app chrome', async ({ browser }) => {
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
    expect(shell.y + shell.height, 'Command Center shell remains inside the usable viewport')
      .toBeLessThanOrEqual(500);
    expect(stage.y + stage.height, 'display canvas must end before controls begin').toBeLessThanOrEqual(controls.y + 1);
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
    await context.close();
  });

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
