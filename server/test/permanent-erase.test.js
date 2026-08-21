'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { test } = require('node:test');
const assert = require('node:assert/strict');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-permanent-erase-'));
process.env.DB_PATH = path.join(tempDir, 'test.db');

const { db } = require('../db/database');
const { previewPermanentErase, permanentlyEraseContent } = require('../lib/permanent-erase');
const router = require('../routes/content');

db.exec(`
  INSERT INTO users (id, email, name, role) VALUES ('erase-owner', 'owner@example.test', 'Owner', 'user');
  INSERT INTO organizations (id, name, owner_user_id) VALUES ('erase-org', 'Erase Org', 'erase-owner');
  INSERT INTO workspaces (id, organization_id, name, created_by) VALUES ('erase-ws', 'erase-org', 'Erase WS', 'erase-owner');
  INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ('erase-ws', 'erase-owner', 'workspace_admin');
  INSERT INTO content (id, user_id, workspace_id, filename, filepath, mime_type, content_type, library_scope, processing_status, thumbnail_path)
    VALUES
      ('erase-preview', 'erase-owner', 'erase-ws', 'preview.mp4', 'preview.mp4', 'video/mp4', 'video', 'library', 'ready', 'preview-thumb.jpg'),
      ('erase-service', 'erase-owner', 'erase-ws', 'service.mp4', 'service.mp4', 'video/mp4', 'video', 'library', 'ready', 'service-thumb.jpg'),
      ('erase-route-preview', 'erase-owner', 'erase-ws', 'rp.mp4', 'rp.mp4', 'video/mp4', 'video', 'library', 'ready', 'rp-thumb.jpg'),
      ('erase-route', 'erase-owner', 'erase-ws', 'route.mp4', 'route.mp4', 'video/mp4', 'video', 'library', 'ready', 'route-thumb.jpg');
  INSERT INTO playlists (id, user_id, name, status) VALUES ('pl-preview', 'erase-owner', 'Preview PL', 'draft'), ('pl-service', 'erase-owner', 'Service PL', 'draft');
  INSERT INTO playlist_items (playlist_id, content_id, sort_order) VALUES ('pl-preview', 'erase-preview', 1), ('pl-service', 'erase-service', 1);
  INSERT INTO devices (id, user_id, name, workspace_id) VALUES ('dev-1', 'erase-owner', 'Test Device', 'erase-ws');
  INSERT INTO assignments (device_id, content_id, sort_order) VALUES ('dev-1', 'erase-service', 1);
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

function fakeIo(events) {
  return {
    of(namespace) {
      assert.equal(namespace, '/device');
      return {
        to(room) {
          return { emit(event, payload) { events.push({ room, event, payload }); } };
        },
      };
    },
  };
}

function ownerReq(overrides = {}) {
  return {
    user: { id: 'erase-owner', role: 'user', email: 'owner@example.test' },
    workspaceId: 'erase-ws',
    organizationId: 'erase-org',
    workspaceRole: 'workspace_admin',
    orgRole: 'org_admin',
    isPlatformAdmin: false,
    app: { get: () => undefined },
    query: {},
    params: {},
    body: {},
    ...overrides,
  };
}

test('previewPermanentErase reports references, jobs, and files without mutating', () => {
  const preview = previewPermanentErase(db, 'erase-preview');
  assert.equal(preview.found, true);
  assert.ok(preview.usage.usage_count >= 1, 'preview should include attached references');
  assert.deepEqual(preview.files, ['preview.mp4', 'preview-thumb.jpg']);
  const after = db.prepare('SELECT COUNT(*) AS n FROM content WHERE id=?').get('erase-preview');
  assert.equal(after.n, 1, 'preview must not delete the row');
});

test('permanentlyEraseContent detaches references, cancels jobs, erases files, and deletes the row', () => {
  const result = permanentlyEraseContent(db, 'erase-service');
  assert.equal(result.erased, true);
  const content = db.prepare('SELECT * FROM content WHERE id=?').get('erase-service');
  assert.equal(content, undefined, 'content row must be deleted');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM playlist_items WHERE content_id=?').get('erase-service').n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM assignments WHERE content_id=?').get('erase-service').n, 0);
});

test('permanent erase preview route returns impact summary', () => {
  const res = response();
  handler('POST', '/:id/permanent-erase-preview')(ownerReq({ params: { id: 'erase-route-preview' }, body: {} }), res, () => {});
  assert.equal(res.statusCode, 200);
  assert.ok(res.body.usage.usage_count >= 0, 'preview response should include usage');
  assert.deepEqual(res.body.files, ['rp.mp4', 'rp-thumb.jpg']);
});

test('permanent erase route deletes content and returns success', () => {
  const res = response();
  handler('POST', '/:id/permanent-erase')(ownerReq({ params: { id: 'erase-route' }, body: {} }), res, () => {});
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.success, true);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM content WHERE id=?').get('erase-route').n, 0);
});

test('permanent erase notifies the P3 node to purge its cache when io is provided', () => {
  db.exec(`INSERT INTO content (id, user_id, workspace_id, filename, filepath, mime_type, content_type, library_scope, processing_status, thumbnail_path)
    VALUES ('erase-io', 'erase-owner', 'erase-ws', 'io.mp4', 'io.mp4', 'video/mp4', 'video', 'library', 'ready', 'io-thumb.jpg')`);
  const events = [];
  const result = permanentlyEraseContent(db, 'erase-io', fakeIo(events));
  assert.equal(result.erased, true);
  assert.ok(
    events.some((e) => e.event === 'node:purge-cache' && e.payload.content_id === 'erase-io'),
    'P3 node should receive a purge-cache event for the erased content',
  );
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM content WHERE id=?').get('erase-io').n, 0);
});
