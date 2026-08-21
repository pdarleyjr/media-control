'use strict';

const { test, expect } = require('@playwright/test');
const { spawn, execSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const SERVER_DIR = path.resolve(__dirname, '..', '..');
const PORT = 18109;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const JWT_SECRET = 'presentation-studio-browser-jwt-secret-hs256-long-enough';
const EMAIL = 'presentation-studio@test.local';
const PASSWORD = 'presentation-studio-test-password';
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2mVQAAAAASUVORK5CYII=', 'base64');

let serverProcess = null;
let tempDir = '';
let dbPath = '';
let sourcePptx = '';
let imagePath = '';
let token = '';
let user = null;
let workspaceId = '';
let twoDisplayId = '';
let threeDisplayId = '';

function killServer() {
  if (!serverProcess) return;
  try {
    if (process.platform === 'win32') execSync(`taskkill /pid ${serverProcess.pid} /T /F`, { stdio: 'ignore' });
    else process.kill(serverProcess.pid, 'SIGKILL');
  } catch { /* best effort */ }
  serverProcess = null;
}

async function waitForServer() {
  const deadline = Date.now() + 45000;
  while (Date.now() < deadline) {
    if (serverProcess?.exitCode != null) throw new Error(`Presentation test server exited early: ${serverProcess.exitCode}`);
    try { const response = await fetch(`${BASE_URL}/api/version`); if (response.ok) return; } catch { /* retry */ }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new Error('Presentation test server did not become ready');
}

async function startServer({ enabled, reuseDb }) {
  killServer();
  if (!reuseDb) {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-presentation-browser-'));
    dbPath = path.join(tempDir, 'test.db');
    sourcePptx = path.join(tempDir, 'representative.pptx');
    imagePath = path.join(tempDir, 'fixture.png');
    fs.writeFileSync(imagePath, PNG);
    const PptxGenJS = require(path.join(SERVER_DIR, 'node_modules', 'pptxgenjs'));
    const pptx = new PptxGenJS(); pptx.layout = 'LAYOUT_WIDE';
    const slide = pptx.addSlide();
    slide.addText('Ventilation Coordination', { x: .7, y: .6, w: 7, h: .7, fontSize: 30, bold: true });
    slide.addText('Preserve this paragraph as instructor-authored prose. '.repeat(55), { x: .7, y: 1.5, w: 8, h: 4.5, fontSize: 17 });
    slide.addNotes('Coordinate the teaching points with the incident commander role.');
    await pptx.writeFile({ fileName: sourcePptx });
  }
  serverProcess = spawn(process.execPath, ['server.js'], {
    cwd: SERVER_DIR,
    env: {
      ...process.env,
      PORT: String(PORT), DB_PATH: dbPath, JWT_SECRET,
      NODE_ENV: 'development', SELF_HOSTED: 'true', DISABLE_REGISTRATION: 'false',
      ENABLE_PRESENTATION_STUDIO_V2: enabled ? 'true' : 'false',
      ENABLE_PRESENTATION_CONVERTER: enabled ? 'true' : 'false',
      OLLAMA_BASE_URL: 'http://127.0.0.1:1',
      PLAYER_DEBUG_REPORTING: 'off',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await waitForServer();
}

async function register() {
  const response = await fetch(`${BASE_URL}/api/auth/register`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD, name: 'Presentation Browser Test' }),
  });
  expect(response.ok).toBe(true);
  const body = await response.json(); token = body.token; user = body.user; workspaceId = body.current_workspace_id;
}

async function login() {
  const response = await fetch(`${BASE_URL}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ identifier: EMAIL, password: PASSWORD }),
  });
  expect(response.ok).toBe(true);
  const body = await response.json(); token = body.token; user = body.user; workspaceId = body.current_workspace_id || workspaceId;
}

function seedSafeTargets() {
  const Database = require(path.join(SERVER_DIR, 'node_modules', 'better-sqlite3'));
  const db = new Database(dbPath);
  try {
    const now = Math.floor(Date.now() / 1000);
    const insert = db.prepare(`INSERT INTO devices
      (id,user_id,workspace_id,name,pairing_code,status,last_heartbeat)
      VALUES (?,?,?,?,?,'online',?)`);
    insert.run('presentation-safe-target', user.id, workspaceId, 'Safe Presentation Test Display', '819901', now);
    insert.run('presentation-spare-target', user.id, workspaceId, 'Spare Presentation Test Display', '819902', now);
  } finally { db.close(); }
}

function refreshSafeTargetHeartbeat() {
  const Database = require(path.join(SERVER_DIR, 'node_modules', 'better-sqlite3'));
  const db = new Database(dbPath);
  try {
    db.prepare("UPDATE devices SET status='online',last_heartbeat=? WHERE id IN ('presentation-safe-target','presentation-spare-target')")
      .run(Math.floor(Date.now() / 1000));
  } finally { db.close(); }
}

async function authPage(page) {
  await page.context().addCookies([{
    name: 'mc_token',
    value: token,
    url: BASE_URL,
    httpOnly: true,
    sameSite: 'Strict',
  }]);
  await page.addInitScript(({ authToken, authUser }) => {
    localStorage.setItem('token', authToken);
    localStorage.setItem('user', JSON.stringify(authUser));
    localStorage.setItem('rd_onboarded', '1');
  }, { authToken: token, authUser: user });
}

function collectErrors(page) {
  const errors = [];
  page.on('pageerror', (error) => errors.push(`page: ${error.message}`));
  page.on('console', (message) => { if (message.type() === 'error') errors.push(`console: ${message.text()}`); });
  page.on('requestfailed', (request) => {
    if (!request.url().includes('cloudflareinsights')) errors.push(`request: ${request.url()} ${request.failure()?.errorText}`);
  });
  return errors;
}

async function apiJson(relative, options = {}) {
  const response = await fetch(`${BASE_URL}/api${relative}`, {
    ...options,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(options.headers || {}) },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${relative} returned ${response.status}: ${JSON.stringify(body)}`);
  return body;
}

function readDeck(id) {
  const Database = require(path.join(SERVER_DIR, 'node_modules', 'better-sqlite3'));
  const db = new Database(dbPath, { readonly: true });
  try { return JSON.parse(db.prepare('SELECT deck_json FROM presentations WHERE id=?').get(id).deck_json); }
  finally { db.close(); }
}

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  await startServer({ enabled: false, reuseDb: false });
  await register();
  seedSafeTargets();
});

