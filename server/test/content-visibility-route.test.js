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
const config = require('../config');
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
    ('cv-template', 'cv-admin', NULL, 'template.png', '', 'image/png', 'platform_template'),
    ('cv-internal', 'cv-owner', 'cv-ws-a', 'extracted.png', '', 'image/png', 'workspace_shared');
  UPDATE content SET library_scope='internal' WHERE id='cv-internal';
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
    headers: {},
    sentFile: null,
    status(code) { res.statusCode = code; return res; },
    json(body) { res.body = body; return res; },
    setHeader(name, value) { res.headers[String(name).toLowerCase()] = value; return res; },
    sendFile(file) { res.sentFile = file; return res; },
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

test('normal Media Library pagination and search never expose internal presentation dependencies', () => {
  for (const query of [{}, { search: 'extracted' }, { pagination: 'cursor', limit: '20' }]) {
    const res = response();
    handler('GET', '/')(peerReq({ query }), res);
    const rows = Array.isArray(res.body) ? res.body : res.body.items;
    assert.equal(rows.some((row) => row.id === 'cv-internal'), false);
  }
});

test('generic content routes and summary do not resolve presentation-internal dependencies', () => {
  const owner = peerReq({
    user: { id: 'cv-owner', role: 'user' },
    workspaceRole: 'workspace_editor',
    params: { id: 'cv-internal' },
  });
  const metadata = response();
  handler('GET', '/:id')(owner, metadata);
  assert.equal(metadata.statusCode, 404);

  const summary = response();
  handler('GET', '/library-summary')(peerReq(), summary);
  assert.equal(summary.statusCode, 200);
  assert.equal(summary.body.total_items, 3);
});

test('internal presentation asset bytes are owner/admin scoped and never cross workspace', (t) => {
  const filename = path.join(`cv-internal-route-${process.pid}`, 'nested.png');
  const file = path.join(config.contentDir, filename);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.from('internal-fixture'));
  t.after(() => {
    try { fs.rmSync(path.dirname(file), { recursive: true, force: true }); } catch {}
    db.prepare("UPDATE content SET filepath='' WHERE id='cv-internal'").run();
  });
  db.prepare("UPDATE content SET filepath=? WHERE id='cv-internal'").run(filename);

  const owner = response();
  handler('GET', '/internal/:id')(peerReq({
    user: { id: 'cv-owner', role: 'user' },
    workspaceRole: 'workspace_editor',
    params: { id: 'cv-internal' },
  }), owner);
  assert.equal(owner.statusCode, 200);
  assert.equal(owner.sentFile, fs.realpathSync(file));
  assert.equal(owner.headers['cache-control'], 'private, no-store');

  const peer = response();
  handler('GET', '/internal/:id')(peerReq({ params: { id: 'cv-internal' } }), peer);
  assert.equal(peer.statusCode, 403);

  const admin = response();
  handler('GET', '/internal/:id')(peerReq({
    user: { id: 'cv-admin', role: 'user' },
    workspaceRole: 'workspace_admin',
    orgRole: 'org_admin',
    params: { id: 'cv-internal' },
  }), admin);
  assert.equal(admin.statusCode, 200);

  const crossWorkspace = response();
  handler('GET', '/internal/:id')(peerReq({
    user: { id: 'cv-owner', role: 'user' },
    workspaceId: 'cv-ws-b',
    workspaceRole: 'workspace_admin',
    params: { id: 'cv-internal' },
  }), crossWorkspace);
  assert.equal(crossWorkspace.statusCode, 403);
});

test('bulk permanent erase preauthorizes every item before mutating any content', async () => {
  db.prepare(`INSERT INTO content
    (id,user_id,workspace_id,filename,filepath,mime_type,access_level)
    VALUES ('cv-bulk-owned','cv-owner','cv-ws-a','bulk.png','','image/png','private')`).run();
  const req = peerReq({
    user: { id: 'cv-owner', role: 'user' },
    workspaceRole: 'workspace_editor',
    body: {
      content_ids: ['cv-bulk-owned', 'cv-other-private'],
      confirm_permanent_erase: true,
    },
    app: { get: () => null },
  });
  const res = response();
  await handler('POST', '/permanent-erase')(req, res);
  assert.equal(res.statusCode, 403);
  assert.equal(db.prepare("SELECT COUNT(*) count FROM content WHERE id='cv-bulk-owned'").get().count, 1);
  assert.equal(db.prepare("SELECT COUNT(*) count FROM content WHERE id='cv-other-private'").get().count, 1);
  db.prepare("DELETE FROM content WHERE id='cv-bulk-owned'").run();
});

