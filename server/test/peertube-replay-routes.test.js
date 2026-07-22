'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const express = require('express');

const tempBase = process.env.KILO_TEMP || path.join(os.tmpdir(), 'kilo');
fs.mkdirSync(tempBase, { recursive: true });
const dbDir = fs.mkdtempSync(path.join(tempBase, 'mc-peertube-routes-db-'));
process.env.DB_PATH = path.join(dbDir, 'test.db');

const { db } = require('../db/database');
const svc = require('../services/peertube-replay');
const router = require('../routes/peertube-replays');

let server;
let baseUrl;
let ws1Replay;
let ws2Replay;
let discardReplay;

function roleContext(req, _res, next) {
  const role = req.headers['x-test-role'] || 'viewer';
  req.workspaceId = req.headers['x-test-workspace'] || 'ws1';
  req.user = { id: role === 'tenant2' ? 'u2' : 'u1', role: role === 'platform' ? 'platform_admin' : 'user' };
  req.workspaceRole = {
    viewer: 'workspace_viewer',
    editor: 'workspace_editor',
    admin: 'workspace_admin',
    tenant2: 'workspace_admin',
  }[role] || null;
  req.orgRole = role === 'org' ? 'org_admin' : null;
  req.isPlatformAdmin = role === 'platform';
  req.actingAs = role === 'org' || role === 'platform';
  next();
}

async function request(pathname, { method = 'GET', role = 'viewer', workspace = 'ws1', body } = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'X-Test-Role': role,
      'X-Test-Workspace': workspace,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let payload;
  try { payload = JSON.parse(text); }
  catch { throw new Error(`Expected JSON from ${method} ${pathname}, received ${response.status}: ${text.slice(0, 500)}`); }
  return { status: response.status, payload };
}

test.before(async () => {
  db.prepare("INSERT OR IGNORE INTO users (id, email, name, role, plan_id) VALUES (?, ?, ?, 'user', 'enterprise')").run('u1', 'routes1@mbfd.test', 'Route One');
  db.prepare("INSERT OR IGNORE INTO users (id, email, name, role, plan_id) VALUES (?, ?, ?, 'user', 'enterprise')").run('u2', 'routes2@mbfd.test', 'Route Two');
  db.prepare('INSERT OR IGNORE INTO organizations (id, name, owner_user_id) VALUES (?, ?, ?)').run('org1', 'Org One', 'u1');
  db.prepare('INSERT OR IGNORE INTO organizations (id, name, owner_user_id) VALUES (?, ?, ?)').run('org2', 'Org Two', 'u2');
  db.prepare('INSERT OR IGNORE INTO workspaces (id, organization_id, name) VALUES (?, ?, ?)').run('ws1', 'org1', 'Workspace One');
  db.prepare('INSERT OR IGNORE INTO workspaces (id, organization_id, name) VALUES (?, ?, ?)').run('ws2', 'org2', 'Workspace Two');

  const recordings = [
    ['route-session-1', 'ws1', 'u1', 'route-video-1'],
    ['route-session-2', 'ws2', 'u2', 'route-video-2'],
    ['route-session-discard', 'ws1', 'u1', 'route-video-discard'],
  ];
  for (let index = 0; index < recordings.length; index += 1) {
    const [id, workspaceId, userId, videoUuid] = recordings[index];
    svc.registerRecordingSession({ id, workspaceId, instructorUserId: userId, title: id, streamSessionId: `stream-${id}`, startedAt: 100 + index, endedAt: 200 + index });
    const replay = svc.upsertReplay({
      uuid: videoUuid, id: index + 1, name: id, tags: [`rec:${id}`],
      state: { id: 5, label: 'Published' }, privacy: 1,
      files: [{ fileUrl: `https://peertube.example.test/static/${videoUuid}.mp4` }],
    });
    if (index === 0) ws1Replay = replay.replay_id;
    if (index === 1) ws2Replay = replay.replay_id;
    if (index === 2) discardReplay = replay.replay_id;
  }

  const app = express();
  app.use(express.json());
  app.use(roleContext);
  app.use('/api/peertube-replays', router);
  server = await new Promise((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  baseUrl = `http://127.0.0.1:${server.address().port}/api/peertube-replays`;
});

test.after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  try { svc.stop(); } catch {}
  try { db.close(); } catch {}
  fs.rmSync(dbDir, { recursive: true, force: true });
});

