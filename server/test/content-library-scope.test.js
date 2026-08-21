'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { test } = require('node:test');
const assert = require('node:assert/strict');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-content-library-scope-'));
process.env.DB_PATH = path.join(tempDir, 'test.db');

const { db } = require('../db/database');
const router = require('../routes/content');

db.exec(`
  INSERT INTO users (id, email, name, role) VALUES ('scope-owner', 'owner@example.test', 'Owner', 'user');
  INSERT INTO organizations (id, name, owner_user_id) VALUES ('scope-org', 'Scope Org', 'scope-owner');
  INSERT INTO workspaces (id, organization_id, name, created_by) VALUES ('scope-ws', 'scope-org', 'Scope WS', 'scope-owner');
  INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ('scope-ws', 'scope-owner', 'workspace_admin');
  INSERT INTO content (id, user_id, workspace_id, filename, filepath, mime_type, content_type, library_scope, processing_status)
    VALUES
      ('scope-lib', 'scope-owner', 'scope-ws', 'library.mp4', 'library.mp4', 'video/mp4', 'video', 'library', 'ready'),
      ('scope-int', 'scope-owner', 'scope-ws', 'internal.png', 'internal.png', 'image/png', 'presentation_asset', 'internal', 'ready');
`);

function handler(method, routePath) {
  const layer = router.stack.find((entry) => entry.route
    && entry.route.path === routePath
    && entry.route.methods[method.toLowerCase()]);
  if (!layer) throw new Error(`Missing ${method} ${routePath}`);
  return layer.route.stack[layer.route.stack.length - 1].handle;
}

function response() {
  const res = { statusCode: 200, body: undefined, setHeader() {}, status(code) { res.statusCode = code; return res; }, json(body) { res.body = body; return res; } };
  return res;
}

function ownerReq(overrides = {}) {
  return {
    user: { id: 'scope-owner', role: 'user', email: 'owner@example.test' },
    workspaceId: 'scope-ws',
    organizationId: 'scope-org',
    workspaceRole: 'workspace_admin',
    orgRole: 'org_admin',
    isPlatformAdmin: false,
    query: {},
    params: {},
    body: {},
    ...overrides,
  };
}

test('normal content listing excludes internal assets by default', () => {
  const res = response();
  handler('GET', '/')(ownerReq({ query: {} }), res, () => {});
  assert.equal(res.statusCode, 200);
  const items = Array.isArray(res.body) ? res.body : res.body.items || [];
  assert.ok(items.every((item) => item.library_scope !== 'internal'), 'internal assets must be hidden from normal listings');
  assert.ok(items.some((item) => item.id === 'scope-lib'), 'library assets must remain visible');
  assert.ok(!items.some((item) => item.id === 'scope-int'), 'internal assets must not appear in normal listings');
});

test('content listing includes internal assets when scope=internal is requested', () => {
  const res = response();
  handler('GET', '/')(ownerReq({ query: { scope: 'internal' } }), res, () => {});
  assert.equal(res.statusCode, 200);
  const items = Array.isArray(res.body) ? res.body : res.body.items || [];
  assert.ok(items.some((item) => item.id === 'scope-int'), 'internal assets must appear when explicitly requested');
  assert.ok(items.some((item) => item.id === 'scope-lib'), 'library assets must still appear when scope=internal');
});

test('internal resolver returns hidden assets for Presentation Studio', () => {
  const res = response();
  handler('GET', '/internal/:id')(ownerReq({ params: { id: 'scope-int' } }), res, () => {});
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.id, 'scope-int');
  assert.equal(res.body.library_scope, 'internal');
});

test('internal resolver returns 404 for library assets', () => {
  const res = response();
  handler('GET', '/internal/:id')(ownerReq({ params: { id: 'scope-lib' } }), res, () => {});
  assert.equal(res.statusCode, 404);
});

test('promote-to-library moves an internal asset into the normal Media Library', () => {
  const res = response();
  handler('POST', '/:id/promote-to-library')(ownerReq({ params: { id: 'scope-int' }, body: {} }), res, () => {});
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.library_scope, 'library');
  const row = db.prepare('SELECT library_scope FROM content WHERE id=?').get('scope-int');
  assert.equal(row.library_scope, 'library');
});

test('promote-to-library rejects library assets', () => {
  const res = response();
  handler('POST', '/:id/promote-to-library')(ownerReq({ params: { id: 'scope-lib' }, body: {} }), res, () => {});
  assert.equal(res.statusCode, 400);
  assert.match(res.body.error, /Only internal assets can be promoted/);
});