test.afterAll(() => {
  killServer();
  if (dbPath && fs.existsSync(dbPath)) {
    const Database = require(path.join(SERVER_DIR, 'node_modules', 'better-sqlite3'));
    const db = new Database(dbPath, { readonly: true });
    try {
      const contentRoot = path.join(SERVER_DIR, 'uploads', 'content');
      for (const row of db.prepare('SELECT filepath,original_filepath,thumbnail_path FROM content WHERE user_id=?').all(user?.id || '')) {
        for (const stored of [row.filepath, row.original_filepath, row.thumbnail_path]) {
          if (!stored) continue;
          const resolved = path.resolve(contentRoot, path.basename(stored));
          if (path.dirname(resolved) === path.resolve(contentRoot)) fs.rmSync(resolved, { force: true });
        }
      }
    } finally { db.close(); }
  }
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
});

test('flags default off and legacy presentation routes remain available', async ({ page }) => {
  const features = await apiJson('/features');
  expect(features.features.presentationStudioV2).toEqual({ enabled: false, authorized: false });
  expect(features.features.presentationConverter).toEqual({ enabled: false, authorized: false });
  await authPage(page);
  await page.goto(`${BASE_URL}/app#/presentation-studio`);
  await expect(page.locator('.mc-studio-title')).toHaveText('Presentations');
  await expect(page.locator('#presentationStudioNavItem')).toBeHidden();
  await expect(page.locator('.legacy-presentation-nav').first()).toBeVisible();
});

