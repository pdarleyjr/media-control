#!/usr/bin/env node
/**
 * Screensavers content folder seed (Phase 6 add).
 *
 * Ensures every workspace that has at least one member owns a content_folders
 * row named "Screensavers" so the Stage screensaver dropdown can open the media
 * drawer filtered to it. This is ADDITIVE — it never modifies schema.sql and
 * never clobbers an existing folder (it skips workspaces that already have a
 * "Screensavers" row). The insert itself is INSERT OR IGNORE on the folder PK.
 *
 * Idempotent + exactly-once: gated on schema_migrations row
 * 'screensaver_folder_seed'. Re-running the boot is a no-op even if that row is
 * somehow cleared, because each workspace's existence check + INSERT OR IGNORE
 * make the per-workspace writes idempotent too.
 *
 * IMPORTANT: this module must NOT require('../db/database') at module top — it
 * is required BY database.js during the latter's module evaluation, so a
 * top-level require would create a circular dependency and yield an undefined
 * `db` export. The caller passes the live `db` handle into runSeed({ db }) /
 * seedScreensaverFolder(db, workspaceId).
 *
 * Columns (from database.js CREATE TABLE content_folders + ALTER ADD
 * workspace_id): id, user_id, parent_id, name, created_at, workspace_id.
 */

const MIGRATION_ID = 'screensaver_folder_seed';
const FOLDER_NAME = 'Screensavers';

/**
 * Seed a "Screensavers" folder for a single workspace. Safe to call directly.
 * @param {import('better-sqlite3').Database} db
 * @param {string} workspaceId
 * @returns {{ skipped: boolean, reason?: string, id?: string }}
 */
function seedScreensaverFolder(db, workspaceId) {
  if (!db || !workspaceId) return { skipped: true, reason: 'no_args' };
  try {
    // Already exists for this workspace → leave any user-curated folder alone.
    const existing = db.prepare(
      "SELECT id FROM content_folders WHERE workspace_id = ? AND name = ? LIMIT 1"
    ).get(workspaceId, FOLDER_NAME);
    if (existing && existing.id) return { skipped: true, reason: 'exists', id: existing.id };

    // content_folders.user_id is NOT NULL; own the folder by the workspace's
    // first-joined member, falling back to the workspace's creator.
    const owner = db.prepare(
      `SELECT wm.user_id AS user_id
         FROM workspace_members wm
        WHERE wm.workspace_id = ?
        ORDER BY wm.joined_at ASC
        LIMIT 1`
    ).get(workspaceId);
    const userId = (owner && owner.user_id)
      || (db.prepare('SELECT created_by AS user_id FROM workspaces WHERE id = ?').get(workspaceId) || {}).user_id;
    if (!userId) return { skipped: true, reason: 'no_owner' };

    const { v4: uuidv4 } = require('uuid');
    const id = uuidv4();
    db.prepare(
      `INSERT OR IGNORE INTO content_folders (id, user_id, workspace_id, parent_id, name)
       VALUES (?, ?, ?, NULL, ?)`
    ).run(id, userId, workspaceId, FOLDER_NAME);
    return { skipped: false, id };
  } catch (e) {
    console.warn(`[screensaver_folder_seed] workspace ${workspaceId} failed: ${e.message}`);
    return { skipped: true, reason: 'error', error: e.message };
  }
}

/**
 * Boot-time entry point: iterate every workspace, seeding folders for those that
 * have none. Records the migration id so subsequent boots skip the loop entirely.
 * Mirrors scripts/backfill-classroom-groups.js runBackfill().
 * @param {{ db: import('better-sqlite3').Database }} opts
 * @returns {{ skipped: boolean, reason?: string, created?: number, workspaces?: number }}
 */
function runSeed(opts = {}) {
  const db = opts.db;
  if (!db) return { skipped: true, reason: 'no_db' };
  try {
    const already = db.prepare('SELECT 1 FROM schema_migrations WHERE id = ?').get(MIGRATION_ID);
    if (already) return { skipped: true, reason: 'already_run' };

    const workspaces = db.prepare('SELECT id FROM workspaces').all();
    let created = 0;
    for (const ws of workspaces) {
      const r = seedScreensaverFolder(db, ws.id);
      if (!r.skipped) created++;
    }

    db.prepare('INSERT OR IGNORE INTO schema_migrations (id) VALUES (?)').run(MIGRATION_ID);
    return { skipped: false, created, workspaces: workspaces.length };
  } catch (e) {
    console.warn(`[screensaver_folder_seed] seed failed: ${e.message}`);
    return { skipped: true, reason: 'error', error: e.message };
  }
}

module.exports = { seedScreensaverFolder, runSeed, MIGRATION_ID };

if (require.main === module) {
  const { db } = require('../db/database');
  const result = runSeed({ db });
  console.log('[screensaver_folder_seed] seed result:', JSON.stringify(result));
}