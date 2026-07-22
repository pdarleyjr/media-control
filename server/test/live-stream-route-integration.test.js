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

test('prepare, manual start, auto gate, and stop preserve their safety boundaries', async () => {
  const directorCalls = [];
  const directorState = {
    mode: 'manual',
    current_scene: 'KAMRUI_CAMERA_1_FULL',
    stream_active: false,
    recording_active: false,
    kamrui_camera_1_stream: true,
    kamrui_camera_2_stream: false,
    annke_camera_3_stream: true,
    director: { active_camera: 1, content_active: false },
  };

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

  const { db } = require('../db/database');
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
    const prepareResponse = await fetch(`${base}/prepare`, { method: 'POST' });
    const prepared = await prepareResponse.json();
    assert.equal(prepareResponse.status, 200);
    assert.equal(prepared.prepared, true);
    assert.equal(new URL(prepared.player_url).pathname, '/player/live-stream');
    assert.equal(new URL(prepared.player_url).search, '');
    assert.equal(prepared.player_url.includes('token'), false);
    assert.deepEqual(directorCalls, [
      'GET /status',
      'POST /media-control/program-url',
      'POST /media-control/refresh',
    ]);

    directorCalls.length = 0;
    const rejectedAutoResponse = await fetch(`${base}/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ director_mode: 'auto' }),
    });
    const rejectedAuto = await rejectedAutoResponse.json();
    assert.equal(rejectedAutoResponse.status, 409);
    assert.equal(rejectedAuto.code, 'AUTO_CANARY_CONFIRMATION_REQUIRED');
    assert.deepEqual(directorCalls, []);

    const startResponse = await fetch(`${base}/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ director_mode: 'manual' }),
    });
    const started = await startResponse.json();
    assert.equal(startResponse.status, 200);
    assert.equal(started.success, true);
    assert.equal(started.stream_started, true);
    assert.ok(directorCalls.includes('POST /mode/manual'));
    assert.ok(!directorCalls.includes('POST /mode/auto'));
    assert.ok(directorCalls.includes('POST /stream/start'));

    directorCalls.length = 0;
    const activePrepareResponse = await fetch(`${base}/prepare`, { method: 'POST' });
    const activePrepare = await activePrepareResponse.json();
    assert.equal(activePrepareResponse.status, 409);
    assert.equal(activePrepare.code, 'STREAM_ALREADY_ACTIVE');
    assert.deepEqual(directorCalls, ['GET /status']);

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
    await close(appServer);
    await close(directorServer);
  }
});