test('enabled Studio creates, edits, preserves layout leftovers, saves, reloads, previews, exports, and presents a two-display deck', async ({ page }) => {
  await startServer({ enabled: true, reuseDb: true }); await login();
  const errors = collectErrors(page); await authPage(page);
  await page.goto(`${BASE_URL}/app#/presentation-studio`);
  await expect(page.getByRole('heading', { name: 'Presentation Studio' })).toBeVisible();
  await expect(page.locator('#presentationStudioNavItem')).toBeVisible();
  await expect(page.locator('#presentationConverterNavItem')).toBeVisible();
  await expect(page.getByText('YouTube Downloader', { exact: true })).toBeVisible();
  await expect(page.locator('.legacy-presentation-nav').first()).toBeHidden();

  await page.locator('#studioNewTitle').fill('Two Display Browser Deck');
  await page.locator('#studioNewProfile').selectOption('wall-2x4k-7680x2160');
  await page.locator('#studioCreate').click();
  await page.waitForURL(/#\/presentation-studio\?id=/);
  twoDisplayId = new URL(page.url()).hash.split('id=')[1];
  await page.getByRole('button', { name: 'Add slide' }).click();
  await page.locator('#studioLayout').selectOption('STANDARD_PARAGRAPH');
  await page.locator('[data-slot-text="TV1_TITLE"]').fill('Operational Priorities');
  await page.locator('[data-slot-text="TV1_PARAGRAPH"]').fill('This exact paragraph must survive layout changes and browser reloads.');
  await page.locator('[data-speaker-notes]').fill('Instructor note retained by the canonical deck.');
  await page.locator('#studioLayout').selectOption('STANDARD_BULLETS');
  await expect(page.locator('.studio-slide-row')).toHaveCount(2);
  await page.locator('#studioImageUpload').setInputFiles(imagePath);
  await expect(page.locator('#studioStageViewport img[src*="/player/asset/"]')).toBeVisible({ timeout: 20000 });
  await page.locator('#studioSave').click();
  await expect(page.locator('#studioStatus')).toHaveText('Presentation saved');
  let deck = readDeck(twoDisplayId);
  expect(deck.wall_profile).toBe('wall-2x4k-7680x2160');
  expect(JSON.stringify(deck.slides)).toContain('This exact paragraph must survive layout changes');
  expect(deck.slides.some((slide) => slide.template_id === 'CONTINUATION')).toBe(true);
  expect(deck.slides.some((slide) => slide.review_flags?.length)).toBe(true);

  await page.reload();
  await expect(page.locator('#studioDeckTitle')).toHaveValue('Two Display Browser Deck');
  await expect(page.locator('[data-studio-validation]')).toContainText('Approved template geometry');

  const popupPromise = page.waitForEvent('popup');
  await page.locator('#studioPreview').click();
  const preview = await popupPromise;
  await expect(preview.locator('#stage .v2-slide')).toHaveCount(deck.slides.length);
  await preview.close();

  const downloadPromise = page.waitForEvent('download');
  await page.locator('#studioDownload').click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/\.pptx$/i);
  const downloadedPath = await download.path();
  expect(fs.statSync(downloadedPath).size).toBeGreaterThan(1000);

  await page.locator('#studioExportLibrary').click();
  await expect.poll(() => {
    const Database = require(path.join(SERVER_DIR, 'node_modules', 'better-sqlite3'));
    const db = new Database(dbPath, { readonly: true });
    try { return db.prepare('SELECT COUNT(*) count FROM presentation_exports WHERE presentation_id=?').get(twoDisplayId).count; }
    finally { db.close(); }
  }).toBe(1);

  refreshSafeTargetHeartbeat();
  await page.locator('[data-studio-present]').click();
  const safeChoice = page.locator('.mc-target-picker-choice').filter({ hasText: 'Safe Presentation Test Display' });
  await expect(safeChoice).toBeVisible();
  await safeChoice.locator('input').check();
  await page.locator('[data-target-continue]').click();
  await expect(page.locator('#studioStatus')).toContainText('Presentation sent');
  expect(errors).toEqual([]);
});