test('list/get are workspace-scoped and cross-workspace direct IDs return 404', async () => {
  const list = await request('/');
  assert.equal(list.status, 200);
  assert.ok(list.payload.replays.every((row) => row.workspace_id === 'ws1'));
  assert.equal(typeof list.payload.revision, 'number');

  const cross = await request(`/${ws2Replay}`);
  assert.equal(cross.status, 404);
  const own = await request(`/${ws1Replay}`);
  assert.equal(own.status, 200);
  assert.equal(own.payload.workspace_id, 'ws1');
});

test('viewer cannot add; editor can add private; numeric PeerTube privacy is rejected as visibility', async () => {
  const viewer = await request(`/${ws1Replay}/add`, { method: 'POST', role: 'viewer', body: { visibility: 'PRIVATE' } });
  assert.equal(viewer.status, 403);

  const numeric = await request(`/${ws1Replay}/add`, { method: 'POST', role: 'editor', body: { visibility: 3 } });
  assert.equal(numeric.status, 400);

  const editor = await request(`/${ws1Replay}/add`, { method: 'POST', role: 'editor', body: { visibility: 'PRIVATE' } });
  assert.equal(editor.status, 201);
  assert.equal(editor.payload.replay.library_visibility, 'PRIVATE');
});

test('discard requires workspace administrator and remains workspace scoped', async () => {
  const instructor = await request(`/${discardReplay}/discard`, { method: 'POST', role: 'editor', body: {} });
  assert.equal(instructor.status, 403);
  const cross = await request(`/${discardReplay}/discard`, { method: 'POST', role: 'tenant2', workspace: 'ws2', body: {} });
  assert.equal(cross.status, 404);
  const admin = await request(`/${discardReplay}/discard`, { method: 'POST', role: 'admin', body: {} });
  assert.equal(admin.status, 200);
});

test('retry and archive preserve explicit operator lifecycle state', async () => {
  const discarded = await request(`/${discardReplay}/discard`, { method: 'POST', role: 'admin', body: {} });
  assert.equal(discarded.status, 200);
  const retry = await request(`/${discardReplay}/retry`, { method: 'POST', role: 'admin', body: {} });
  assert.equal(retry.status, 200);
  assert.equal(retry.payload.replay.processing_state, 'processing');
  assert.equal(retry.payload.replay.retry_count, 1);
  const archive = await request(`/${discardReplay}/archive`, { method: 'POST', role: 'admin', body: {} });
  assert.equal(archive.status, 200);
  assert.equal(archive.payload.replay.processing_state, 'archived');
});

test('private replay playback grants are limited to the instructor or administrators', async () => {
  const viewer = await request(`/${ws1Replay}/playback-grant`, { method: 'POST', role: 'viewer', body: {} });
  assert.equal(viewer.status, 403);
  const instructor = await request(`/${ws1Replay}/playback-grant`, { method: 'POST', role: 'editor', body: {} });
  assert.equal(instructor.status, 200);
  assert.match(instructor.payload.url, /\/playback\?grant=/);
});

test('organization visibility requires a request and an org/platform approval', async () => {
  const requested = await request(`/${ws1Replay}/visibility-request`, {
    method: 'POST', role: 'editor', body: { visibility: 'ORGANIZATION_SHARED' },
  });
  assert.equal(requested.status, 200);
  const workspaceAdmin = await request(`/${ws1Replay}/organization-publication/approve`, { method: 'POST', role: 'admin', body: {} });
  assert.equal(workspaceAdmin.status, 403);
  const orgAdmin = await request(`/${ws1Replay}/organization-publication/approve`, { method: 'POST', role: 'org', body: {} });
  assert.equal(orgAdmin.status, 200);
});

test('Media Control visibility changes are explicit and cannot bypass organization approval', async () => {
  const workspaceShared = await request(`/${ws1Replay}/visibility`, {
    method: 'PATCH', role: 'editor', body: { visibility: 'WORKSPACE_SHARED' },
  });
  assert.equal(workspaceShared.status, 200);
  assert.equal(workspaceShared.payload.replay.library_visibility, 'WORKSPACE_SHARED');
  const content = db.prepare('SELECT access_level FROM content WHERE id=?').get(workspaceShared.payload.replay.content_id);
  assert.equal(content.access_level, 'workspace');

  const bypass = await request(`/${ws1Replay}/visibility`, {
    method: 'PATCH', role: 'editor', body: { visibility: 'ORGANIZATION_SHARED' },
  });
  assert.equal(bypass.status, 400);
});

test('worker health endpoint is read-scoped and omits credentials', async () => {
  const health = await request('/health');
  assert.equal(health.status, 200);
  assert.doesNotMatch(JSON.stringify(health.payload), /token|password|authorization/i);
});
