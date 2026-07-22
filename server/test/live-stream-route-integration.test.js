'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

function listen(app) {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
    server.once('error', reject);
  });
}

function close(server) {
  return new Promise((resolve) => server.close(resolve));
}

test('prepare, manual start, auto gate, disabled start, and stop preserve safety boundaries', async () => {
  const directorCalls = [];
  const directorState = {
    mode: 'manual',
    current_scene: 'KAMRUI_CAMERA_1_FULL',
    stream_active: false,
    recording_active: false,
    kamrui_camera_1_stream: true,
    kamrui_camera_2_stream: false,
    annke_camera_3_stream: true,
    obs: true,
    peertube_configured: true,
    operator_stream_start_allowed: true,
    automatic_stream_start_allowed: false,
    director: { active_camera: 1, content_active: false },
  };
  let rejectStart = false;

  const director = express();
  director.use(express.json());
  director.use((req, _res, next) => {
    directorCalls.push(`${req.method} ${req.path}`);
    next();
  });
  director.get('/status', (_req, res) => res.json(directorState));
  director.post('/media-control/program-url', (_req, res) => res.json({ ok: true }));
  director.post('/media-control/refresh', (_req, res) => res.json({ ok: true }));
  director.post('/mode/:mode', (req, res) => {
    directorState.mode = req.params.mode;
    res.json({ ok: true, mode: req.params.mode });
  });
  director.post('/stream/start', (_req, res) => {
    if (rejectStart) {
      return res.json({ ok: false, message: 'stream start disabled by ENABLE_STREAM_START=false' });
    }
    directorState.stream_active = true;
    res.json({ ok: true });
  });
  director.post('/stream/stop', (_req, res) => {
    directorState.stream_active = false;
    res.json({ ok: true });
  });

  const directorServer = await listen(director);
  const directorAddress = directorServer.address();
  process.env.AI_DIRECTOR_URL = `http://127.0.0.1:${directorAddress.port}`;
  process.env.AI_DIRECTOR_TIMEOUT_MS = '1000';
  process.env.PEERTUBE_LIVE_WATCH_URL = 'https://videos.example.test/watch/demo';
  process.env.LIVE_STREAM_OPERATOR_START_ALLOWED = 'true';
  process.env.LIVE_STREAM_AUTOMATIC_START_ALLOWED = 'false';

  // Fresh module graph with env applied
  delete require.cache[require.resolve('../config')];
  delete require.cache[require.resolve('../routes/live-stream')];
  delete require.cache[require.resolve('../lib/live-stream-capabilities')];
  delete require.cache[require.resolve('../lib/live-production-state')];

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
    directorCalls.length = 0;
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

    directorCalls.length = 0;
    const prepareResponse = await fetch(`${base}/prepare`, { method: 'POST' });
    const prepared = await prepareResponse.json();
    assert.equal(prepareResponse.status, 200);
    assert.equal(prepared.prepared, true);
    assert.equal(new URL(prepared.player_url).pathname, '/player/live-stream');
    assert.equal(new URL(prepared.player_url).search, '');
    assert.equal(prepared.player_url.includes('token'), false);
    assert.ok(directorCalls.includes('GET /status'));
    assert.ok(directorCalls.includes('POST /media-control/program-url'));
    assert.ok(directorCalls.includes('POST /media-control/refresh'));

    directorCalls.length = 0;
    const rejectedAutoResponse = await fetch(`${base}/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ director_mode: 'auto' }),
    });
    const rejectedAuto = await rejectedAutoResponse.json();
    assert.equal(rejectedAutoResponse.status, 409);
    assert.equal(rejectedAuto.code, 'AUTO_CANARY_CONFIRMATION_REQUIRED');
    assert.equal(rejectedAuto.success, false);
    assert.equal(typeof rejectedAuto.request_id, 'string');
    assert.ok(rejectedAuto.error);

    const autonomous = await fetch(`${base}/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ director_mode: 'manual', initiator: 'system' }),
    });
    const autonomousBody = await autonomous.json();
    assert.equal(autonomous.status, 409);
    assert.equal(autonomousBody.code, 'AUTOMATIC_STREAM_START_DISABLED');

    // Simulate production ENABLE_STREAM_START=false rejection
    rejectStart = true;
    const disabledStartResponse = await fetch(`${base}/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ director_mode: 'manual' }),
    });
    const disabledStart = await disabledStartResponse.json();
    assert.equal(disabledStartResponse.status, 502);
    assert.equal(disabledStart.code, 'OPERATOR_STREAM_START_DISABLED');
    assert.match(disabledStart.error, /Operator stream start is disabled/i);
    assert.equal(disabledStart.success, false);
    assert.ok(disabledStart.request_id);

    // After disabled failure, status should report operator_start_allowed false
    const statusAfterFail = await (await fetch(`${base}/status`)).json();
    assert.equal(statusAfterFail.operator_start_allowed, false);
    assert.equal(statusAfterFail.last_error_code, 'OPERATOR_STREAM_START_DISABLED');

    rejectStart = false;
    // Clear last error by forcing allow via env still true and new request once director allows
    const { clearLiveStreamLastError } = require('../lib/live-production-state');
    clearLiveStreamLastError(workspaceId);

    directorCalls.length = 0;
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
    assert.ok(directorCalls.includes('POST /mode/manual'));
    assert.ok(!directorCalls.includes('POST /mode/auto'));
    assert.ok(directorCalls.includes('POST /stream/start'));

    directorCalls.length = 0;
    const activePrepareResponse = await fetch(`${base}/prepare`, { method: 'POST' });
    const activePrepare = await activePrepareResponse.json();
    assert.equal(activePrepareResponse.status, 409);
    assert.equal(activePrepare.code, 'STREAM_ALREADY_ACTIVE');

    directorCalls.length = 0;
    const sceneBeforeStop = directorState.current_scene;
    const modeBeforeStop = directorState.mode;
    const stopResponse = await fetch(`${base}/stop`, { method: 'POST' });
    const stopped = await stopResponse.json();
    assert.equal(stopResponse.status, 200);
    assert.equal(stopped.success, true);
    assert.equal(stopped.classroom_composition_preserved, true);
    assert.equal(directorState.current_scene, sceneBeforeStop);
    assert.equal(directorState.mode, modeBeforeStop);
    assert.ok(!directorCalls.some((call) => call.includes('/mode/')));
    assert.ok(!directorCalls.some((call) => call.includes('/scene/')));
  } finally {
    cleanup();
    resetLiveProductionStateForTests();
    await close(appServer);
    await close(directorServer);
  }
});

test('start accepted but not confirmed issues STREAM_START_NOT_CONFIRMED and safe stop', async () => {
  const directorState = {
    mode: 'manual',
    current_scene: 'KAMRUI_CAMERA_1_FULL',
    stream_active: false,
    recording_active: false,
    kamrui_camera_1_stream: true,
    obs: true,
    peertube_configured: true,
    operator_stream_start_allowed: true,
    director: { active_camera: 1, content_active: false },
  };
  let stopCalls = 0;
  const director = express();
  director.use(express.json());
  director.get('/status', (_req, res) => res.json(directorState));
  director.post('/media-control/program-url', (_req, res) => res.json({ ok: true }));
  director.post('/media-control/refresh', (_req, res) => res.json({ ok: true }));
  director.post('/mode/:mode', (req, res) => {
    directorState.mode = req.params.mode;
    res.json({ ok: true });
  });
  director.post('/stream/start', (_req, res) => res.json({ ok: true }));
  director.post('/stream/stop', (_req, res) => {
    stopCalls += 1;
    res.json({ ok: true });
  });

  const directorServer = await listen(director);
  process.env.AI_DIRECTOR_URL = `http://127.0.0.1:${directorServer.address().port}`;
  process.env.AI_DIRECTOR_TIMEOUT_MS = '500';
  process.env.PEERTUBE_LIVE_WATCH_URL = 'https://videos.example.test/watch/demo';
  delete require.cache[require.resolve('../config')];
  delete require.cache[require.resolve('../routes/live-stream')];
  delete require.cache[require.resolve('../lib/live-stream-capabilities')];
  delete require.cache[require.resolve('../lib/live-production-state')];
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
    await close(appServer);
    await close(directorServer);
  }
});
