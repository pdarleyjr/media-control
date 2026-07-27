'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');

const {
  canonicalGlobalRole,
  isPlatformAdminUser,
  requirePlatformAdmin,
} = require('../lib/permissions');
const {
  applyPlatformRoleCorrection,
} = require('../db/migrations/platform-role-correction');

function invoke(middleware, req) {
  const state = { next: false, status: null, body: null };
  const res = {
    status(code) {
      state.status = code;
      return this;
    },
    json(body) {
      state.body = body;
      return this;
    },
  };
  middleware(req, res, () => { state.next = true; });
  return state;
}

test('canonical platform admin is allowed, including while acting in a workspace', () => {
  const user = { id: 'platform', role: 'platform_admin', auth_provider: 'local' };
  assert.equal(isPlatformAdminUser(user), true);
  assert.deepEqual(invoke(requirePlatformAdmin, { user, actingAs: true }), {
    next: true,
    status: null,
    body: null,
  });
});

test('legacy superadmin remains authorized during the migration window', () => {
  const user = { id: 'legacy', role: 'superadmin', auth_provider: 'local' };
  assert.equal(isPlatformAdminUser(user), true);
  assert.equal(invoke(requirePlatformAdmin, { user, actingAs: false }).next, true);
});

test('a migrated superadmin is authorized through the canonical role', () => {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT NOT NULL, name TEXT NOT NULL DEFAULT '', role TEXT NOT NULL);
    CREATE TABLE schema_migrations (id TEXT PRIMARY KEY, ran_at INTEGER NOT NULL DEFAULT (strftime('%s','now')));
    CREATE TABLE activity_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT,
      action TEXT NOT NULL,
      details TEXT,
      ip_address TEXT,
      created_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
    );
    INSERT INTO users (id, email, name, role) VALUES ('legacy', 'legacy@example.test', 'Legacy', 'superadmin');
  `);
  applyPlatformRoleCorrection(db);
  const user = { ...db.prepare('SELECT id, role FROM users WHERE id = ?').get('legacy'), auth_provider: 'local' };
  assert.equal(user.role, 'platform_admin');
  assert.equal(invoke(requirePlatformAdmin, { user }).next, true);
  db.close();
});

test('workspace admins, organization admins, ordinary members, and acting-as org admins are denied', () => {
  const denied = [
    { user: { id: 'workspace', role: 'user', auth_provider: 'local' }, workspaceRole: 'workspace_admin' },
    { user: { id: 'org', role: 'user', auth_provider: 'local' }, orgRole: 'org_admin' },
    { user: { id: 'member', role: 'user', auth_provider: 'local' } },
    { user: { id: 'acting-org', role: 'user', auth_provider: 'local' }, orgRole: 'org_admin', actingAs: true },
  ];
  for (const req of denied) {
    const state = invoke(requirePlatformAdmin, req);
    assert.equal(state.next, false);
    assert.equal(state.status, 403);
  }
});

test('recovery tokens never authorize appliance-global camera administration', () => {
  const recoveryUser = {
    id: 'recovery',
    role: 'platform_admin',
    auth_provider: 'recovery',
  };
  assert.equal(isPlatformAdminUser(recoveryUser), false);
  const state = invoke(requirePlatformAdmin, { user: recoveryUser });
  assert.equal(state.next, false);
  assert.equal(state.status, 403);
});

test('global camera routes use the common platform middleware and predicate', () => {
  const route = fs.readFileSync(path.join(__dirname, '..', 'routes', 'live-stream.js'), 'utf8');
  assert.match(route, /requirePlatformAdmin/);
  assert.match(route, /isPlatformAdminUser/);
  assert.doesNotMatch(route, /function requireGlobalCameraAdmin/);
  assert.doesNotMatch(route, /req\.user\?*\.role !== 'platform_admin'/);
  assert.match(route, /get\('\/recordings', requirePlatformAdmin/);
  assert.match(route, /post\('\/recordings\/:id\/archive', requirePlatformAdmin/);
  assert.match(route, /post\('\/recordings\/:id\/restore', requirePlatformAdmin/);
  assert.match(route, /delete\('\/recordings\/:id', requirePlatformAdmin/);
  assert.match(route, /delete\('\/recordings\/:id\/peertube', requirePlatformAdmin/);
});

test('role-management writes and active admin UI use only canonical role names', () => {
  const repoRoot = path.join(__dirname, '..', '..');
  const authRoute = fs.readFileSync(path.join(__dirname, '..', 'routes', 'auth.js'), 'utf8');
  const adminUi = fs.readFileSync(path.join(repoRoot, 'frontend', 'js', 'views', 'admin.js'), 'utf8');
  const settingsUi = fs.readFileSync(path.join(repoRoot, 'frontend', 'js', 'views', 'settings.js'), 'utf8');
  const english = fs.readFileSync(path.join(repoRoot, 'frontend', 'js', 'i18n', 'en.js'), 'utf8');

  const roleUpdateStart = authRoute.indexOf("router.put('/users/:id/role'");
  const roleUpdateBlock = authRoute.slice(roleUpdateStart, roleUpdateStart + 700);
  assert.match(roleUpdateBlock, /\['user', 'platform_admin'\]/);
  assert.doesNotMatch(roleUpdateBlock, /\['user', 'admin', 'superadmin'\]/);
  assert.doesNotMatch(adminUi, /value="admin"|value="superadmin"/);
  assert.match(adminUi, /value="platform_admin"/);
  assert.doesNotMatch(settingsUi, /user\.role === 'admin'|isSuperAdmin/);
  assert.match(english, /'admin\.role\.platform_admin': 'Platform admin'/);
});

test('authoritative sync canonicalizes legacy roles instead of reintroducing them', () => {
  assert.equal(canonicalGlobalRole('platform_admin'), 'platform_admin');
  assert.equal(canonicalGlobalRole('superadmin'), 'platform_admin');
  assert.equal(canonicalGlobalRole('admin'), 'user');
  assert.equal(canonicalGlobalRole('user'), 'user');
  assert.equal(canonicalGlobalRole('unknown'), 'user');
  assert.equal(canonicalGlobalRole(null), 'user');

  const syncRoute = fs.readFileSync(path.join(__dirname, '..', 'routes', 'admin-sync.js'), 'utf8');
  assert.match(syncRoute, /canonicalGlobalRole\(role\)/);
  assert.doesNotMatch(syncRoute, /ALLOWED_SYNC_ROLES/);
});
