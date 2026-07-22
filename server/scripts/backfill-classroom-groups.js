#!/usr/bin/env node
/**
 * Retired Classroom 1 group-membership backfill.
 *
 * The original one-shot copied physical wall members into three independent
 * device groups. That violates the enterprise topology invariant that a
 * display belongs to a wall OR one independent group, never both. Existing
 * databases are repaired by repair-display-topology.js with an explicit plan.
 * New and not-yet-stamped databases only receive the retirement marker here;
 * this script must never create groups or memberships again.
 */

const MIGRATION_ID = 'classroom1_group_members';

function runBackfill(opts = {}) {
  const db = opts.db;
  if (!db) return { skipped: true, reason: 'no_db' };
  try {
    const already = db.prepare('SELECT 1 FROM schema_migrations WHERE id = ?').get(MIGRATION_ID);
    if (already) return { skipped: true, reason: 'already_run' };
    db.prepare('INSERT OR IGNORE INTO schema_migrations (id) VALUES (?)').run(MIGRATION_ID);
    return {
      skipped: false,
      reason: 'retired_mutually_exclusive_topology',
      report: { primary: 0, secondary: 0, all: 0 },
    };
  } catch (error) {
    console.warn(`[classroom1_group_members] retirement stamp failed: ${error.message}`);
    return { skipped: true, reason: 'error', error: error.message };
  }
}

module.exports = { runBackfill, MIGRATION_ID };

if (require.main === module) {
  const { db } = require('../db/database');
  const result = runBackfill({ db });
  console.log('[classroom1_group_members] retirement result:', JSON.stringify(result));
}
