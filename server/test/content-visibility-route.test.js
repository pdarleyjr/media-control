'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const MV = require('../player/multiview-core');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-content-visibility-route-'));
process.env.DB_PATH = path.join(tempDir, 'test.db');

const { db } = require('../db/database');
const { applyContentVisibilityMigration, VISIBILITY } = require('../lib/content-visibility');
applyContentVisibilityMigration(db);

db.pragma('foreign_keys = OFF');
db.exec(`
  INSERT INTO users (id, email, password_hash, name, role)
  VALUES
    ('cv-owner', 'owner@example.test', 'x', 'Owner', 'user'),
    ('cv-peer', 'peer@example.test', 'x', 'Peer', 'user'),
    ('cv-admin', 'admin@example.test', 'x', 'Admin', 'user'),
    ('cv-other', 'other@example.test', 'x', 'Other', 'user');
  INSERT INTO organizations (id, name, owner_user_id)
  VALUES ('cv-org', 'Visibility Org', 'cv-admin'), ('cv-other-org', 'Other Org', 'cv-other');
  INSERT INTO organization_members (organization_id, user_id, role)
  VALUES ('cv-org', 'cv-admin', 'org_admin');
  INSERT INTO workspaces (id, organization_id, name, created_by)
  VALUES
    ('cv-ws-a', 'cv-org', 'Room A', 'cv-owner'),
    ('cv-ws-b', 'cv-org', 'Room B', 'cv-owner'),
    ('cv-ws-other', 'cv-other-org', 'Other Room', 'cv-other');
  INSERT INTO workspace_members (workspace_id, user_id, role)
  VALUES
    ('cv-ws-a', 'cv-owner', 'workspace_editor'),
    ('cv-ws-a', 'cv-peer', 'workspace_viewer'),
    ('cv-ws-a', 'cv-admin', 'workspace_admin'),
    ('cv-ws-other', 'cv-other', 'workspace_admin');
  INSERT INTO content (id, user_id, workspace_id, filename, filepath, mime_type, access_level)
  VALUES
    ('cv-private', 'cv-owner', 'cv-ws-a', 'private.png', '', 'image/png', 'private'),
    ('cv-workspace', 'cv-owner', 'cv-ws-a', 'workspace.png', '', 'image/png', 'workspace_shared'),
    ('cv-org-shared', 'cv-owner', 'cv-ws-b', 'organization.png', '', 'image/png', 'organization_shared'),
    ('cv-other-private', 'cv-other', 'cv-ws-other', 'other.png', '', 'image/png', 'private'),
    ('cv-template', 'cv-admin', NULL, 'template.png', '', 'image/png', 'platform_template');
  INSERT INTO content_template_assignments (content_id, workspace_id, assigned_by)
  VALUES ('cv-template', 'cv-ws-a', 'cv-admin');
`);
db.pragma('foreign_keys = ON');

const router = require('../routes/content');

function handler(method, routePath) {
  const layer = router.stack.find((entry) => entry.route
    && entry.route.path === routePath
    && entry.route.methods[method.toLowerCase()]);
  if (!layer) throw new Error(`Missing ${method} ${routePath}`);
  return layer.route.stack[layer.route.stack.length - 1].handle;
}