test('wallpaper menu and duplicate summary exclude internal presentation dependencies', () => {
  const before = response();
  handler('GET', '/library-summary')(peerReq(), before);
  db.prepare(`UPDATE content SET filepath='internal-wallpaper.png',processing_status='ready',
    original_sha256='internal-duplicate-hash',version=1 WHERE id='cv-internal'`).run();
  db.prepare("UPDATE content SET original_sha256='internal-duplicate-hash' WHERE id='cv-workspace'").run();
  db.prepare(`INSERT INTO asset_checksums
    (asset_id,content_id,generation,sha256,size_bytes,canonical_path,canonical_url,
     is_screensaver,screensaver_category,computed_at)
    VALUES ('cv-internal','cv-internal',1,?,10,'internal-wallpaper.png','/api/content/cv-internal/file',1,'wallpaper',1)
    ON CONFLICT(content_id) DO UPDATE SET is_screensaver=1,screensaver_category='wallpaper'`).run('a'.repeat(64));

  const wallpaper = response();
  handler('GET', '/wallpaper-menu')(peerReq(), wallpaper);
  assert.equal(wallpaper.body.some((item) => item.id === 'cv-internal'), false);
  const after = response();
  handler('GET', '/library-summary')(peerReq(), after);
  assert.equal(after.body.duplicate_items, before.body.duplicate_items);

  db.prepare("DELETE FROM asset_checksums WHERE content_id='cv-internal'").run();
  db.prepare("UPDATE content SET filepath='',processing_status='uploaded',original_sha256=NULL WHERE id='cv-internal'").run();
  db.prepare("UPDATE content SET original_sha256=NULL WHERE id='cv-workspace'").run();
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

test('personal favorites are idempotent, visibility-scoped, and filterable', () => {
  const favoriteReq = {
    ...peerReq(),
    params: { id: 'cv-workspace' },
  };
  const first = response();
  handler('PUT', '/:id/favorite')(favoriteReq, first);
  assert.equal(first.statusCode, 200);
  assert.equal(first.body.is_favorite, true);

  const second = response();
  handler('PUT', '/:id/favorite')(favoriteReq, second);
  assert.equal(second.statusCode, 200);

  const list = response();
  handler('GET', '/')(peerReq({ query: { favorite: '1' } }), list);
  assert.deepEqual(list.body.map((item) => item.id), ['cv-workspace']);
  assert.equal(list.body[0].is_favorite, true);

  const removed = response();
  handler('DELETE', '/:id/favorite')(favoriteReq, removed);
  assert.equal(removed.body.is_favorite, false);
});

test('saved views remain private to the user and workspace', () => {
  const created = response();
  handler('POST', '/saved-views')(peerReq({
    body: {
      name: 'Ready videos',
      query: { type: 'video', processing: 'ready', favorite: true, unexpected: 'discarded' },
    },
  }), created);
  assert.equal(created.statusCode, 201);
  assert.deepEqual(created.body.query, {
    type: 'video',
    processing: 'ready',
    favorite: true,
  });

  const list = response();
  handler('GET', '/saved-views')(peerReq(), list);
  assert.equal(list.body.length, 1);
  assert.equal(list.body[0].name, 'Ready videos');

  const other = response();
  handler('GET', '/saved-views')({
    ...peerReq(),
    user: { id: 'cv-owner', role: 'user' },
  }, other);
  assert.deepEqual(other.body, []);

  const deleted = response();
  handler('DELETE', '/saved-views/:viewId')(peerReq({
    params: { viewId: created.body.id },
  }), deleted);
  assert.equal(deleted.body.deleted, true);
});

test('operational filters, library summary, and tags use authoritative stored metadata', () => {
  db.prepare(`
    UPDATE content
    SET processing_status='ready', width=3840, height=2160,
      thumbnail_path='cv-workspace.jpg', filepath='cv-workspace.mp4',
      file_size=4096, original_filepath='cv-workspace.original.mov'
    WHERE id='cv-workspace'
  `).run();
  db.prepare(`
    INSERT INTO content_media_metadata
      (content_id, source_type, source_identity, detected_mime_type, video_codec, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(content_id) DO UPDATE SET
      source_type=excluded.source_type,
      video_codec=excluded.video_codec
  `).run('cv-workspace', 'upload', 'cv-workspace', 'video/mp4', 'h264', 100, 100);

  const filtered = response();
  handler('GET', '/')(peerReq({
    query: {
      processing: 'ready',
      codec: 'h264',
      dimensions: '4k',
      source: 'local',
      thumbnail: 'ready',
    },
  }), filtered);
  assert.deepEqual(filtered.body.map((item) => item.id), ['cv-workspace']);

  const ownerUpdate = {
    ...peerReq(),
    user: { id: 'cv-owner', role: 'user' },
    workspaceRole: 'workspace_editor',
    params: { id: 'cv-workspace' },
    body: { tags: ['training', 'apparatus'] },
  };
  const tagged = response();
  handler('PUT', '/:id')(ownerUpdate, tagged);
  assert.deepEqual(JSON.parse(tagged.body.tags_json), ['training', 'apparatus']);

  const summary = response();
  handler('GET', '/library-summary')(peerReq(), summary);
  assert.ok(summary.body.total_items >= 2);
  assert.ok(summary.body.storage_bytes >= 4096);
  assert.ok(summary.body.retained_originals >= 1);
});

test('wallpaper menu membership is workspace-governed, manifest-backed, and version-neutral', () => {
  db.prepare(`INSERT INTO content
    (id, user_id, workspace_id, filename, filepath, mime_type, processing_status,
      file_size, access_level, version)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(
      'cv-wallpaper',
      'cv-owner',
      'cv-ws-a',
      'Classroom Map.png',
      'classroom-map.png',
      'image/png',
      'ready',
      4096,
      'workspace_shared',
      7,
    );
  db.prepare(`INSERT INTO asset_checksums
    (asset_id, content_id, generation, sha256, size_bytes, canonical_path,
      canonical_url, is_screensaver, screensaver_category)
    VALUES (?, ?, ?, ?, ?, ?, ?, 0, NULL)`)
    .run(
      'asset-cv-wallpaper',
      'cv-wallpaper',
      7,
      'a'.repeat(64),
      4096,
      'classroom-map.png',
      '/api/content/cv-wallpaper/file',
    );
  db.prepare(`INSERT INTO content_publication_requests
    (id, content_id, requested_by, requested_version)
    VALUES ('cv-wallpaper-publication', 'cv-wallpaper', 'cv-owner', 7)`).run();

  const editorReq = {
    ...peerReq(),
    user: { id: 'cv-owner', role: 'user' },
    workspaceRole: 'workspace_editor',
    params: { id: 'cv-wallpaper' },
  };
  const add = response();
  handler('PUT', '/:id/wallpaper-menu')({
    ...editorReq,
    body: { enabled: true, expected_version: 7 },
  }, add);
  assert.equal(add.statusCode, 200);
  assert.equal(add.body.is_wallpaper_menu, true);

  const addAgain = response();
  handler('PUT', '/:id/wallpaper-menu')({
    ...editorReq,
    body: { enabled: true, expected_version: 7 },
  }, addAgain);
  assert.equal(addAgain.statusCode, 200);
  assert.equal(addAgain.body.is_wallpaper_menu, true);

  const stored = db.prepare(`SELECT c.version, ac.generation, ac.sha256,
      ac.is_screensaver, ac.screensaver_category
    FROM content c JOIN asset_checksums ac ON ac.content_id = c.id
    WHERE c.id = 'cv-wallpaper'`).get();
  assert.equal(stored.version, 7);
  assert.equal(stored.generation, 7);
  assert.equal(stored.sha256, 'a'.repeat(64));
  assert.equal(stored.is_screensaver, 1);
  assert.equal(stored.screensaver_category, 'wallpaper');
  assert.equal(
    db.prepare("SELECT status FROM content_publication_requests WHERE id='cv-wallpaper-publication'").get().status,
    'pending',
  );

  const menu = response();
  handler('GET', '/wallpaper-menu')(peerReq(), menu);
  assert.deepEqual(menu.body.map(item => item.id), ['cv-wallpaper']);
  assert.equal(menu.body[0].is_wallpaper_menu, true);

  db.prepare("UPDATE content SET access_level='private' WHERE id='cv-wallpaper'").run();
  const privatePeerMenu = response();
  handler('GET', '/wallpaper-menu')(peerReq(), privatePeerMenu);
  assert.deepEqual(privatePeerMenu.body, []);
  const privateOwnerMenu = response();
  handler('GET', '/wallpaper-menu')({ ...editorReq, params: {}, query: {} }, privateOwnerMenu);
  assert.deepEqual(privateOwnerMenu.body.map(item => item.id), ['cv-wallpaper']);
  db.prepare("UPDATE content SET access_level='workspace_shared' WHERE id='cv-wallpaper'").run();

  const viewerHandlers = routeStack('PUT', '/:id/wallpaper-menu');
  let viewerContinued = false;
  const viewerDenied = response();
  viewerHandlers[0](peerReq({ params: { id: 'cv-wallpaper' }, body: { enabled: false } }), viewerDenied, () => {
    viewerContinued = true;
  });
  assert.equal(viewerDenied.statusCode, 403);
  assert.equal(viewerContinued, false);

  const crossWorkspace = response();
  handler('PUT', '/:id/wallpaper-menu')({
    ...editorReq,
    user: { id: 'cv-admin', role: 'platform_admin' },
    isPlatformAdmin: true,
    orgRole: 'org_admin',
    params: { id: 'cv-org-shared' },
    body: { enabled: true },
  }, crossWorkspace);
  assert.equal(crossWorkspace.statusCode, 403);

  db.prepare("UPDATE content SET archived_at=strftime('%s','now') WHERE id='cv-wallpaper'").run();
  const archivedMenu = response();
  handler('GET', '/wallpaper-menu')(peerReq(), archivedMenu);
  assert.deepEqual(archivedMenu.body, []);

  const remove = response();
  handler('PUT', '/:id/wallpaper-menu')({
    ...editorReq,
    body: { enabled: false, expected_version: 7 },
  }, remove);
  assert.equal(remove.statusCode, 200);
  assert.equal(remove.body.is_wallpaper_menu, false);
  db.prepare("UPDATE content SET archived_at=NULL WHERE id='cv-wallpaper'").run();
  const restoredMenu = response();
  handler('GET', '/wallpaper-menu')(peerReq(), restoredMenu);
  assert.deepEqual(restoredMenu.body, []);
  const removedManifest = db.prepare(`SELECT generation, is_screensaver, screensaver_category
    FROM asset_checksums WHERE content_id='cv-wallpaper'`).get();
  assert.deepEqual(removedManifest, { generation: 7, is_screensaver: 0, screensaver_category: null });
  assert.deepEqual(
    db.prepare(`SELECT action FROM activity_log
      WHERE action IN ('content:wallpaper_menu_add', 'content:wallpaper_menu_remove')`)
      .all().map(row => row.action).sort(),
    ['content:wallpaper_menu_add', 'content:wallpaper_menu_remove'],
  );

  const invalidState = response();
  handler('PUT', '/:id/wallpaper-menu')({ ...editorReq, body: { enabled: 'yes' } }, invalidState);
  assert.equal(invalidState.statusCode, 400);
  const versionConflict = response();
  handler('PUT', '/:id/wallpaper-menu')({
    ...editorReq,
    body: { enabled: true, expected_version: 6 },
  }, versionConflict);
  assert.equal(versionConflict.body.code, 'CONTENT_VERSION_CONFLICT');
  db.prepare("UPDATE asset_checksums SET canonical_path='wrong.png' WHERE content_id='cv-wallpaper'").run();
  const mismatchedManifest = response();
  handler('PUT', '/:id/wallpaper-menu')({
    ...editorReq,
    body: { enabled: true, expected_version: 7 },
  }, mismatchedManifest);
  assert.equal(mismatchedManifest.body.code, 'CONTENT_NOT_READY');

  db.prepare("DELETE FROM content WHERE id='cv-wallpaper'").run();
});

after(() => {
  try { db.close(); } catch {}
  fs.rmSync(tempDir, { recursive: true, force: true });
});
