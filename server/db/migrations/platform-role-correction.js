'use strict';

// Correct databases where the original multitenancy migration was stamped but
// one or more legacy roles survived. This migration intentionally has its own
// ID so an already-applied phase5_multitenancy_backfill never suppresses it.

const MIGRATION_ID = 'phase5b_platform_role_correction';
const AUDIT_ACTION = 'migration:platform_role_correction';

function roleCounts(db) {
  const rows = db.prepare(`
    SELECT role, COUNT(*) AS count
    FROM users
    WHERE role IN ('superadmin', 'platform_admin', 'admin', 'user')
    GROUP BY role
  `).all();
  const counts = {
    superadmin: 0,
    platform_admin: 0,
    admin: 0,
    user: 0,
  };
  for (const row of rows) counts[row.role] = Number(row.count || 0);
  return counts;
}

function applyPlatformRoleCorrection(db) {
  if (!db || typeof db.prepare !== 'function' || typeof db.transaction !== 'function') {
    throw new TypeError('A better-sqlite3 database is required');
  }

  return db.transaction(() => {
    const alreadyApplied = db.prepare(
      'SELECT 1 FROM schema_migrations WHERE id = ?',
    ).get(MIGRATION_ID);
    if (alreadyApplied) {
      return {
        applied: false,
        already_applied: true,
        migration_id: MIGRATION_ID,
      };
    }

    const before = roleCounts(db);
    const superadminUpdate = db.prepare(
      "UPDATE users SET role = 'platform_admin' WHERE role = 'superadmin'",
    ).run();
    // The documented Phase 1 authorization model removed the intermediate
    // legacy admin role. Legacy admins retain ordinary user access; scoped
    // administration is represented by organization/workspace membership.
    const adminUpdate = db.prepare(
      "UPDATE users SET role = 'user' WHERE role = 'admin'",
    ).run();
    const after = roleCounts(db);
    const changed = {
      superadmin_to_platform_admin: Number(superadminUpdate.changes || 0),
      admin_to_user: Number(adminUpdate.changes || 0),
      total: Number(superadminUpdate.changes || 0) + Number(adminUpdate.changes || 0),
    };

    const details = JSON.stringify({
      migration_id: MIGRATION_ID,
      before,
      after,
      changed,
    });
    db.prepare(`
      INSERT INTO activity_log (user_id, action, details, ip_address)
      VALUES (NULL, ?, ?, NULL)
    `).run(AUDIT_ACTION, details);
    db.prepare('INSERT INTO schema_migrations (id) VALUES (?)').run(MIGRATION_ID);

    return {
      applied: true,
      migration_id: MIGRATION_ID,
      before,
      after,
      changed,
    };
  })();
}

module.exports = {
  MIGRATION_ID,
  AUDIT_ACTION,
  roleCounts,
  applyPlatformRoleCorrection,
};