function routeStack(method, routePath) {
  const layer = router.stack.find((entry) => entry.route
    && entry.route.path === routePath
    && entry.route.methods[method.toLowerCase()]);
  if (!layer) throw new Error(`Missing ${method} ${routePath}`);
  return layer.route.stack.map((entry) => entry.handle);
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

function peerReq(overrides = {}) {
  return {
    user: { id: 'cv-peer', role: 'user' },
    workspaceId: 'cv-ws-a',
    organizationId: 'cv-org',
    workspaceRole: 'workspace_viewer',
    orgRole: null,
    isPlatformAdmin: false,
    query: {},
    params: {},
    body: {},
    ...overrides,
  };
}

test('content list follows all four visibility levels without cross-organization leakage', () => {
  const res = response();
  handler('GET', '/')(peerReq(), res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.map((row) => row.id).sort(), ['cv-org-shared', 'cv-template', 'cv-workspace']);
  const workspace = res.body.find((row) => row.id === 'cv-workspace');
  assert.equal(workspace.visibility.access_level, VISIBILITY.WORKSPACE_SHARED);
  assert.equal(workspace.permissions.can_duplicate, false);
});

test('direct metadata access denies a private-content IDOR to a peer', () => {
  const res = response();
  handler('GET', '/:id')(peerReq({ params: { id: 'cv-private' } }), res);
  assert.equal(res.statusCode, 403);
  assert.match(res.body.error, /access denied/i);
});

test('workspace viewers are denied before upload middleware or any content mutation', () => {
  for (const [method, routePath] of [['POST', '/'], ['PUT', '/:id/replace'], ['PUT', '/:id'], ['DELETE', '/:id']]) {
    const handlers = routeStack(method, routePath);
    let continued = false;
    const res = response();
    handlers[0](peerReq({ params: { id: 'cv-private' } }), res, () => { continued = true; });
    assert.equal(res.statusCode, 403, `${method} ${routePath}`);
    assert.equal(continued, false, `${method} ${routePath} must stop before later middleware`);
  }
});

test('owner can publish private content to the workspace but cannot self-publish organization-wide', () => {
  const ownerReq = {
    ...peerReq(),
    user: { id: 'cv-owner', role: 'user' },
    workspaceRole: 'workspace_editor',
    params: { id: 'cv-private' },
  };
  const publishRes = response();
  handler('PUT', '/:id')({ ...ownerReq, body: { access_level: VISIBILITY.WORKSPACE_SHARED } }, publishRes);
  assert.equal(publishRes.statusCode, 200);
  assert.equal(publishRes.body.access_level, VISIBILITY.WORKSPACE_SHARED);

  const orgRes = response();
  handler('PUT', '/:id')({ ...ownerReq, body: { access_level: VISIBILITY.ORGANIZATION_SHARED } }, orgRes);
  assert.equal(orgRes.statusCode, 403);
  assert.match(orgRes.body.error, /organization admin/i);
});

test('a visibility downgrade is blocked while content is routed to a display workflow', () => {
  db.prepare(`INSERT INTO playlists (id, user_id, workspace_id, name)
    VALUES ('cv-active-playlist', 'cv-admin', 'cv-ws-a', 'Active')`).run();
  db.prepare(`INSERT INTO playlist_items (playlist_id, content_id)
    VALUES ('cv-active-playlist', 'cv-private')`).run();
  db.prepare("UPDATE content SET access_level='organization_shared' WHERE id='cv-private'").run();

  const res = response();
  handler('PUT', '/:id')({
    ...peerReq(),
    user: { id: 'cv-admin', role: 'user' },
    workspaceRole: 'workspace_admin',
    orgRole: 'org_admin',
    params: { id: 'cv-private' },
    body: { access_level: VISIBILITY.PRIVATE },
  }, res);
  assert.equal(res.statusCode, 409);
  assert.equal(res.body.code, 'CONTENT_IN_USE');
  db.prepare("DELETE FROM playlists WHERE id='cv-active-playlist'").run();
});

test('platform template assignment cannot be revoked from a workspace while actively routed there', () => {
  db.prepare(`INSERT INTO playlists (id, user_id, workspace_id, name)
    VALUES ('cv-template-playlist', 'cv-admin', 'cv-ws-a', 'Template route')`).run();
  db.prepare(`INSERT INTO playlist_items (playlist_id, content_id)
    VALUES ('cv-template-playlist', 'cv-template')`).run();
  const platformReq = {
    ...peerReq(),
    user: { id: 'cv-admin', role: 'platform_admin' },
    workspaceRole: 'workspace_admin',
    orgRole: 'org_admin',
    isPlatformAdmin: true,
    params: { id: 'cv-template' },
    body: { workspace_ids: [] },
  };
  const blocked = response();
  handler('PUT', '/:id/template-assignments')(platformReq, blocked);
  assert.equal(blocked.statusCode, 409);
  assert.equal(blocked.body.code, 'CONTENT_IN_USE');

  db.prepare("DELETE FROM playlists WHERE id='cv-template-playlist'").run();
  const allowed = response();
  handler('PUT', '/:id/template-assignments')(platformReq, allowed);
  assert.equal(allowed.statusCode, 200);
  assert.deepEqual(allowed.body.workspace_ids, []);
});

test('template revocation detects widget and nested multiview publication routes', () => {
  db.prepare(`INSERT OR IGNORE INTO content_template_assignments (content_id, workspace_id, assigned_by)
    VALUES ('cv-template', 'cv-ws-a', 'cv-admin')`).run();
  db.prepare(`INSERT INTO widgets (id, user_id, workspace_id, widget_type, name, config)
    VALUES ('cv-template-widget', 'cv-owner', 'cv-ws-a', 'web', 'Template widget', ?)`).run(
    JSON.stringify({ url: '/api/content/cv-template/file' }),
  );
  const platformReq = {
    ...peerReq(),
    user: { id: 'cv-admin', role: 'platform_admin' },
    workspaceRole: 'workspace_admin',
    orgRole: 'org_admin',
    isPlatformAdmin: true,
    params: { id: 'cv-template' },
    body: { workspace_ids: [] },
  };
  const widgetBlocked = response();
  handler('PUT', '/:id/template-assignments')(platformReq, widgetBlocked);
  assert.equal(widgetBlocked.statusCode, 409);
  assert.ok(widgetBlocked.body.references.some((ref) => ref.type === 'widget'));
  db.prepare("DELETE FROM widgets WHERE id='cv-template-widget'").run();

  const cells = MV.encodeCells({
    L1: { u: '/api/content/cv-template/file', l: 'Template', k: 'v' },
  });
  db.prepare(`INSERT INTO content
    (id, user_id, workspace_id, filename, filepath, mime_type, remote_url, access_level)
    VALUES ('cv-grid', 'cv-owner', 'cv-ws-a', 'Grid', '', 'text/html', ?, 'private')`).run(
    `/player/grid.html?cells=${cells}`,
  );
  db.prepare(`INSERT INTO playlists (id, user_id, workspace_id, name)
    VALUES ('cv-grid-playlist', 'cv-owner', 'cv-ws-a', 'Grid route')`).run();
  db.prepare(`INSERT INTO playlist_items (playlist_id, content_id)
    VALUES ('cv-grid-playlist', 'cv-grid')`).run();
  const gridBlocked = response();
  handler('PUT', '/:id/template-assignments')(platformReq, gridBlocked);
  assert.equal(gridBlocked.statusCode, 409);
  assert.ok(gridBlocked.body.references.some((ref) => ref.type === 'grid_dependency'));

  db.prepare("DELETE FROM playlists WHERE id='cv-grid-playlist'").run();
  db.prepare("DELETE FROM content WHERE id='cv-grid'").run();
  db.prepare("DELETE FROM content_template_assignments WHERE content_id='cv-template'").run();
});

test('publication approval cannot race content metadata changes', () => {
  const owner = {
    ...peerReq(),
    user: { id: 'cv-owner', role: 'user' },
    workspaceRole: 'workspace_editor',
    params: { id: 'cv-workspace' },
  };
  const requested = response();
  handler('POST', '/:id/publication-request')(owner, requested);
  assert.equal(requested.statusCode, 201);

  const changed = response();
  handler('PUT', '/:id')({ ...owner, body: { filename: 'changed-after-request.png', expected_version: 1 } }, changed);
  assert.equal(changed.statusCode, 200);

  const approval = response();
  handler('PUT', '/publication-requests/:requestId')({
    ...peerReq(),
    user: { id: 'cv-admin', role: 'user' },
    workspaceRole: 'workspace_admin',
    orgRole: 'org_admin',
    params: { requestId: requested.body.id },
    body: { decision: 'approved' },
  }, approval);
  assert.equal(approval.statusCode, 409);
  assert.match(approval.body.error, /no longer pending|changed/i);
});

test('publication request, approval, private duplicate, archive, and transfer form an audited lifecycle', () => {
  db.prepare("UPDATE content SET access_level='workspace_shared', archived_at=NULL, user_id='cv-owner' WHERE id='cv-private'").run();
  const ownerReq = {
    ...peerReq(),
    user: { id: 'cv-owner', role: 'user' },
    workspaceRole: 'workspace_editor',
    params: { id: 'cv-private' },
  };
  const requestRes = response();
  handler('POST', '/:id/publication-request')(ownerReq, requestRes);
  assert.equal(requestRes.statusCode, 201);
  assert.equal(requestRes.body.status, 'pending');

  const adminReq = {
    ...peerReq(),
    user: { id: 'cv-admin', role: 'user' },
    workspaceRole: 'workspace_admin',
    orgRole: 'org_admin',
  };
  const listRes = response();
  handler('GET', '/publication-requests')(adminReq, listRes);
  assert.equal(listRes.statusCode, 200);
  assert.equal(listRes.body.length, 1);

  const approveRes = response();
  handler('PUT', '/publication-requests/:requestId')({
    ...adminReq,
    params: { requestId: requestRes.body.id },
    body: { decision: 'approved' },
  }, approveRes);
  assert.equal(approveRes.statusCode, 200);
  assert.equal(approveRes.body.content.access_level, VISIBILITY.ORGANIZATION_SHARED);

  const duplicateRes = response();
  handler('POST', '/:id/duplicate')({
    ...peerReq(), workspaceRole: 'workspace_editor', params: { id: 'cv-private' },
  }, duplicateRes);
  assert.equal(duplicateRes.statusCode, 201);
  assert.equal(duplicateRes.body.access_level, VISIBILITY.PRIVATE);
  assert.equal(duplicateRes.body.user_id, 'cv-peer');
  assert.equal(duplicateRes.body.workspace_id, 'cv-ws-a');
  assert.equal(duplicateRes.body.source_content_id, 'cv-private');

  const archiveRes = response();
  handler('PUT', '/:id/archive')({ ...ownerReq, body: { archived: true } }, archiveRes);
  assert.equal(archiveRes.statusCode, 200);
  assert.ok(archiveRes.body.archived_at);

  const transferRes = response();
  handler('PUT', '/:id/transfer')({
    ...adminReq,
    params: { id: duplicateRes.body.id },
    body: { owner_user_id: 'cv-owner' },
  }, transferRes);
  assert.equal(transferRes.statusCode, 200);
  assert.equal(transferRes.body.user_id, 'cv-owner');
});

after(() => {
  try { db.close(); } catch {}
  fs.rmSync(tempDir, { recursive: true, force: true });
});
