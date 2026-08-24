'use strict';

const { test, expect } = require('@playwright/test');
const { spawn, execSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const SERVER_DIR = path.resolve(__dirname, '..', '..');
const PORT = 18107;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const JWT_SECRET = 'durable-live-preview-test-secret-with-safe-length';
const VIDEO_WEBM = 'GkXfo59ChoEBQveBAULygQRC84EIQoKEd2VibUKHgQJChYECGFOAZwEAAAAAAALOEU2bdLpNu4tTq4QVSalmU6yBoU27i1OrhBZUrmtTrIHWTbuMU6uEElTDZ1OsggEjTbuMU6uEHFO7a1OsggK47AEAAAAAAABZAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAVSalmsCrXsYMPQkBNgIxMYXZmNjEuNy4xMDBXQYxMYXZmNjEuNy4xMDBEiYhAj0AAAAAAABZUrmvIrgEAAAAAAAA/14EBc8WISB/SfhSRUJicgQAitZyDdW5kiIEAhoVWX1ZQOIOBASPjg4QL68IA4JCwgUC6gSSagQJVsIRVuYEBElTDZ/tzc59jwIBnyJlFo4dFTkNPREVSRIeMTGF2ZjYxLjcuMTAwc3PWY8CLY8WISB/SfhSRUJhnyKFFo4dFTkNPREVSRIeUTGF2YzYxLjE5LjEwMSBsaWJ2cHhnyKFFo4hEVVJBVElPTkSHkzAwOjAwOjAxLjAwMDAwMDAwMAAfQ7Z1QQ/ngQCjwoEAAIBQAwCdASpAACQAAEcIhYWImYSIAgICdaoD+AIHCOD99CbPLgD+/00S//xKp/Eqn8Sqf/Eqn/0Yfww/hh/eEKO0gQDIAFECAAIQSAAYC7ALINuUcBY7VfzWAP77VeP/z2j89o/PaP/PaP6DZ1qJ1s78QR8scKOvgQGQABECAAIQNAAYABpP9AwAFPqqqID+/RHH//Z5f2eX9nl/9nl/7kB9I59Kt2CjroECWAARAgACECgAGAAaT/QMABT6qqiA/v4X+//4Mx/BmP4Mx/8GY//CrcMQydCjr4EDIAARAgACEBwAGAAaT/QMABT6qqiA/v7Tsf/+rov1dF+rov/V0X/5glfkG65AHFO7a5G7j7OBALeK94EB8YIBo/CBAw==';

let serverProcess;
let tmpDir;
let dbPath;
let authToken;
let authUser;
let workspaceId;
let serverLogs = [];

function stopServer() {
  if (!serverProcess) return;
  const pid = serverProcess.pid;
  try {
    if (process.platform === 'win32') execSync(`taskkill /pid ${pid} /T /F`, { stdio: 'ignore' });
    else process.kill(pid, 'SIGKILL');
  } catch { /* best effort */ }
  serverProcess = null;
}

async function startServer() {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-live-preview-'));
  dbPath = path.join(tmpDir, 'test.db');
  serverProcess = spawn(process.execPath, ['server.js'], {
    cwd: SERVER_DIR,
    env: {
      ...process.env,
      PORT: String(PORT),
      DB_PATH: dbPath,
      JWT_SECRET,
      NODE_ENV: 'development',
      DISABLE_REGISTRATION: 'false',
      SELF_HOSTED: 'true',
      PLAYER_DEBUG_REPORTING: 'off',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  serverLogs = [];
  serverProcess.stdout.on('data', (data) => serverLogs.push(data.toString()));
  serverProcess.stderr.on('data', (data) => serverLogs.push(`[stderr] ${data}`));
  const started = Date.now();
  while (Date.now() - started < 45000) {
    if (serverProcess.exitCode != null) throw new Error(`Server exited early:\n${serverLogs.join('')}`);
    try {
      const response = await fetch(`${BASE_URL}/api/version`);
      if (response.ok) return;
    } catch { /* server is still starting */ }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Server start timed out:\n${serverLogs.join('')}`);
}

async function registerUser() {
  const response = await fetch(`${BASE_URL}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: 'durable-preview@test.local',
      password: 'durable-preview-test-password',
      name: 'Durable Preview Test',
    }),
  });
  expect(response.ok).toBe(true);
  const body = await response.json();
  authToken = body.token;
  authUser = body.user;
  workspaceId = body.current_workspace_id;
}

function snapshot(source, contentId) {
  return JSON.stringify([{
    content_id: contentId,
    filename: `Live source ${source}`,
    mime_type: 'text/html',
    remote_url: `/player/live-source.html?fixture=${source}`,
  }]);
}

function seedStandalonePrograms() {
  const Database = require('better-sqlite3');
  const database = new Database(dbPath, { timeout: 10000 });
  database.pragma('busy_timeout = 10000');
  const now = Math.floor(Date.now() / 1000);
  try {
    database.transaction(() => {
      const insertPlaylist = database.prepare(`
        INSERT INTO playlists (id, user_id, name, status, published_snapshot, created_at, updated_at)
        VALUES (?, ?, ?, 'published', ?, ?, ?)
      `);
      insertPlaylist.run('preview-playlist-a', authUser.id, 'Preview A', snapshot('a', 'preview-content-a'), now, now);
      insertPlaylist.run('preview-playlist-b', authUser.id, 'Preview B', snapshot('b', 'preview-content-b'), now, now);
      const insertDevice = database.prepare(`
        INSERT INTO devices (
          id, user_id, workspace_id, name, pairing_code, status, last_heartbeat,
          screen_width, screen_height, playlist_id, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, 'online', ?, 1920, 1080, ?, ?, ?)
      `);
      insertDevice.run('preview-display-a', authUser.id, workspaceId, 'Preview Display A', '821001', now, 'preview-playlist-a', now, now);
      insertDevice.run('preview-display-b', authUser.id, workspaceId, 'Preview Display B', '821002', now, 'preview-playlist-b', now, now);
      const insertState = database.prepare(`
        INSERT INTO display_states (
          target_type, target_id, workspace_id, current_content_id, content_type,
          paused, muted, render_state, screen_on, state_revision, updated_at
        ) VALUES ('display', ?, ?, ?, 'web', 0, 1, 'playing', 1, 1, ?)
      `);
      insertState.run('preview-display-a', workspaceId, 'preview-content-a', Date.now());
      insertState.run('preview-display-b', workspaceId, 'preview-content-b', Date.now());
      database.prepare(`
        INSERT INTO dashboard_state (user_id, workspace_id, selection_json, updated_at)
        VALUES (?, ?, ?, ?)
      `).run(authUser.id, workspaceId, JSON.stringify(['preview-display-a']), now);
    })();
  } finally {
    database.close();
  }
}

function commandCount() {
  const Database = require('better-sqlite3');
  const database = new Database(dbPath, { readonly: true });
  try {
    return database.prepare('SELECT COUNT(*) AS count FROM command_logs').get().count;
  } finally {
    database.close();
  }
}

function fixturePlayerHtml(source) {
  return `<!doctype html><html><body style="margin:0;background:#000;overflow:hidden">
    <video id="program" autoplay muted loop playsinline style="width:100vw;height:100vh;object-fit:cover"
      src="data:video/webm;base64,${VIDEO_WEBM}"></video>
    <script>
      window.__fixtureInstanceToken = ${JSON.stringify(source)} + ':' + Math.random();
      const video = document.getElementById('program');
      video.muted = true;
      video.play().catch((error) => { document.body.dataset.playError = error.name; });
    <\/script></body></html>`;
}

async function mediaState(page) {
  return page.evaluate(() => [...document.querySelectorAll('iframe[data-preview-surface-key]')].map((frame) => {
    const video = frame.contentDocument?.querySelector('video');
    return {
      key: frame.dataset.previewSurfaceKey,
      nodeToken: frame.__testNodeToken,
      contextToken: frame.contentWindow?.__fixtureInstanceToken,
      time: video?.currentTime || 0,
      muted: video?.muted,
      controls: video?.controls,
      paused: video?.paused,
      pointerEvents: getComputedStyle(frame).pointerEvents,
    };
  }));
}

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  await startServer();
  await registerUser();
  seedStandalonePrograms();
});