test('Studio creates a separate three-display deck and remains touch-safe at a Lenovo-sized viewport', async ({ browser, page }) => {
  await authPage(page); await page.goto(`${BASE_URL}/app#/presentation-studio`);
  await page.locator('#studioNewTitle').fill('Three Display Browser Deck');
  await page.locator('#studioNewProfile').selectOption('wall-3x4k-11520x2160');
  await page.locator('#studioCreate').click(); await page.waitForURL(/#\/presentation-studio\?id=/);
  threeDisplayId = new URL(page.url()).hash.split('id=')[1];
  await page.getByRole('button', { name: 'Add slide' }).click();
  await page.locator('[data-slot-text="TV1_TITLE"]').fill('Three Display Layout');
  await page.locator('#studioSave').click();
  expect(readDeck(threeDisplayId).wall_profile).toBe('wall-3x4k-11520x2160');

  const context = await browser.newContext({ viewport: { width: 800, height: 1280 }, hasTouch: true });
  const tablet = await context.newPage(); const errors = collectErrors(tablet); await authPage(tablet);
  await tablet.goto(`${BASE_URL}/app#/presentation-studio?id=${encodeURIComponent(threeDisplayId)}`);
  await expect(tablet.locator('.studio-stage-viewport')).toBeVisible();
  const geometry = await tablet.evaluate(() => {
    const stage = document.querySelector('.studio-stage-viewport').getBoundingClientRect();
    const controls = [...document.querySelectorAll('.studio-button,.studio-icon-button,.studio-select,.studio-input')]
      .filter((item) => item.offsetParent !== null).map((item) => item.getBoundingClientRect().height);
    return { ratio: stage.width / stage.height, minControl: Math.min(...controls), pageWidth: document.documentElement.scrollWidth, viewport: innerWidth };
  });
  expect(geometry.ratio).toBeCloseTo(16 / 3, 1);
  expect(geometry.minControl).toBeGreaterThanOrEqual(48);
  expect(geometry.pageWidth).toBeLessThanOrEqual(geometry.viewport + 1);
  expect(errors).toEqual([]);
  await context.close();
});

test('Converter performs review-first Faithful conversions to both wall profiles and opens the saved deck in Studio', async ({ page }) => {
  const errors = collectErrors(page); await authPage(page);
  await page.goto(`${BASE_URL}/app#/presentation-studio`);
  await page.goto(`${BASE_URL}/app#/presentation-converter`);
  await page.locator('#converterUpload').setInputFiles(sourcePptx);
  await expect(page.locator('#converterSourceName')).toHaveText('representative.pptx');
  await page.locator('#converterUseAi').uncheck();
  await page.locator('#converterProfile').selectOption('wall-2x4k-7680x2160');
  await page.locator('#converterStart').click();
  await expect(page.locator('#converterStatus')).toHaveText('Conversion complete', { timeout: 30000 });
  await expect(page.locator('#converterReview')).toContainText('Source accounting: 100%');
  const twoHref = await page.locator('#converterReview a[href*="#/presentation-studio?id="]').getAttribute('href');
  expect(readDeck(twoHref.split('id=')[1]).wall_profile).toBe('wall-2x4k-7680x2160');

  await page.reload();
  await page.locator('#converterExisting').selectOption({ label: 'representative.pptx' });
  await page.locator('#converterUseAi').uncheck();
  await page.locator('#converterProfile').selectOption('wall-3x4k-11520x2160');
  await page.locator('#converterStart').click();
  await expect(page.locator('#converterStatus')).toHaveText('Conversion complete', { timeout: 30000 });
  await expect(page.locator('#converterReview')).toContainText('Source accounting: 100%');
  const open = page.locator('#converterReview a[href*="#/presentation-studio?id="]');
  const threeHref = await open.getAttribute('href');
  expect(readDeck(threeHref.split('id=')[1]).wall_profile).toBe('wall-3x4k-11520x2160');
  await open.click(); await expect(page.locator('#studioDeckTitle')).toBeVisible();
  expect(errors).toEqual([]);
});

test('AI unavailability is explicit while manual Studio authoring remains available', async ({ page }) => {
  await authPage(page); await page.goto(`${BASE_URL}/app#/presentation-studio?mode=ai`);
  await page.locator('#studioAiPrompt').fill('Draft a short ventilation coordination class');
  await page.locator('#studioAiGenerate').click();
  await expect(page.locator('#studioStatus[role="alert"]')).not.toHaveText('', { timeout: 20000 });
  await page.goto(`${BASE_URL}/app#/presentation-studio`);
  await expect(page.locator('#studioCreate')).toBeEnabled();
});

test('disabling the flags restores the legacy UI without a database rollback', async ({ page }) => {
  await startServer({ enabled: false, reuseDb: true }); await login();
  const features = await apiJson('/features');
  expect(features.features.presentationStudioV2.authorized).toBe(false);
  expect(features.features.presentationConverter.authorized).toBe(false);
  expect(readDeck(twoDisplayId).version).toBe('mbfd-deck-v2');
  await authPage(page); await page.goto(`${BASE_URL}/app#/presentations`);
  await expect(page.locator('.mc-studio-title')).toHaveText('Presentations');
  await expect(page.locator('.legacy-presentation-nav').first()).toBeVisible();
  await expect(page.locator('#presentationStudioNavItem')).toBeHidden();
});
