const { test } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');

const { MIGRATION_ID, runBackfill } = require('../scripts/backfill-classroom-groups');

test('legacy classroom group backfill is retired and cannot put wall members into independent groups', () => {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE schema_migrations (id TEXT PRIMARY KEY);
    CREATE TABLE device_group_members (device_id TEXT, group_id TEXT);
  `);

  const result = runBackfill({ db });

  assert.equal(result.skipped, false);
  assert.equal(result.reason, 'retired_mutually_exclusive_topology');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM device_group_members').get().n, 0);
  assert.ok(db.prepare('SELECT 1 FROM schema_migrations WHERE id = ?').get(MIGRATION_ID));
});
