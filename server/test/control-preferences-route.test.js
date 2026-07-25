'use strict';

// Runtime tests for the per-user operator control-preferences endpoint
// (GET/PUT /api/displays/control-preferences) — task §6/§7. Verifies the
// security + concurrency contract that source-grep cannot:
//   • GET returns safe defaults before any write
//   • Editor PUT persists last_focused_target + pinned tabs, bumps revision
//   • Stale If-Match → 412 (optimistic concurrency)
//   • Viewer PUT → 403 (read-only members cannot change navigation prefs)
//   • No active workspace → GET still returns defaults (no crash)
// Restoring the view never emits a playback command (the route is pure state).

const fs = require('fs');
const os = require('os');
const path = require('path');
const { test, after } = require('node:test');
const assert = require('node:assert/strict');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-control-prefs-'));
process.env.DB_PATH = path.join(tempDir, 'test.db');

const { db } = require('../db/database');

db.pragma('foreign_keys = OFF');
db.exec(`
  INSERT INTO users (id, email, password_hash, name, role)
  VALUES
    ('cp-editor', 'editor@example.test', 'x', 'Editor', 'user'),
    ('cp-viewer', 'viewer@example.test', 'x', 'Viewer', 'user');
  INSERT INTO organizations (id, name, owner_user_id)
  VALUES ('cp-org', 'Control Org', 'cp-editor');
  INSERT INTO organization_members (organization_id, user_id, role)
  VALUES ('cp-org', 'cp-editor', 'org_admin');
  INSERT INTO workspaces (id, organization_id, name, created_by)
  VALUES ('cp-ws', 'cp-org', 'Room 1', 'cp-editor');
  INSERT INTO workspace_members (workspace_id, user_id, role)
  VALUES
    ('cp-ws', 'cp-editor', 'workspace_editor'),
    ('cp-ws', 'cp-viewer', 'workspace_viewer');
`);
db.pragma('foreign_keys = ON');

const router = require('../routes/displays');

function handler(method, routePath) {
  const layer = router.stack.find((entry) => entry.route
    && entry.route.path === routePath
    && entry.route.methods[method.toLowerCase()]);
  if (!layer) throw new Error(`Missing ${method} ${routePath}`);
  return layer.route.stack[layer.route.stack.length - 1].handle;
}

function response() {
  const res = {
    statusCode: 200,
    body: undefined,
    status(code) { res.statusCode = code; return res; },
    json(body) { res.body = body; return res; },
  };
  return res;
}

function editorReq(overrides = {}) {
  return {
    user: { id: 'cp-editor', role: 'user' },
    workspaceId: 'cp-ws',
    workspaceRole: 'workspace_editor',
    actingAs: null,
    headers: {},
    body: {},
    ...overrides,
  };
}
function viewerReq(overrides = {}) {
  return {
    user: { id: 'cp-viewer', role: 'user' },
    workspaceId: 'cp-ws',
    workspaceRole: 'workspace_viewer',
    actingAs: null,
    headers: {},
    body: {},
    ...overrides,
  };
}

after(() => {
  try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

test('GET returns safe defaults before any write', () => {
  const res = response();
  handler('GET', '/control-preferences')(editorReq(), res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { last_focused_target: null, pinned_targets: [], pinned_order: [], revision: 0 });
});

test('Editor PUT persists last_focused_target and bumps revision', () => {
  const res = response();
  handler('PUT', '/control-preferences')(
    editorReq({ body: { last_focused_target: 'wall:primary-1' } }),
    res,
  );
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.last_focused_target, 'wall:primary-1');
  assert.equal(res.body.revision, 1);
});

test('GET reflects the persisted preference', () => {
  const res = response();
  handler('GET', '/control-preferences')(editorReq(), res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.last_focused_target, 'wall:primary-1');
  assert.equal(res.body.revision, 1);
});

test('Stale If-Match → 412 optimistic-concurrency conflict', () => {
  const res = response();
  handler('PUT', '/control-preferences')(
    editorReq({ headers: { 'if-match': '0' }, body: { last_focused_target: 'wall:secondary-1' } }),
    res,
  );
  assert.equal(res.statusCode, 412);
  assert.equal(res.body.error, 'preference_revision_conflict');
  assert.equal(res.body.revision, 1);
});

test('PUT persists pinned quick-tab targets', () => {
  const res = response();
  handler('PUT', '/control-preferences')(
    editorReq({ body: { pinned_targets: ['display:d1', 'display:d2'], pinned_order: ['display:d2', 'display:d1'] } }),
    res,
  );
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.pinned_targets, ['display:d1', 'display:d2']);
  assert.deepEqual(res.body.pinned_order, ['display:d2', 'display:d1']);
});

test('Viewer PUT → 403 (read-only members cannot change navigation prefs)', () => {
  const res = response();
  handler('PUT', '/control-preferences')(
    viewerReq({ body: { last_focused_target: 'wall:primary-1' } }),
    res,
  );
  assert.equal(res.statusCode, 403);
});

test('No active workspace GET → defaults (no crash)', () => {
  const res = response();
  handler('GET', '/control-preferences')({ user: { id: 'cp-editor' }, workspaceId: null, headers: {} }, res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { last_focused_target: null, pinned_targets: [], pinned_order: [], revision: 0 });
});

test('control_preferences table exists with the expected unique key', () => {
  const info = db.prepare('PRAGMA table_info(control_preferences)').all().map((c) => c.name);
  for (const col of ['user_id', 'workspace_id', 'last_focused_target', 'pinned_targets_json', 'pinned_order_json', 'revision', 'updated_at']) {
    assert.ok(info.includes(col), `missing column ${col}`);
  }
  // One row per (user, workspace) — the PUT above wrote exactly one row.
  const count = db.prepare('SELECT COUNT(*) AS n FROM control_preferences WHERE user_id = ? AND workspace_id = ?').get('cp-editor', 'cp-ws').n;
  assert.equal(count, 1);
});
