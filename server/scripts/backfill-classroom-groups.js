#!/usr/bin/env node
/**
 * Classroom 1 device-group membership backfill (Phase 2 add).
 *
 * Three fixed Classroom-1 groups get their member sets seeded from the
 * appliance's physical topology. This is idempotent (INSERT OR IGNORE) and
 * only runs when device_group_members is EMPTY for each group (a user who
 * already curated their own membership isn't clobbered). Gated on
 * schema_migrations so it runs exactly once per database.
 *
 *   1. group 'b9d54751-8927-477c-bca2-38e68779babd'  ("Classroom 1 All Displays")
 *      members = all five classroom device ids (union of the two walls below)
 *   2. the "Classroom 1 Primary Wall Group" group
 *      members = Primary Wall (0ccb1444-8e1f-4f4d-9329-b677707eb72a) tile ids
 *   3. the "Classroom 1 Secondary Wall Group" group
 *      members = Secondary Wall (6c16c244-4e00-4f29-b1a8-65850951659f) tile ids
 *
 * The two wall groups don't have pre-assigned ids in the spec; we resolve them
 * by name (creating a group row if it doesn't exist yet). The "All Displays"
 * group id IS fixed by spec.
 *
 * IMPORTANT: this module must NOT require('../db/database') at module top — it
 * is itself required BY database.js during the latter's module evaluation, so a
 * top-level require would create a circular dependency and yield an
 * undefined `db` export. The caller passes the live `db` handle into
 * runBackfill({ db }).
 */

const PRIMARY_WALL_ID = '0ccb1444-8e1f-4f4d-9329-b677707eb72a';
const SECONDARY_WALL_ID = '6c16c244-4e00-4f29-b1a8-65850951659f';
const ALL_DISPLAYS_GROUP_ID = 'b9d54751-8927-477c-bca2-38e68779babd';
const MIGRATION_ID = 'classroom1_group_members';

function resolveWallGroupId(db, wallId, suggestedName) {
  let group = db.prepare('SELECT id FROM device_groups WHERE name = ?').get(suggestedName);
  if (group) return group.id;
  // Create the group if missing. Owner = first user of the wall's workspace.
  const wall = db.prepare('SELECT id, workspace_id, name FROM video_walls WHERE id = ?').get(wallId);
  if (!wall) return null;
  const ownerRow = db.prepare(`
    SELECT u.id FROM workspaces w
    JOIN workspace_members wm ON wm.workspace_id = w.id
    JOIN users u ON u.id = wm.user_id
    WHERE w.id = ?
    ORDER BY wm.joined_at ASC LIMIT 1
  `).get(wall.workspace_id);
  if (!ownerRow) return null;
  const { v4: uuidv4 } = require('uuid');
  const groupId = uuidv4();
  db.prepare(`
    INSERT INTO device_groups (id, user_id, name, color)
    VALUES (?, ?, ?, '#3B82F6')
  `).run(groupId, ownerRow.id, suggestedName);
  return groupId;
}

function wallMemberDeviceIds(db, wallId) {
  const rows = db.prepare('SELECT device_id FROM video_wall_devices WHERE wall_id = ?').all(wallId);
  return rows.map((r) => r.device_id);
}

function classroom1AllDisplayIds(db) {
  // The Classroom-1 room has two walls covering all five panels. Union their
  // tile device_ids. If the walls aren't populated yet, fall back to the
  // Classroom-1 naming convention on devices.name / location_label (capped at 5).
  const primary = wallMemberDeviceIds(db, PRIMARY_WALL_ID);
  const secondary = wallMemberDeviceIds(db, SECONDARY_WALL_ID);
  const union = Array.from(new Set([...primary, ...secondary]));
  if (union.length > 0) return union;
  const rows = db.prepare(`
    SELECT id FROM devices
    WHERE name LIKE 'Classroom 1%' OR location_label LIKE 'Classroom 1%'
  `).all();
  return rows.map((r) => r.id).slice(0, 5);
}

function applyMembers(db, groupId, deviceIds) {
  if (!groupId) return 0;
  const stmt = db.prepare('INSERT OR IGNORE INTO device_group_members (device_id, group_id) VALUES (?, ?)');
  let added = 0;
  for (const deviceId of deviceIds) {
    if (!deviceId) continue;
    if (stmt.run(deviceId, groupId).changes > 0) added++;
  }
  return added;
}

function isEmpty(db, groupId) {
  const row = db.prepare('SELECT COUNT(*) AS n FROM device_group_members WHERE group_id = ?').get(groupId);
  return !row || row.n === 0;
}

function runBackfill(opts = {}) {
  const db = opts.db;
  if (!db) return { skipped: true, reason: 'no_db' };
  try {
    const already = db.prepare('SELECT 1 FROM schema_migrations WHERE id = ?').get(MIGRATION_ID);
    if (already) return { skipped: true, reason: 'already_run' };

    const report = { primary: 0, secondary: 0, all: 0 };

    if (isEmpty(db, ALL_DISPLAYS_GROUP_ID)) {
      report.all = applyMembers(db, ALL_DISPLAYS_GROUP_ID, classroom1AllDisplayIds(db));
    }

    const primaryWallGroupId = resolveWallGroupId(db, PRIMARY_WALL_ID, 'Classroom 1 Primary Wall Group');
    if (primaryWallGroupId && isEmpty(db, primaryWallGroupId)) {
      report.primary = applyMembers(db, primaryWallGroupId, wallMemberDeviceIds(db, PRIMARY_WALL_ID));
    }

    const secondaryWallGroupId = resolveWallGroupId(db, SECONDARY_WALL_ID, 'Classroom 1 Secondary Wall Group');
    if (secondaryWallGroupId && isEmpty(db, secondaryWallGroupId)) {
      report.secondary = applyMembers(db, secondaryWallGroupId, wallMemberDeviceIds(db, SECONDARY_WALL_ID));
    }

    db.prepare('INSERT OR IGNORE INTO schema_migrations (id) VALUES (?)').run(MIGRATION_ID);
    return { skipped: false, reason: 'ok', report };
  } catch (e) {
    console.warn(`[classroom1_group_members] backfill failed: ${e.message}`);
    return { skipped: true, reason: 'error', error: e.message };
  }
}

module.exports = { runBackfill, MIGRATION_ID };

if (require.main === module) {
  const { db } = require('../db/database');
  const result = runBackfill({ db });
  console.log('[classroom1_group_members] backfill result:', JSON.stringify(result));
}