'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');

const {
  VISIBILITY,
  applyContentVisibilityMigration,
  contentVisibilityScope,
  contentCapabilities,
  canReadContent,
  canUseContentInWorkspace,
} = require('../lib/content-visibility');

function fixture() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE users (id TEXT PRIMARY KEY, role TEXT);
    CREATE TABLE organizations (id TEXT PRIMARY KEY, name TEXT, owner_user_id TEXT);
    CREATE TABLE organization_members (
      organization_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      role TEXT NOT NULL,
      PRIMARY KEY (organization_id, user_id)
    );
    CREATE TABLE workspaces (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL,
      name TEXT,
      created_by TEXT
    );
    CREATE TABLE workspace_members (
      workspace_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      role TEXT NOT NULL,
      PRIMARY KEY (workspace_id, user_id)
    );
    CREATE TABLE content (
      id TEXT PRIMARY KEY,
      user_id TEXT,
      workspace_id TEXT,
      filename TEXT NOT NULL,
      filepath TEXT NOT NULL DEFAULT '',
      mime_type TEXT NOT NULL,
      file_size INTEGER NOT NULL DEFAULT 0,
      access_level TEXT DEFAULT 'private',
      created_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
    );
    CREATE TABLE schema_migrations (
      id TEXT PRIMARY KEY,
      ran_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
    );

    INSERT INTO users VALUES ('owner-a', 'user');
    INSERT INTO users VALUES ('member-a', 'user');
    INSERT INTO users VALUES ('admin-a', 'user');
    INSERT INTO users VALUES ('member-b', 'user');
    INSERT INTO users VALUES ('platform', 'platform_admin');
    INSERT INTO organizations VALUES ('org-a', 'Org A', 'admin-a');
    INSERT INTO organizations VALUES ('org-b', 'Org B', 'member-b');
    INSERT INTO workspaces VALUES ('ws-a1', 'org-a', 'A1', 'owner-a');
    INSERT INTO workspaces VALUES ('ws-a2', 'org-a', 'A2', 'owner-a');
    INSERT INTO workspaces VALUES ('ws-b1', 'org-b', 'B1', 'member-b');
    INSERT INTO workspace_members VALUES ('ws-a1', 'owner-a', 'workspace_editor');
    INSERT INTO workspace_members VALUES ('ws-a1', 'member-a', 'workspace_viewer');
    INSERT INTO workspace_members VALUES ('ws-a1', 'admin-a', 'workspace_admin');
    INSERT INTO workspace_members VALUES ('ws-b1', 'member-b', 'workspace_admin');
    INSERT INTO organization_members VALUES ('org-a', 'admin-a', 'org_admin');

    INSERT INTO content VALUES ('private-a', 'owner-a', 'ws-a1', 'private.png', '', 'image/png', 0, 'private', 1);
    INSERT INTO content VALUES ('workspace-a', 'owner-a', 'ws-a1', 'workspace.png', '', 'image/png', 0, 'workspace_shared', 2);
    INSERT INTO content VALUES ('org-a2', 'owner-a', 'ws-a2', 'org.png', '', 'image/png', 0, 'organization_shared', 3);
    INSERT INTO content VALUES ('private-b', 'member-b', 'ws-b1', 'other.png', '', 'image/png', 0, 'private', 4);
    INSERT INTO content VALUES ('template', 'platform', NULL, 'template.png', '', 'image/png', 0, 'platform_template', 5);
  `);
  applyContentVisibilityMigration(db);
  return db;
}

test('migration adds governed lifecycle fields and safely classifies platform rows', () => {
  const db = fixture();
  const columns = new Set(db.prepare('PRAGMA table_info(content)').all().map((row) => row.name));
  for (const name of ['published_at', 'published_by', 'source_content_id', 'version', 'archived_at']) {
    assert.ok(columns.has(name), `missing ${name}`);
  }
  assert.equal(db.prepare("SELECT access_level FROM content WHERE id='template'").get().access_level, VISIBILITY.PLATFORM_TEMPLATE);
  assert.ok(db.prepare("SELECT 1 FROM schema_migrations WHERE id='content_visibility_v1'").get());
  assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='content_publication_requests'").get());
  db.close();
});

test('migration fails closed for unclassified global content instead of hiding or promoting it', () => {
  const db = fixture();
  db.prepare(`INSERT INTO content
    (id, user_id, workspace_id, filename, filepath, mime_type, file_size, access_level)
    VALUES ('legacy-global', 'platform', NULL, 'legacy.png', '', 'image/png', 0, 'private')`).run();
  assert.throws(
    () => applyContentVisibilityMigration(db),
    /1 global content row\(s\) require explicit platform_template classification/,
  );
  assert.equal(db.prepare("SELECT access_level FROM content WHERE id='legacy-global'").get().access_level, 'private');
  db.close();
});

test('scope exposes private ownership, workspace sharing, organization sharing, and templates without cross-org leakage', () => {
  const db = fixture();
  const scope = contentVisibilityScope({
    workspaceId: 'ws-a1',
    organizationId: 'org-a',
    userId: 'member-a',
    workspaceRole: 'workspace_viewer',
    orgRole: null,
    isPlatformAdmin: false,
  }, { alias: 'c' });
  const ids = db.prepare(`SELECT c.id FROM content c WHERE ${scope.clause} ORDER BY c.id`).all(...scope.params).map((r) => r.id);
  assert.deepEqual(ids, ['org-a2', 'template', 'workspace-a']);
  db.close();
});

test('owner sees own private content and workspace admin sees private content only in the administered workspace', () => {
  const db = fixture();
  const ownerScope = contentVisibilityScope({
    workspaceId: 'ws-a1', organizationId: 'org-a', userId: 'owner-a', workspaceRole: 'workspace_editor', orgRole: null,
  }, { alias: 'c' });
  assert.ok(db.prepare(`SELECT 1 FROM content c WHERE c.id='private-a' AND ${ownerScope.clause}`).get(...ownerScope.params));

  const adminScope = contentVisibilityScope({
    workspaceId: 'ws-a1', organizationId: 'org-a', userId: 'admin-a', workspaceRole: 'workspace_admin', orgRole: 'org_admin',
  }, { alias: 'c' });
  const ids = db.prepare(`SELECT c.id FROM content c WHERE ${adminScope.clause} ORDER BY c.id`).all(...adminScope.params).map((r) => r.id);
  assert.deepEqual(ids, ['org-a2', 'private-a', 'template', 'workspace-a']);
  assert.ok(!ids.includes('private-b'));
  db.close();
});

test('read predicate denies private rows to ordinary peers and allows authorized administrators', () => {
  const row = { user_id: 'owner-a', workspace_id: 'ws-a1', organization_id: 'org-a', access_level: VISIBILITY.PRIVATE };
  assert.equal(canReadContent(row, { userId: 'member-a', workspaceId: 'ws-a1', organizationId: 'org-a', workspaceRole: 'workspace_viewer' }), false);
  assert.equal(canReadContent(row, { userId: 'admin-a', workspaceId: 'ws-a1', organizationId: 'org-a', workspaceRole: 'workspace_admin' }), true);
  assert.equal(canReadContent(row, { userId: 'platform', isPlatformAdmin: true }), true);
});

test('capabilities enforce publication authority and owner self-service', () => {
  const ownPrivate = { user_id: 'owner-a', workspace_id: 'ws-a1', organization_id: 'org-a', access_level: VISIBILITY.PRIVATE, archived_at: null };
  const owner = contentCapabilities(ownPrivate, {
    userId: 'owner-a', workspaceId: 'ws-a1', organizationId: 'org-a', workspaceRole: 'workspace_editor', orgRole: null,
  });
  assert.deepEqual(owner.allowedVisibilities, [VISIBILITY.PRIVATE, VISIBILITY.WORKSPACE_SHARED]);
  assert.equal(owner.canRequestOrganization, true);
  assert.equal(owner.canTransfer, false);
  assert.equal(owner.canArchive, true);
  assert.equal(owner.canDelete, false, 'active content must be archived before permanent deletion');

  const viewerOwner = contentCapabilities(ownPrivate, {
    userId: 'owner-a', workspaceId: 'ws-a1', organizationId: 'org-a', workspaceRole: 'workspace_viewer', orgRole: null,
  });
  assert.equal(viewerOwner.canEditMetadata, false);
  assert.equal(viewerOwner.canChangeVisibility, false);
  assert.equal(viewerOwner.canRequestOrganization, false);
  assert.equal(viewerOwner.canDuplicate, false);
  assert.equal(viewerOwner.canArchive, false);

  const archivedOwner = contentCapabilities({ ...ownPrivate, archived_at: 123 }, {
    userId: 'owner-a', workspaceId: 'ws-a1', organizationId: 'org-a', workspaceRole: 'workspace_editor', orgRole: null,
  });
  assert.equal(archivedOwner.canDelete, true);

  const orgAdmin = contentCapabilities(ownPrivate, {
    userId: 'admin-a', workspaceId: 'ws-a1', organizationId: 'org-a', workspaceRole: 'workspace_admin', orgRole: 'org_admin',
  });
  assert.ok(orgAdmin.allowedVisibilities.includes(VISIBILITY.ORGANIZATION_SHARED));
  assert.equal(orgAdmin.canTransfer, true);

  const platform = contentCapabilities(ownPrivate, { userId: 'platform', isPlatformAdmin: true });
  assert.ok(platform.allowedVisibilities.includes(VISIBILITY.PLATFORM_TEMPLATE));
});

test('migration rejects invalid visibility values after normalization', () => {
  const db = fixture();
  assert.throws(
    () => db.prepare("UPDATE content SET access_level='public' WHERE id='private-a'").run(),
    /invalid content visibility/i,
  );
  db.close();
});

test('rerunning the migration preserves an administrator template unassignment', () => {
  const db = fixture();
  db.prepare("DELETE FROM content_template_assignments WHERE content_id='template' AND workspace_id='ws-a1'").run();
  applyContentVisibilityMigration(db);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM content_template_assignments WHERE content_id='template' AND workspace_id='ws-a1'").get().count, 0);
  db.close();
});

test('content consumption respects destination workspace, organization, template assignment, and archive state', () => {
  const common = { userId: 'member-a', workspaceRole: 'workspace_viewer', organizationId: 'org-a' };
  assert.equal(canUseContentInWorkspace({
    user_id: 'owner-a', workspace_id: 'ws-a1', organization_id: 'org-a', access_level: VISIBILITY.WORKSPACE_SHARED,
  }, { ...common, workspaceId: 'ws-a1' }), true);
  assert.equal(canUseContentInWorkspace({
    user_id: 'owner-a', workspace_id: 'ws-a1', organization_id: 'org-a', access_level: VISIBILITY.WORKSPACE_SHARED,
  }, { ...common, workspaceId: 'ws-a2' }), false);
  assert.equal(canUseContentInWorkspace({
    user_id: 'owner-a', workspace_id: 'ws-a1', organization_id: 'org-a', access_level: VISIBILITY.ORGANIZATION_SHARED,
  }, { ...common, workspaceId: 'ws-a2' }), true);
  assert.equal(canUseContentInWorkspace({
    user_id: 'platform', workspace_id: null, organization_id: null, access_level: VISIBILITY.PLATFORM_TEMPLATE, template_assigned: 1,
  }, { ...common, workspaceId: 'ws-a1' }), true);
  assert.equal(canUseContentInWorkspace({
    user_id: 'owner-a', workspace_id: 'ws-a1', organization_id: 'org-a', access_level: VISIBILITY.ORGANIZATION_SHARED, archived_at: 123,
  }, { ...common, workspaceId: 'ws-a2' }), false);
});
