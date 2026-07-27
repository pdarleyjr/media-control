'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');

const {
  MIGRATION_ID,
  AUDIT_ACTION,
  applyPlatformRoleCorrection,
} = require('../db/migrations/platform-role-correction');

function createDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE users (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL,
      name TEXT NOT NULL DEFAULT '',
      role TEXT NOT NULL DEFAULT 'user'
    );
    CREATE TABLE schema_migrations (
      id TEXT PRIMARY KEY,
      ran_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
    );
    CREATE TABLE activity_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT,
      action TEXT NOT NULL,
      details TEXT,
      ip_address TEXT,
      created_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
    );
  `);
  return db;
}

function insertUser(db, id, role) {
  db.prepare('INSERT INTO users (id, email, name, role) VALUES (?, ?, ?, ?)')
    .run(id, `${id}@example.test`, `Person ${id}`, role);
}

test('corrective role migration converts every legacy platform/admin role and records aggregate counts', () => {
  const db = createDb();
  insertUser(db, 'canonical-platform', 'platform_admin');
  insertUser(db, 'legacy-platform-a', 'superadmin');
  insertUser(db, 'legacy-platform-b', 'superadmin');
  insertUser(db, 'legacy-admin', 'admin');
  insertUser(db, 'ordinary-member', 'user');

  const result = applyPlatformRoleCorrection(db);

  assert.equal(result.applied, true);
  assert.deepEqual(result.before, {
    superadmin: 2,
    platform_admin: 1,
    admin: 1,
    user: 1,
  });
  assert.deepEqual(result.after, {
    superadmin: 0,
    platform_admin: 3,
    admin: 0,
    user: 2,
  });
  assert.deepEqual(result.changed, {
    superadmin_to_platform_admin: 2,
    admin_to_user: 1,
    total: 3,
  });

  assert.deepEqual(
    db.prepare('SELECT id, role FROM users ORDER BY id').all(),
    [
      { id: 'canonical-platform', role: 'platform_admin' },
      { id: 'legacy-admin', role: 'user' },
      { id: 'legacy-platform-a', role: 'platform_admin' },
      { id: 'legacy-platform-b', role: 'platform_admin' },
      { id: 'ordinary-member', role: 'user' },
    ],
  );
  assert.ok(db.prepare('SELECT 1 FROM schema_migrations WHERE id = ?').get(MIGRATION_ID));

  const auditRow = db.prepare('SELECT user_id, action, details, ip_address FROM activity_log').get();
  assert.deepEqual(
    { user_id: auditRow.user_id, action: auditRow.action, ip_address: auditRow.ip_address },
    { user_id: null, action: AUDIT_ACTION, ip_address: null },
  );
  assert.deepEqual(JSON.parse(auditRow.details), {
    migration_id: MIGRATION_ID,
    before: result.before,
    after: result.after,
    changed: result.changed,
  });
  assert.doesNotMatch(auditRow.details, /@example\.test|Person |legacy-platform|ordinary-member/);
  db.close();
});

test('corrective role migration is safe on a fresh empty database and on repeat', () => {
  const db = createDb();

  const first = applyPlatformRoleCorrection(db);
  const second = applyPlatformRoleCorrection(db);

  assert.equal(first.applied, true);
  assert.deepEqual(first.changed, {
    superadmin_to_platform_admin: 0,
    admin_to_user: 0,
    total: 0,
  });
  assert.equal(second.applied, false);
  assert.equal(second.already_applied, true);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM schema_migrations WHERE id = ?').get(MIGRATION_ID).count, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM activity_log WHERE action = ?').get(AUDIT_ACTION).count, 1);
  db.close();
});

test('corrective role migration runs even when the earlier multitenancy migration is already stamped', () => {
  const db = createDb();
  db.prepare('INSERT INTO schema_migrations (id) VALUES (?)').run('phase5_multitenancy_backfill');
  insertUser(db, 'retained-legacy-platform', 'superadmin');

  const result = applyPlatformRoleCorrection(db);

  assert.equal(result.applied, true);
  assert.equal(db.prepare('SELECT role FROM users WHERE id = ?').get('retained-legacy-platform').role, 'platform_admin');
  assert.ok(db.prepare('SELECT 1 FROM schema_migrations WHERE id = ?').get(MIGRATION_ID));
  db.close();
});

test('role updates, aggregate audit, and migration stamp roll back together', () => {
  const db = createDb();
  insertUser(db, 'legacy-platform', 'superadmin');
  db.exec(`
    CREATE TRIGGER reject_role_migration_audit
    BEFORE INSERT ON activity_log
    WHEN NEW.action = '${AUDIT_ACTION}'
    BEGIN
      SELECT RAISE(ABORT, 'audit rejected');
    END;
  `);

  assert.throws(() => applyPlatformRoleCorrection(db), /audit rejected/);
  assert.equal(db.prepare('SELECT role FROM users WHERE id = ?').get('legacy-platform').role, 'superadmin');
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM schema_migrations WHERE id = ?').get(MIGRATION_ID).count, 0);
  db.close();
});