test.afterAll(() => {
  stopServer();
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('@durable-live-preview two programs remain live across selection and only a changed source navigates', async ({ page }) => {
  const pageErrors = [];
  await page.setViewportSize({ width: 1366, height: 768 });
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.route('**/player/live-source.html?fixture=*', async (route) => {
    const source = new URL(route.request().url()).searchParams.get('fixture');
    await route.fulfill({ status: 200, contentType: 'text/html', body: fixturePlayerHtml(source) });
  });
  await page.addInitScript(({ token, user }) => {
    localStorage.setItem('token', token);
    localStorage.setItem('user', JSON.stringify(user));
    localStorage.setItem('rd_onboarded', '1');
  }, { token: authToken, user: authUser });

  await page.goto(`${BASE_URL}/app#/control`);
  const previewA = page.locator('iframe[data-preview-surface-key="display:preview-display-a"]');
  const previewB = page.locator('iframe[data-preview-surface-key="display:preview-display-b"]');
  await expect(previewA).toBeVisible({ timeout: 20000 });
  await expect(previewB).toBeAttached();
  await expect(previewB).toBeHidden();
  await expect.poll(async () => (await mediaState(page)).every((item) => item.time > 0 && item.paused === false)).toBe(true);

  await page.evaluate(() => {
    document.querySelectorAll('iframe[data-preview-surface-key]').forEach((frame) => {
      frame.__testNodeToken = `${frame.dataset.previewSurfaceKey}:${Math.random()}`;
    });
  });
  const initial = await mediaState(page);
  expect(initial).toHaveLength(2);
  expect(initial.every((item) => item.muted && !item.controls && item.pointerEvents === 'none')).toBe(true);
  const metricsBeforeSelection = await page.evaluate(() => ({ ...window.__mcStageMetrics }));
  const commandsBeforeSelection = commandCount();

  await page.locator('select.mc-target-select').selectOption('display:preview-display-b');
  await expect(page.locator('article[data-device-id="preview-display-b"]')).toHaveAttribute('aria-current', 'true');
  await expect(previewA).toBeHidden();
  await expect(previewB).toBeVisible();
  await page.waitForTimeout(350);
  const afterSelection = await mediaState(page);
  expect(afterSelection.map((item) => item.nodeToken)).toEqual(initial.map((item) => item.nodeToken));
  expect(afterSelection.map((item) => item.contextToken)).toEqual(initial.map((item) => item.contextToken));
  expect(afterSelection.every((item, index) => item.time !== initial[index].time)).toBe(true);
  expect(commandCount()).toBe(commandsBeforeSelection);
  const metricsAfterSelection = await page.evaluate(() => ({ ...window.__mcStageMetrics }));
  for (const key of ['renders', 'iframeCreates', 'iframeRemoves', 'iframeNavigations', 'liveSessionCreates', 'liveSessionDestroys', 'liveSessions']) {
    expect(metricsAfterSelection[key], `${key} changed during control-only selection`).toBe(metricsBeforeSelection[key]);
  }

  await page.evaluate(async () => {
    const state = await import('/js/services/display-state.js');
    const current = state.get('preview-display-b');
    state.applyConfirmedState('preview-display-b', {
      state_revision: (Number(current?.state_revision) || 0) + 1,
      now_playing: {
        ...(current?.now_playing || {}),
        kind: 'web',
        contentId: 'preview-content-b2',
        content_id: 'preview-content-b2',
        remoteUrl: '/player/live-source.html?fixture=b2',
        remote_url: '/player/live-source.html?fixture=b2',
      },
    });
  });
  await expect.poll(async () => {
    const states = await mediaState(page);
    const a = states.find((item) => item.key === 'display:preview-display-a');
    const b = states.find((item) => item.key === 'display:preview-display-b');
    return !!a && !!b
      && a.nodeToken === initial[0].nodeToken
      && a.contextToken === initial[0].contextToken
      && !b.nodeToken
      && b.contextToken !== initial[1].contextToken;
  }).toBe(true);

  const metricsAfterChange = await page.evaluate(() => ({ ...window.__mcStageMetrics }));
  expect(metricsAfterChange.iframeCreates - metricsBeforeSelection.iframeCreates).toBe(1);
  expect(metricsAfterChange.iframeRemoves - metricsBeforeSelection.iframeRemoves).toBe(1);
  expect(metricsAfterChange.iframeNavigations - metricsBeforeSelection.iframeNavigations).toBe(1);
  expect(metricsAfterChange.liveSessionCreates - metricsBeforeSelection.liveSessionCreates).toBe(1);
  expect(metricsAfterChange.liveSessionDestroys - metricsBeforeSelection.liveSessionDestroys).toBe(1);
  expect(metricsAfterChange.liveSessions).toBe(2);
  expect(pageErrors).toEqual([]);
});

test('@durable-live-preview browser renders one durable session per span group split mosaic and multiview surface', async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 768 });
  await page.route('**/preview-harness', (route) => route.fulfill({
    status: 200,
    contentType: 'text/html',
    body: `<!doctype html><html><head><link rel="stylesheet" href="/css/media-control.css"></head><body>
      <main class="mc-cc-main" style="width:1200px;height:720px">
        <section class="mc-cc-canvas-area">
          <main id="fixture" class="mc-stage mc-cc-canvas mc-cc-overview"></main>
        </section>
        <section class="mc-cc-controls"><button id="fixture-control" type="button">Layout control</button></section>
      </main>
    </body></html>`,
  }));
  await page.route('**/player/live-source.html?fixture=*', async (route) => {
    const source = new URL(route.request().url()).searchParams.get('fixture');
    await route.fulfill({ status: 200, contentType: 'text/html', body: fixturePlayerHtml(source) });
  });
  await page.goto(`${BASE_URL}/preview-harness`);

  const renderTopology = async (activeControlTarget, offlineSpanLeader = false) => page.evaluate(async ({ controlTarget, offlineSpan }) => {
    const { renderStage } = await import('/js/views/media-control/stage.js');
    const { buildLivePreviewTargets } = await import('/js/views/media-control/preview-targets.js');
    const program = (id, kind = 'web') => ({
      id,
      name: id,
      online: true,
      screen_on: true,
      now_playing: {
        kind,
        contentId: `content-${id}`,
        remoteUrl: `/player/live-source.html?fixture=${id}`,
        paused: false,
      },
    });
    const displays = [program('multiview', 'grid')];
    const memberIds = ['span-a', 'span-b', 'span-c', 'group-a', 'group-b', 'group-c', 'split-a', 'split-b', 'mosaic'];
    const members = memberIds.map((id) => program(id));
    const byId = new Map([...displays, ...members].map((display) => [display.id, display]));
    if (offlineSpan) byId.get('span-b').online = false;
    const devices = (...ids) => ids.map((id, grid_col) => ({ device_id: id, grid_col, grid_row: 0 }));
    const walls = [
      { id: 'span', name: 'Wall 1', layout_mode: 'span', grid_cols: 3, grid_rows: 1, leader_device_id: 'span-b', devices: devices('span-a', 'span-b', 'span-c') },
      {
        id: 'groups', name: 'Wall 2', layout_mode: 'groups', grid_cols: 3, grid_rows: 1, devices: devices('group-a', 'group-b', 'group-c'),
        layout: { groups: [
          { id: 'solo', name: 'Solo', layout: 'span', leader_device_id: 'group-a', member_ids: ['group-a'], geometry: { columns: 1, rows: 1 } },
          { id: 'pair', name: 'Pair', layout: 'span', leader_device_id: 'group-b', member_ids: ['group-b', 'group-c'], geometry: { columns: 2, rows: 1 } },
        ] },
      },
      { id: 'split', name: 'Wall 3', layout_mode: 'split', grid_cols: 2, grid_rows: 1, devices: devices('split-a', 'split-b') },
      {
        id: 'mosaic', name: 'Wall 4', layout_mode: 'split', grid_cols: 2, grid_rows: 1, devices: devices('mosaic'),
        layout: { valid: true, regions: [
          { id: 'left', name: 'Left', player_device_id: 'mosaic', zone_id: 'left', enabled: true, x: 0, y: 0, width: 50, height: 100 },
          { id: 'right', name: 'Right', player_device_id: 'mosaic', zone_id: 'right', enabled: true, x: 50, y: 0, width: 50, height: 100 },
        ] },
      },
    ];
    const selectedIds = ['multiview'];
    const livePreviewTargets = buildLivePreviewTargets({ displays, walls, byId, selectedIds });
    renderStage(document.getElementById('fixture'), {
      displays,
      walls,
      byId,
      selectedIds,
      livePreviewTargets,
      activeControlTarget: controlTarget,
    });
  }, { controlTarget: activeControlTarget, offlineSpan: offlineSpanLeader });

  await renderTopology({ type: 'group', id: 'solo', wall_id: 'groups' });
  const readableLayout = await page.evaluate(() => {
    const stage = document.querySelector('#fixture')?.getBoundingClientRect();
    const wall = document.querySelector('#fixture > .mc-wall[data-wall-id="span"]')?.getBoundingClientRect();
    return stage && wall ? { wallToStageWidth: wall.width / stage.width } : null;
  });
  expect(readableLayout?.wallToStageWidth,
    'a three-screen wall must retain a readable full-row preview at 1366x768').toBeGreaterThanOrEqual(0.9);
  const expectedKeys = [
    'display:multiview',
    'wall:span',
    'wall-group:groups:solo',
    'wall-group:groups:pair',
    'wall-split:split:split-a',
    'wall-split:split:split-b',
    'wall-regions:mosaic',
  ].sort();
  await expect.poll(async () => page.evaluate(() => (
    [...document.querySelectorAll('iframe[data-preview-surface-key]')]
      .every((frame) => (frame.contentDocument?.querySelector('video')?.currentTime || 0) > 0)
  ))).toBe(true);
  expect(await page.evaluate(() => [...document.querySelectorAll('[data-preview-surface-key]')]
    .map((node) => node.dataset.previewSurfaceKey).sort())).toEqual(expectedKeys);
  await expect(page.locator('#fixture-control')).toBeInViewport();
  expect(await page.locator('#fixture-control').evaluate((button) => {
    const rect = button.getBoundingClientRect();
    return document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2) === button;
  })).toBe(true);
  await page.locator('#fixture-control').click();

  const before = await page.evaluate(() => {
    const tokens = {};
    document.querySelectorAll('[data-preview-surface-key]').forEach((node) => {
      node.__testNodeToken = `${node.dataset.previewSurfaceKey}:${Math.random()}`;
      tokens[node.dataset.previewSurfaceKey] = node.__testNodeToken;
    });
    return { tokens, metrics: { ...window.__mcStageMetrics } };
  });
  await renderTopology({ type: 'group', id: 'pair', wall_id: 'groups' });
  const after = await page.evaluate(() => ({
    tokens: Object.fromEntries([...document.querySelectorAll('[data-preview-surface-key]')]
      .map((node) => [node.dataset.previewSurfaceKey, node.__testNodeToken])),
    metrics: { ...window.__mcStageMetrics },
  }));
  expect(after.tokens).toEqual(before.tokens);
  for (const key of ['renders', 'iframeCreates', 'iframeRemoves', 'iframeNavigations', 'liveSessionCreates', 'liveSessionDestroys', 'liveSessions']) {
    expect(after.metrics[key], `${key} changed while selecting another grouped program`).toBe(before.metrics[key]);
  }
  await expect(page.locator('[data-layout-group-id="pair"]')).toHaveAttribute('aria-current', 'true');
  await expect(page.locator('[data-layout-group-id="solo"]')).toHaveAttribute('aria-current', 'false');

  await renderTopology({ type: 'display', id: 'split-a' });
  const visibleWall = page.locator('#fixture > [data-wall-id]:visible');
  await expect(visibleWall).toHaveCount(1);
  await expect(visibleWall).toHaveAttribute('data-wall-id', 'split');
  const afterSplitSelection = await page.evaluate(() => ({
    tokens: Object.fromEntries([...document.querySelectorAll('[data-preview-surface-key]')]
      .map((node) => [node.dataset.previewSurfaceKey, node.__testNodeToken])),
    metrics: { ...window.__mcStageMetrics },
  }));
  expect(afterSplitSelection.tokens).toEqual(after.tokens);
  for (const key of ['renders', 'iframeCreates', 'iframeRemoves', 'iframeNavigations', 'liveSessionCreates', 'liveSessionDestroys', 'liveSessions']) {
    expect(afterSplitSelection.metrics[key], `${key} changed while selecting a split-wall member`).toBe(after.metrics[key]);
  }

  await renderTopology({ type: 'group', id: 'pair', wall_id: 'groups' }, true);
  const afterFailover = await page.evaluate(() => ({
    tokens: Object.fromEntries([...document.querySelectorAll('[data-preview-surface-key]')]
      .map((node) => [node.dataset.previewSurfaceKey, node.__testNodeToken])),
    metrics: { ...window.__mcStageMetrics },
  }));
  expect(afterFailover.tokens['wall:span']).toBeUndefined();
  for (const key of expectedKeys.filter((surfaceKey) => surfaceKey !== 'wall:span')) {
    expect(afterFailover.tokens[key], `${key} was replaced during span leader failover`).toBe(after.tokens[key]);
  }
  expect(afterFailover.metrics.renders).toBe(after.metrics.renders);
  expect(afterFailover.metrics.iframeCreates - after.metrics.iframeCreates).toBe(1);
  expect(afterFailover.metrics.iframeRemoves - after.metrics.iframeRemoves).toBe(1);
  expect(afterFailover.metrics.iframeNavigations - after.metrics.iframeNavigations).toBe(1);
});
