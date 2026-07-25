'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { installIsolatedTestDatabase } = require('./live-stream-test-db');
// Open a private SQLite file before any Media Control module loads database.js.
installIsolatedTestDatabase('live-stream-route-integration');

function listen(app) {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
    server.once('error', reject);
  });
}

function close(server) {
  return new Promise((resolve) => {
    if (!server) return resolve();
    server.close(() => resolve());
  });
}

function closeQuiet(server) {
  return close(server).catch(() => {});
}

test('prepare, manual start, auto gate, disabled start, and stop preserve safety boundaries', async () => {
  const cameraCalls = [];
  // The Kamrui camera-control edge status. `livestreaming` flips on/off as the
  // route drives /api/stream/start and /api/stream/stop.
  const cameraState = {
    camera_online: true,
    preview_online: true,
    recording: false,
    livestreaming: false,
    session_id: null,
    recording_started_at: null,
    stream_started_at: null,
    disk_free_bytes: 0,
    last_recording: null,
    errors: [],
  };
  // Vestigial director-scene/mode snapshot kept for the stop-preservation
  // assertions below (the synthetic camera director always reports the fixed
  // ANNKE full-frame scene in manual mode).
  const directorState = {
    current_scene: 'KAMRUI_CAMERA_3_FULL',
    mode: 'manual',
  };
  let rejectStart = false;

  const camera = express();
  camera.use(express.json());
  camera.use((req, _res, next) => {
    cameraCalls.push(`${req.method} ${req.path}`);
    next();
  });
  camera.get('/api/status', (_req, res) => res.json(cameraState));
  camera.get('/api/recordings', (_req, res) => res.json({ recordings: [] }));
  camera.post('/api/record/start', (_req, res) => {
    cameraState.recording = true;
    cameraState.session_id = 'test-session';
    res.json({ ok: true, session_id: 'test-session' });
  });
  camera.post('/api/record/stop', (_req, res) => {
    cameraState.recording = false;
    res.json({ ok: true });
  });
  camera.post('/api/stream/start', (_req, res) => {
    if (rejectStart) {
      return res.status(503).json({ ok: false, message: 'stream start disabled by ENABLE_STREAM_START=false' });
    }
    cameraState.livestreaming = true;
    res.json({ ok: true });
  });
  camera.post('/api/stream/stop', (_req, res) => {
    cameraState.livestreaming = false;
    res.json({ ok: true });
  });
  camera.post('/api/emergency-stop', (_req, res) => res.json({ ok: true }));

  const cameraServer = await listen(camera);
  const cameraAddress = cameraServer.address();
  process.env.CAMERA_CONTROL_BASE_URL = `http://127.0.0.1:${cameraAddress.port}`;
  process.env.CAMERA_CONTROL_TOKEN = 'test-token';
  process.env.PEERTUBE_LIVE_WATCH_URL = 'https://videos.example.test/watch/demo';
  process.env.LIVE_STREAM_OPERATOR_START_ALLOWED = 'true';
  process.env.LIVE_STREAM_AUTOMATIC_START_ALLOWED = 'false';

  // Fresh module graph with env applied
  delete require.cache[require.resolve('../config')];
  delete require.cache[require.resolve('../routes/live-stream')];
  delete require.cache[require.resolve('../lib/live-stream-capabilities')];
  delete require.cache[require.resolve('../lib/live-production-state')];
  delete require.cache[require.resolve('../lib/camera-control-client')];

  const { db } = require('../db/database');
  const { resetLiveProductionStateForTests } = require('../lib/live-production-state');
  resetLiveProductionStateForTests();
  const router = require('../routes/live-stream');
  const prefix = `test-live-route-${Date.now()}-`;
  const userId = `${prefix}user`;
  const organizationId = `${prefix}org`;
  const workspaceId = `${prefix}workspace`;
  const cleanup = () => {
    db.prepare('DELETE FROM audit_log WHERE workspace_id = ? OR actor_id = ?').run(workspaceId, userId);
    db.prepare('DELETE FROM activity_log WHERE user_id = ?').run(userId);
    db.prepare('DELETE FROM devices WHERE workspace_id = ?').run(workspaceId);
    db.prepare('DELETE FROM workspace_members WHERE workspace_id = ?').run(workspaceId);
    db.prepare('DELETE FROM workspaces WHERE id = ?').run(workspaceId);
    db.prepare('DELETE FROM organization_members WHERE organization_id = ? OR user_id = ?').run(organizationId, userId);
    db.prepare('DELETE FROM organizations WHERE id = ?').run(organizationId);
    db.prepare('DELETE FROM users WHERE id = ?').run(userId);
  };

  cleanup();
  db.prepare("INSERT INTO users (id, email, name, role) VALUES (?, ?, 'Route Test', 'platform_admin')")
    .run(userId, `${prefix}@example.test`);
  db.prepare('INSERT INTO organizations (id, name, owner_user_id) VALUES (?, ?, ?)')
    .run(organizationId, 'Route Test Org', userId);
  db.prepare('INSERT INTO workspaces (id, organization_id, name, created_by) VALUES (?, ?, ?, ?)')
    .run(workspaceId, organizationId, 'Route Test Workspace', userId);
  db.prepare("INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, 'workspace_admin')")
    .run(workspaceId, userId);

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = { id: userId };
    req.workspaceId = workspaceId;
    next();
  });
  app.use('/api/live-stream', router);
  const appServer = await listen(app);
  const appAddress = appServer.address();
  const base = `http://127.0.0.1:${appAddress.port}/api/live-stream`;

  try {
    cameraCalls.length = 0;
    const statusResponse = await fetch(`${base}/status`);
    const statusBody = await statusResponse.json();
    assert.equal(statusResponse.status, 200);
    assert.equal(statusBody.success, true);
    assert.equal(typeof statusBody.request_id, 'string');
    assert.equal(statusBody.operator_start_allowed, true);
    assert.equal(statusBody.automatic_start_allowed, false);
    assert.equal(statusBody.managed_receiver_online, false);
    assert.equal(statusBody.peertube_configured, true);
    assert.equal(statusBody.ai_director.data.settings, undefined);

    // Mark receiver online for start gates
    db.prepare("UPDATE devices SET status = 'online' WHERE workspace_id = ? AND id LIKE 'live-stream-program-%'")
      .run(workspaceId);

    cameraCalls.length = 0;
    const prepareResponse = await fetch(`${base}/prepare`, { method: 'POST' });
    const prepared = await prepareResponse.json();
    assert.equal(prepareResponse.status, 200);
    assert.equal(prepared.prepared, true);
    assert.equal(new URL(prepared.player_url).pathname, '/player/live-stream');
    assert.equal(new URL(prepared.player_url).search, '');
    assert.equal(prepared.player_url.includes('token'), false);
    assert.ok(cameraCalls.includes('GET /api/status'));

    cameraCalls.length = 0;
    // Auto mode is retired in the fixed-camera publisher; director_mode is
    // always 'manual'. A system-initiated auto request is blocked by the
    // automatic-start gate.
    const rejectedAutoResponse = await fetch(`${base}/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ director_mode: 'auto', initiator: 'system' }),
    });
    const rejectedAuto = await rejectedAutoResponse.json();
    assert.equal(rejectedAutoResponse.status, 409);
    assert.equal(rejectedAuto.code, 'AUTOMATIC_STREAM_START_DISABLED');
    assert.equal(rejectedAuto.success, false);
    assert.equal(typeof rejectedAuto.request_id, 'string');
    assert.ok(rejectedAuto.error);

    // Camera API rejects the stream start (e.g. ENABLE_STREAM_START=false on edge)
    rejectStart = true;
    const disabledStartResponse = await fetch(`${base}/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ director_mode: 'manual' }),
    });
    const disabledStart = await disabledStartResponse.json();
    assert.equal(disabledStartResponse.status, 502);
    assert.equal(disabledStart.code, 'STREAM_START_REJECTED');
    assert.equal(disabledStart.success, false);
    assert.ok(disabledStart.request_id);
    assert.ok(disabledStart.error);

    // After rejected start, status should report the last error
    const statusAfterFail = await (await fetch(`${base}/status`)).json();
    assert.equal(statusAfterFail.last_error_code, 'STREAM_START_REJECTED');

    rejectStart = false;
    // Clear last error by forcing allow via env still true and new request once director allows
    const { clearLiveStreamLastError } = require('../lib/live-production-state');
    clearLiveStreamLastError(workspaceId);

    cameraCalls.length = 0;
    const startResponse = await fetch(`${base}/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ director_mode: 'manual' }),
    });
    const started = await startResponse.json();
    assert.equal(startResponse.status, 200, JSON.stringify(started));
    assert.equal(started.success, true);
    assert.equal(started.stream_started, true);
    assert.ok(started.request_id);
    assert.ok(cameraCalls.includes('POST /api/stream/start'));

    cameraCalls.length = 0;
    const activePrepareResponse = await fetch(`${base}/prepare`, { method: 'POST' });
    const activePrepare = await activePrepareResponse.json();
    assert.equal(activePrepareResponse.status, 409);
    assert.equal(activePrepare.code, 'STREAM_ALREADY_ACTIVE');

    cameraCalls.length = 0;
    const sceneBeforeStop = directorState.current_scene;
    const modeBeforeStop = directorState.mode;
    const stopResponse = await fetch(`${base}/stop`, { method: 'POST' });
    const stopped = await stopResponse.json();
    assert.equal(stopResponse.status, 200);
    assert.equal(stopped.success, true);
    assert.equal(stopped.classroom_composition_preserved, true);
    assert.equal(directorState.current_scene, sceneBeforeStop);
    assert.equal(directorState.mode, modeBeforeStop);
    assert.ok(!cameraCalls.some((call) => call.includes('/mode/')));
    assert.ok(!cameraCalls.some((call) => call.includes('/scene/')));
  } finally {
    cleanup();
    resetLiveProductionStateForTests();
    await closeQuiet(appServer);
    await closeQuiet(cameraServer);
  }
});

test('start accepted but not confirmed issues STREAM_START_NOT_CONFIRMED and safe stop', async () => {
  const cameraState = {
    camera_online: true,
    preview_online: true,
    recording: false,
    livestreaming: false,
    session_id: null,
    recording_started_at: null,
    stream_started_at: null,
    disk_free_bytes: 0,
    last_recording: null,
    errors: [],
  };
  let stopCalls = 0;
  const camera = express();
  camera.use(express.json());
  camera.get('/api/status', (_req, res) => res.json(cameraState));
  camera.get('/api/recordings', (_req, res) => res.json({ recordings: [] }));
  camera.post('/api/record/start', (_req, res) => res.json({ ok: true, session_id: 'test-session' }));
  camera.post('/api/record/stop', (_req, res) => res.json({ ok: true }));
  // /api/stream/start acknowledges the request but never flips `livestreaming`,
  // so the route's authoritative status verification never observes an active
  // stream and must roll back with STREAM_START_NOT_CONFIRMED.
  camera.post('/api/stream/start', (_req, res) => res.json({ ok: true }));
  camera.post('/api/stream/stop', (_req, res) => {
    stopCalls += 1;
    res.json({ ok: true });
  });
  camera.post('/api/emergency-stop', (_req, res) => res.json({ ok: true }));

  const cameraServer = await listen(camera);
  process.env.CAMERA_CONTROL_BASE_URL = `http://127.0.0.1:${cameraServer.address().port}`;
  process.env.CAMERA_CONTROL_TOKEN = 'test-token';
  process.env.PEERTUBE_LIVE_WATCH_URL = 'https://videos.example.test/watch/demo';
  delete require.cache[require.resolve('../config')];
  delete require.cache[require.resolve('../routes/live-stream')];
  delete require.cache[require.resolve('../lib/live-stream-capabilities')];
  delete require.cache[require.resolve('../lib/live-production-state')];
  delete require.cache[require.resolve('../lib/camera-control-client')];
  const { db } = require('../db/database');
  const { resetLiveProductionStateForTests } = require('../lib/live-production-state');
  resetLiveProductionStateForTests();
  const router = require('../routes/live-stream');
  const prefix = `test-unconfirmed-${Date.now()}-`;
  const userId = `${prefix}user`;
  const organizationId = `${prefix}org`;
  const workspaceId = `${prefix}workspace`;
  const cleanup = () => {
    db.prepare('DELETE FROM audit_log WHERE workspace_id = ? OR actor_id = ?').run(workspaceId, userId);
    db.prepare('DELETE FROM activity_log WHERE user_id = ?').run(userId);
    db.prepare('DELETE FROM devices WHERE workspace_id = ?').run(workspaceId);
    db.prepare('DELETE FROM workspace_members WHERE workspace_id = ?').run(workspaceId);
    db.prepare('DELETE FROM workspaces WHERE id = ?').run(workspaceId);
    db.prepare('DELETE FROM organization_members WHERE organization_id = ? OR user_id = ?').run(organizationId, userId);
    db.prepare('DELETE FROM organizations WHERE id = ?').run(organizationId);
    db.prepare('DELETE FROM users WHERE id = ?').run(userId);
  };
  cleanup();
  db.prepare("INSERT INTO users (id, email, name, role) VALUES (?, ?, 'Route Test', 'platform_admin')")
    .run(userId, `${prefix}@example.test`);
  db.prepare('INSERT INTO organizations (id, name, owner_user_id) VALUES (?, ?, ?)')
    .run(organizationId, 'Route Test Org', userId);
  db.prepare('INSERT INTO workspaces (id, organization_id, name, created_by) VALUES (?, ?, ?, ?)')
    .run(workspaceId, organizationId, 'Route Test Workspace', userId);
  db.prepare("INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, 'workspace_admin')")
    .run(workspaceId, userId);

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = { id: userId };
    req.workspaceId = workspaceId;
    next();
  });
  app.use('/api/live-stream', router);
  const appServer = await listen(app);
  const base = `http://127.0.0.1:${appServer.address().port}/api/live-stream`;
  try {
    // Ensure managed display exists and is online
    await fetch(`${base}/status`);
    db.prepare("UPDATE devices SET status = 'online' WHERE workspace_id = ?").run(workspaceId);
    const startResponse = await fetch(`${base}/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ director_mode: 'manual' }),
    });
    const body = await startResponse.json();
    assert.equal(startResponse.status, 502);
    assert.equal(body.code, 'STREAM_START_NOT_CONFIRMED');
    assert.ok(stopCalls >= 1);
  } finally {
    cleanup();
    resetLiveProductionStateForTests();
    await closeQuiet(appServer);
    await closeQuiet(cameraServer);
  }
});
