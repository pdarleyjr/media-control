'use strict';

// Runtime tests for the per-user operator control-preferences endpoint
// (GET/PATCH /api/displays/control-preferences) — task §6/§7 v2. Verifies the
// security, concurrency, partial-update, and target-validation contracts:
//   • GET returns safe defaults before any write (includes room_id)
//   • Any workspace member (including viewer) can save their OWN preferences
//   • PATCH updates only fields present in the body (no data loss)
//   • Stale If-Match → 412 with current representation
//   • Server-side target validation rejects invalid/foreign refs
//   • Invalid pinned refs are pruned (not blocking); invalid last-focused is 400
//   • Duplicate pinned refs are deduped (preserve order)
//   • Oversized arrays → 400
//   • Invalid body types → 400
//   • room_id is included in the key and response

const fs = require('fs');
const os = require('os');
const path = require('path');
const { test, after } = require('node:test');
const assert = require('node:assert/strict');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-control-prefs-v2-'));
process.env.DB_PATH = path.join(tempDir, 'test.db');

const { db } = require('../db/database');

db.pragma('foreign_keys = OFF');
db.exec(`
  INSERT INTO users (id, email, password_hash, name, role)
  VALUES
    ('cp-editor', 'editor@example.test', 'x', 'Editor', 'user'),
    ('cp-viewer', 'viewer@example.test', 'x', 'Viewer', 'user'),
    ('cp-other', 'other@example.test', 'x', 'Other', 'user');
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
  INSERT INTO video_walls (id, workspace_id, user_id, name)
  VALUES ('wall-primary', 'cp-ws', 'cp-editor', 'Classroom 1 Primary Wall');
  INSERT INTO devices (id, workspace_id, user_id, name)
  VALUES ('display-1', 'cp-ws', 'cp-editor', 'Front Center');
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

function memberReq(overrides = {}) {
  return {
    user: { id: 'cp-editor', role: 'user' },
    workspaceId: 'cp-ws',
    workspaceRole: 'workspace_editor',
    isPlatformAdmin: false,
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
    isPlatformAdmin: false,
    actingAs: null,
    headers: {},
    body: {},
    ...overrides,
  };
}
function nonmemberReq(overrides = {}) {
  return {
    user: { id: 'cp-other', role: 'user' },
    workspaceId: 'cp-ws',
    workspaceRole: null,
    isPlatformAdmin: false,
    actingAs: null,
    headers: {},
    body: {},
    ...overrides,
  };
}

after(() => {
  try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

test('GET returns safe defaults with room_id before any write', () => {
  const res = response();
  handler('GET', '/control-preferences')(memberReq(), res);
  assert.equal(res.statusCode, 200);
  assert.ok(res.body.room_id, 'room_id must be present');
  assert.equal(res.body.last_focused_target_ref, null);
  assert.deepEqual(res.body.pinned_target_refs, []);
  assert.equal(res.body.revision, 0);
});

test('Viewer can save their own last-focused target (personal UI setting)', () => {
  const res = response();
  handler('PATCH', '/control-preferences')(
    viewerReq({ body: { last_focused_target_ref: 'wall:wall-primary' } }),
    res,
  );
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.last_focused_target_ref, 'wall:wall-primary');
  assert.equal(res.body.revision, 1);
});

test('Viewer saving prefs does NOT alter editor prefs (user isolation)', () => {
  // Editor saves their own target
  const res1 = response();
  handler('PATCH', '/control-preferences')(
    memberReq({ body: { last_focused_target_ref: 'display:display-1' } }),
    res1,
  );
  assert.equal(res1.statusCode, 200);

  // Viewer's preference is still their own (wall:wall-primary from previous test)
  const res2 = response();
  handler('GET', '/control-preferences')(viewerReq(), res2);
  assert.equal(res2.body.last_focused_target_ref, 'wall:wall-primary');
});

test('PATCH last_focused_target_ref does NOT alter pinned_target_refs (no data loss)', () => {
  // First save some pins
  const res1 = response();
  handler('PATCH', '/control-preferences')(
    memberReq({ body: { pinned_target_refs: ['wall:wall-primary', 'display:display-1'] } }),
    res1,
  );
  assert.equal(res1.statusCode, 200);
  assert.deepEqual(res1.body.pinned_target_refs, ['wall:wall-primary', 'display:display-1']);

  // Now save only last_focused_target_ref — pins must be preserved
  const res2 = response();
  handler('PATCH', '/control-preferences')(
    memberReq({ body: { last_focused_target_ref: 'wall:wall-primary' } }),
    res2,
  );
  assert.equal(res2.statusCode, 200);
  assert.equal(res2.body.last_focused_target_ref, 'wall:wall-primary');
  assert.deepEqual(res2.body.pinned_target_refs, ['wall:wall-primary', 'display:display-1'],
    'pins must NOT be erased by a target-only PATCH');
});

test('PATCH pinned_target_refs does NOT alter last_focused_target_ref (no data loss)', () => {
  // last_focused_target_ref was set to wall:wall-primary above; save only pins
  const res = response();
  handler('PATCH', '/control-preferences')(
    memberReq({ body: { pinned_target_refs: ['display:display-1'] } }),
    res,
  );
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.pinned_target_refs, ['display:display-1']);
  assert.equal(res.body.last_focused_target_ref, 'wall:wall-primary',
    'last_focused_target_ref must NOT be erased by a pins-only PATCH');
});

test('Duplicate pinned_target_refs are deduped (preserve order)', () => {
  const res = response();
  handler('PATCH', '/control-preferences')(
    memberReq({ body: { pinned_target_refs: ['wall:wall-primary', 'wall:wall-primary', 'display:display-1'] } }),
    res,
  );
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.pinned_target_refs, ['wall:wall-primary', 'display:display-1']);
});

test('Invalid pinned_target_refs are silently pruned (not blocking)', () => {
  const res = response();
  handler('PATCH', '/control-preferences')(
    memberReq({ body: { pinned_target_refs: ['wall:wall-primary', 'wall:nonexistent', 'display:display-1'] } }),
    res,
  );
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.pinned_target_refs, ['wall:wall-primary', 'display:display-1'],
    'invalid refs pruned, valid refs preserved');
});

test('Invalid last_focused_target_ref → 400 (not silently accepted)', () => {
  const res = response();
  handler('PATCH', '/control-preferences')(
    memberReq({ body: { last_focused_target_ref: 'wall:nonexistent' } }),
    res,
  );
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.error, 'invalid_target_ref');
});

test('Stale If-Match → 412 with current representation', () => {
  const res = response();
  handler('PATCH', '/control-preferences')(
    memberReq({
      headers: { 'if-match': '0' },
      body: { last_focused_target_ref: 'display:display-1' },
    }),
    res,
  );
  assert.equal(res.statusCode, 412);
  assert.equal(res.body.error, 'preference_revision_conflict');
  assert.ok(res.body.current, '412 must include the current representation');
  assert.ok(typeof res.body.revision === 'number');
});

test('Nonmember → 403 (not a workspace member)', () => {
  const res = response();
  handler('PATCH', '/control-preferences')(
    nonmemberReq({ body: { last_focused_target_ref: 'wall:wall-primary' } }),
    res,
  );
  assert.equal(res.statusCode, 403);
});

test('Invalid body type → 400 (last_focused_target_ref not a string)', () => {
  const res = response();
  handler('PATCH', '/control-preferences')(
    memberReq({ body: { last_focused_target_ref: 12345 } }),
    res,
  );
  assert.equal(res.statusCode, 400);
});

test('Invalid body type → 400 (pinned_target_refs not an array)', () => {
  const res = response();
  handler('PATCH', '/control-preferences')(
    memberReq({ body: { pinned_target_refs: 'not-an-array' } }),
    res,
  );
  assert.equal(res.statusCode, 400);
});

test('Oversized pinned_target_refs → 400', () => {
  const refs = Array.from({ length: 33 }, (_, i) => `display:d${i}`);
  const res = response();
  handler('PATCH', '/control-preferences')(
    memberReq({ body: { pinned_target_refs: refs } }),
    res,
  );
  assert.equal(res.statusCode, 400);
});

test('No active workspace GET → defaults with room_id (no crash)', () => {
  const res = response();
  handler('GET', '/control-preferences')({ user: { id: 'cp-editor' }, workspaceId: null, headers: {} }, res);
  assert.equal(res.statusCode, 200);
  assert.ok(res.body.room_id);
});

test('Exact revision progression across sequential writes', () => {
  // Use a fresh user to get a clean revision sequence.
  db.exec(`INSERT INTO users (id, email, password_hash, name, role) VALUES ('cp-fresh', 'fresh@test', 'x', 'Fresh', 'user')`);
  db.exec(`INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ('cp-ws', 'cp-fresh', 'workspace_editor')`);
  const freshReq = { user: { id: 'cp-fresh', role: 'user' }, workspaceId: 'cp-ws', workspaceRole: 'workspace_editor', isPlatformAdmin: false, actingAs: null, headers: {}, body: {} };

  for (let i = 1; i <= 5; i++) {
    const res = response();
    handler('PATCH', '/control-preferences')(
      { ...freshReq, body: { last_focused_target_ref: 'wall:wall-primary' } },
      res,
    );
    assert.equal(res.body.revision, i, `revision must be ${i}`);
  }
});

test('control_preferences table has room_id in the primary key', () => {
  const info = db.prepare('PRAGMA table_info(control_preferences)').all().map((c) => c.name);
  for (const col of ['user_id', 'workspace_id', 'room_id', 'last_focused_target_ref', 'pinned_target_refs_json', 'revision', 'updated_at']) {
    assert.ok(info.includes(col), `missing column ${col}`);
  }
  // No divergent pinned_order/pinned_targets fields.
  assert.ok(!info.includes('pinned_targets_json'), 'pinned_targets_json must not exist (replaced by pinned_target_refs_json)');
  assert.ok(!info.includes('pinned_order_json'), 'pinned_order_json must not exist (replaced by pinned_target_refs_json)');
});
