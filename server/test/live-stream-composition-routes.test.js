'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { installIsolatedTestDatabase } = require('./live-stream-test-db');

installIsolatedTestDatabase('live-stream-composition-routes');

function listen(app) {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
    server.once('error', reject);
  });
}

function close(server) {
  return new Promise((resolve) => server.close(resolve));
}

test('composition routes enforce server tenancy, permissions, readiness, audio consent, and revisions', async (t) => {
  process.env.LIVE_PUBLISHER_MODE = 'fixed_compositor';
  delete require.cache[require.resolve('../config')];

  const compositorModule = require('../lib/fixed-compositor-controller');
  const originalControllerGetter = compositorModule.getFixedCompositorController;
  const calls = [];
  const states = new Map();
  const initialState = (workspaceId) => ({
    workspace_id: workspaceId,
    accepted: true,
    requested_layout: 'camera_only',
    confirmed_layout: 'camera_only',
    content_instance_id: null,
    receiver_state: { configured: false, content_active: false, render_ready: false },
    compositor_state: {
      available: true,
      scene: 'MBFD_CAMERA_ONLY',
      confirmed: true,
      audio_policy: 'camera',
    },
    failure_code: null,
    failure_message: null,
    revision: 0,
  });
  const stateFor = (workspaceId) => structuredClone(
    states.get(workspaceId) || initialState(workspaceId),
  );
  const assertRevision = (input) => {
    const current = stateFor(input.workspaceId);
    if (Number(input.expectedRevision) !== current.revision) {
      const error = new Error(`Expected compositor revision ${input.expectedRevision}, current revision is ${current.revision}`);
      error.code = 'COMPOSITOR_REVISION_CONFLICT';
      error.status = 409;
      throw error;
    }
    return current;
  };
  const fakeController = {
    getComposition: stateFor,
    async addContent(input) {
      const current = assertRevision(input);
      calls.push({ action: 'add', input: structuredClone(input) });
      const next = {
        ...current,
        requested_layout: input.layout,
        confirmed_layout: input.layout,
        content_instance_id: input.contentInstanceId,
        receiver_state: {
          configured: true,
          content_active: true,
          render_ready: true,
          content_instance_id: input.contentInstanceId,
        },
        compositor_state: {
          available: true,
          scene: input.layout === 'content_main_camera_pip'
            ? 'MBFD_CONTENT_MAIN_CAMERA_PIP'
            : 'MBFD_CAMERA_MAIN_CONTENT_PIP',
          confirmed: true,
          audio_policy: input.audioPolicy,
        },
        revision: current.revision + 1,
      };
      states.set(input.workspaceId, structuredClone(next));
      return next;
    },
    async setLayout(input) {
      const current = assertRevision(input);
      calls.push({ action: 'layout', input: structuredClone(input) });
      const next = {
        ...current,
        requested_layout: input.layout,
        confirmed_layout: input.layout,
        revision: current.revision + 1,
      };
      states.set(input.workspaceId, structuredClone(next));
      return next;
    },
    async removeContent(input) {
      const current = assertRevision(input);
      calls.push({ action: 'remove', input: structuredClone(input) });
      const next = {
        ...initialState(input.workspaceId),
        receiver_state: { configured: true, content_active: false, render_ready: false },
        revision: current.revision + 1,
      };
      states.set(input.workspaceId, structuredClone(next));
      return next;
    },
  };
  compositorModule.getFixedCompositorController = () => fakeController;

  delete require.cache[require.resolve('../routes/live-stream')];
  const router = require('../routes/live-stream');
  const { db } = require('../db/database');
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const userId = `composition-user-${suffix}`;
  const orgId = `composition-org-${suffix}`;
  const workspaceId = `composition-workspace-${suffix}`;
  const attackerWorkspaceId = `attacker-workspace-${suffix}`;
  const readyContentId = `composition-ready-${suffix}`;
  const preparingContentId = `composition-preparing-${suffix}`;

  db.prepare("INSERT INTO users (id, email, name, role) VALUES (?, ?, 'Composition Test', 'member')")
    .run(userId, `${userId}@example.test`);
  db.prepare('INSERT INTO organizations (id, name, owner_user_id) VALUES (?, ?, ?)')
    .run(orgId, 'Composition Route Test', userId);
  db.prepare('INSERT INTO workspaces (id, organization_id, name, created_by) VALUES (?, ?, ?, ?)')
    .run(workspaceId, orgId, 'Composition Workspace', userId);
  db.prepare("INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, 'workspace_editor')")
    .run(workspaceId, userId);
  db.prepare(`
    INSERT INTO content (
      id, user_id, workspace_id, filename, filepath, mime_type,
      processing_status, access_level
    ) VALUES (?, ?, ?, 'ready.png', '/tmp/ready.png', 'image/png', 'ready', 'private')
  `).run(readyContentId, userId, workspaceId);
  db.prepare(`
    INSERT INTO content (
      id, user_id, workspace_id, filename, filepath, mime_type,
      processing_status, access_level
    ) VALUES (?, ?, ?, 'preparing.png', '/tmp/preparing.png', 'image/png', 'processing', 'private')
  `).run(preparingContentId, userId, workspaceId);

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = { id: userId, role: 'member' };
    req.workspaceId = workspaceId;
    req.workspaceRole = req.get('X-Test-Role') || 'workspace_editor';
    req.organizationId = orgId;
    req.organizationRole = 'organization_member';
    req.actingAs = false;
    next();
  });
  app.use('/api/live-stream', router);
  const server = await listen(app);
  const base = `http://127.0.0.1:${server.address().port}/api/live-stream`;

  t.after(async () => {
    await close(server);
    compositorModule.getFixedCompositorController = originalControllerGetter;
    delete require.cache[require.resolve('../routes/live-stream')];
    db.prepare('DELETE FROM activity_log WHERE user_id = ?').run(userId);
    db.prepare('DELETE FROM audit_log WHERE workspace_id = ? OR actor_id = ?').run(workspaceId, userId);
    db.prepare('DELETE FROM live_stream_composition_requests WHERE workspace_id = ?').run(workspaceId);
    db.prepare('DELETE FROM live_stream_compositions WHERE workspace_id = ?').run(workspaceId);
    db.prepare('DELETE FROM content WHERE id IN (?, ?)').run(readyContentId, preparingContentId);
    db.prepare('DELETE FROM workspace_members WHERE workspace_id = ?').run(workspaceId);
    db.prepare('DELETE FROM workspaces WHERE id = ?').run(workspaceId);
    db.prepare('DELETE FROM organizations WHERE id = ?').run(orgId);
    db.prepare('DELETE FROM users WHERE id = ?').run(userId);
  });

  const addResponse = await fetch(`${base}/composition/content`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Idempotency-Key': `composition-add-${suffix}`,
    },
    body: JSON.stringify({
      workspace_id: attackerWorkspaceId,
      content_id: readyContentId,
      content_instance_id: `instance-${suffix}`,
      layout: 'content_main_camera_pip',
      audio_policy: 'camera',
      expected_compositor_revision: 0,
    }),
  });
  const added = await addResponse.json();
  assert.equal(addResponse.status, 202, JSON.stringify(added));
  assert.equal(added.accepted, true);
  assert.equal(added.requested_layout, 'content_main_camera_pip');
  assert.equal(added.confirmed_layout, 'content_main_camera_pip');
  assert.equal(added.content_instance_id, `instance-${suffix}`);
  assert.equal(added.receiver_state.render_ready, true);
  assert.equal(added.compositor_state.confirmed, true);
  assert.equal(added.failure_code, null);
  assert.equal(added.revision, 1);
  assert.equal(calls[0].input.workspaceId, workspaceId);
  assert.notEqual(calls[0].input.workspaceId, attackerWorkspaceId);
  assert.equal(calls[0].input.source.contentId, readyContentId);

  const conflictResponse = await fetch(`${base}/composition/layout`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      layout: 'camera_main_content_pip',
      idempotency_key: `composition-layout-${suffix}`,
      expected_compositor_revision: 0,
    }),
  });
  const conflict = await conflictResponse.json();
  assert.equal(conflictResponse.status, 409);
  assert.equal(conflict.failure_code, 'COMPOSITOR_REVISION_CONFLICT');
  assert.equal(conflict.revision, 1);

  const consentResponse = await fetch(`${base}/composition/layout`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      layout: 'camera_main_content_pip',
      audio_policy: 'content_replace',
      idempotency_key: `composition-audio-${suffix}`,
      expected_compositor_revision: 1,
    }),
  });
  const consent = await consentResponse.json();
  assert.equal(consentResponse.status, 409);
  assert.equal(consent.failure_code, 'CONTENT_AUDIO_CONFIRMATION_REQUIRED');

  const preparingResponse = await fetch(`${base}/composition/content`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      content_id: preparingContentId,
      content_instance_id: `preparing-instance-${suffix}`,
      layout: 'content_main_camera_pip',
      idempotency_key: `composition-preparing-${suffix}`,
      expected_compositor_revision: 1,
    }),
  });
  const preparing = await preparingResponse.json();
  assert.equal(preparingResponse.status, 409);
  assert.equal(preparing.failure_code, 'CONTENT_NOT_READY');
  assert.equal(calls.filter((call) => call.action === 'add').length, 1);

  const viewerResponse = await fetch(`${base}/composition/content`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Test-Role': 'workspace_viewer' },
    body: JSON.stringify({
      content_id: readyContentId,
      content_instance_id: `viewer-instance-${suffix}`,
      layout: 'content_main_camera_pip',
      idempotency_key: `composition-viewer-${suffix}`,
      expected_compositor_revision: 1,
    }),
  });
  const viewer = await viewerResponse.json();
  assert.equal(viewerResponse.status, 403);
  assert.equal(viewer.code, 'READ_ONLY_WORKSPACE');
  assert.equal(calls.filter((call) => call.action === 'add').length, 1);

  const getResponse = await fetch(`${base}/composition`);
  const current = await getResponse.json();
  assert.equal(getResponse.status, 200);
  assert.equal(getResponse.headers.get('cache-control'), 'no-store');
  assert.equal(current.workspace_id, workspaceId);
  assert.equal(current.revision, 1);

  const removeResponse = await fetch(`${base}/composition/content`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      content_instance_id: `instance-${suffix}`,
      idempotency_key: `composition-remove-${suffix}`,
      expected_compositor_revision: 1,
    }),
  });
  const removed = await removeResponse.json();
  assert.equal(removeResponse.status, 200, JSON.stringify(removed));
  assert.equal(removed.confirmed_layout, 'camera_only');
  assert.equal(removed.content_instance_id, null);
  assert.equal(removed.revision, 2);
});
