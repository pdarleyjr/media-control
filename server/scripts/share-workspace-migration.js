#!/usr/bin/env node
/**
 * share-workspace-migration.js
 *
 * ONE-SHOT deploy-time script — do NOT run on boot, do NOT call from tests.
 *
 * Adds every existing user as a member of the MBFD shared workspace so that
 * all staff can see and broadcast to the 3 shared displays without each member
 * needing a manual invite. This implements the "shared displays / per-user
 * files" tenancy model: devices/walls/layouts/scenes stay workspace-shared,
 * while content/presentations/playlists remain private per user.
 *
 * Role mapping:
 *   users.role = 'platform_admin'  ->  workspace_admin
 *   all others                     ->  workspace_editor
 *
 * joined_at is set to 1 (epoch second 1970-01-01T00:00:00Z) so the shared
 * workspace sorts FIRST in the workspace_members order-by-joined_at query
 * inside firstAccessibleWorkspace() (tenancy.js:47). This means it becomes
 * every member's default workspace at login, regardless of any other workspace
 * they may already belong to.
 *
 * INSERT OR IGNORE is used throughout so re-running the script is safe — it
 * will not overwrite an existing membership row (e.g. an admin who was already
 * added with a specific role keeps that role untouched).
 *
 * ─── How to run (after deploying a new image to the GMKtec box) ────────────
 *
 *   docker exec media-control node /app/server/scripts/share-workspace-migration.js
 *
 * ─── Rollback ──────────────────────────────────────────────────────────────
 *
 * The script writes a VACUUM INTO backup before making any changes. Path:
 *   /app/data/db/remote_display.pre-share-migration-<timestamp>.db
 *
 * To restore:
 *   docker exec media-control sh -c "cp \
 *     /app/data/db/remote_display.pre-share-migration-<ts>.db \
 *     /app/data/db/remote_display.db"
 *   docker restart media-control
 *
 * ─── Verification (run after the script) ──────────────────────────────────
 *
 * Mint a token for a non-admin staff user and confirm /api/devices returns
 * the 3 shared displays:
 *
 *   docker exec media-control node -e "
 *     const jwt = require('./node_modules/jsonwebtoken');
 *     const cfg = require('./config');
 *     const { db } = require('./db/database');
 *     const u = db.prepare(\"SELECT * FROM users WHERE role != 'platform_admin' LIMIT 1\").get();
 *     if (!u) { console.log('no non-admin user found'); process.exit(1); }
 *     const tok = jwt.sign({ id: u.id, email: u.email, role: u.role }, cfg.jwtSecret, { expiresIn: '5m' });
 *     console.log('User:', u.email);
 *     console.log('Token:', tok);
 *   "
 *
 *   curl -s -H 'Authorization: Bearer <token>' http://localhost:3001/api/devices | node -e \
 *     'let d=\"\"; process.stdin.on(\"data\",c=>d+=c).on(\"end\",()=>{ const r=JSON.parse(d); console.log(\"Device count:\", (r.devices||r).length); })'
 */

'use strict';

const path = require('path');
const fs   = require('fs');

// ── Config + DB ─────────────────────────────────────────────────────────────
// Resolve paths relative to this script's location (server/scripts/) so the
// script works both from repo root and from /app/server/scripts/ in Docker.
const config = require(path.join(__dirname, '..', 'config'));

// Override DB_PATH with the container's canonical volume path when running
// inside the container (the env var set in docker-compose wins; the config
// default resolves to /app/server/db/remote_display.db which is INSIDE the
// image, not the volume — so the env var must be set).
// If running locally against the dev DB, the config default is used.
const CONTAINER_DB_PATH = '/app/data/db/remote_display.db';
const dbPath = process.env.DB_PATH || (fs.existsSync(CONTAINER_DB_PATH) ? CONTAINER_DB_PATH : config.dbPath);

const Database = require(path.join(__dirname, '..', 'node_modules', 'better-sqlite3'));

const SHARED_WORKSPACE_ID = 'dd3e4549-7c7b-441e-b515-ef39a5096402';

// ── Sanity checks ────────────────────────────────────────────────────────────
if (!fs.existsSync(dbPath)) {
  console.error(`[share-workspace-migration] DB not found: ${dbPath}`);
  console.error('Set DB_PATH env var to the correct database path.');
  process.exit(1);
}

// ── Backup via VACUUM INTO ───────────────────────────────────────────────────
const ts = new Date().toISOString().replace(/[:.]/g, '-');
const backupPath = path.join(path.dirname(dbPath), `remote_display.pre-share-migration-${ts}.db`);

console.log(`[share-workspace-migration] Source DB : ${dbPath}`);
console.log(`[share-workspace-migration] Backup path: ${backupPath}`);

const db = new Database(dbPath);
db.pragma('journal_mode = WAL');

try {
  db.exec(`VACUUM INTO '${backupPath.replace(/'/g, "''")}'`);
  console.log(`[share-workspace-migration] Backup written: ${backupPath}`);
} catch (e) {
  console.error(`[share-workspace-migration] VACUUM INTO failed: ${e.message}`);
  console.error('Aborting — no changes made.');
  db.close();
  process.exit(1);
}

// ── Pre-flight checks ────────────────────────────────────────────────────────
// Confirm the shared workspace exists before touching membership rows.
const workspace = db.prepare('SELECT id, name FROM workspaces WHERE id = ?').get(SHARED_WORKSPACE_ID);
if (!workspace) {
  console.error(`[share-workspace-migration] Shared workspace ${SHARED_WORKSPACE_ID} not found in DB.`);
  console.error('Has the multi-tenancy migration been run? (migrate-multitenancy.js)');
  db.close();
  process.exit(1);
}
console.log(`[share-workspace-migration] Target workspace: "${workspace.name}" (${workspace.id})`);

// Confirm workspace_members table exists.
const hasTable = db.prepare(
  "SELECT 1 FROM sqlite_master WHERE type='table' AND name='workspace_members'"
).get();
if (!hasTable) {
  console.error('[share-workspace-migration] workspace_members table missing. Run migrate-multitenancy.js first.');
  db.close();
  process.exit(1);
}

// ── Before count ─────────────────────────────────────────────────────────────
const beforeCount = db.prepare(
  'SELECT COUNT(*) AS n FROM workspace_members WHERE workspace_id = ?'
).get(SHARED_WORKSPACE_ID).n;

const totalUsers = db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
console.log(`[share-workspace-migration] Before: ${beforeCount} member(s) in shared workspace (${totalUsers} total users)`);

// ── Insert memberships ────────────────────────────────────────────────────────
// Use INSERT OR IGNORE so existing rows are left untouched (idempotent).
// joined_at = 1 sorts earlier than any real timestamp, making this workspace
// the firstAccessibleWorkspace for every user at login.
const insertAdmin = db.prepare(`
  INSERT OR IGNORE INTO workspace_members (workspace_id, user_id, role, joined_at)
  VALUES (?, ?, 'workspace_admin', 1)
`);

const insertEditor = db.prepare(`
  INSERT OR IGNORE INTO workspace_members (workspace_id, user_id, role, joined_at)
  VALUES (?, ?, 'workspace_editor', 1)
`);

const users = db.prepare('SELECT id, email, role FROM users').all();

const migrate = db.transaction(() => {
  let admins = 0;
  let editors = 0;
  for (const user of users) {
    if (user.role === 'platform_admin') {
      insertAdmin.run(SHARED_WORKSPACE_ID, user.id);
      admins++;
    } else {
      insertEditor.run(SHARED_WORKSPACE_ID, user.id);
      editors++;
    }
  }
  return { admins, editors };
});

let result;
try {
  result = migrate();
} catch (e) {
  console.error(`[share-workspace-migration] Transaction failed: ${e.message}`);
  console.error(`Restore from backup: cp ${backupPath} ${dbPath}`);
  db.close();
  process.exit(1);
}

// ── After count ───────────────────────────────────────────────────────────────
const afterCount = db.prepare(
  'SELECT COUNT(*) AS n FROM workspace_members WHERE workspace_id = ?'
).get(SHARED_WORKSPACE_ID).n;

const newRows = afterCount - beforeCount;

console.log(`[share-workspace-migration] Processed ${users.length} user(s): ${result.admins} platform_admin -> workspace_admin, ${result.editors} others -> workspace_editor`);
console.log(`[share-workspace-migration] After : ${afterCount} member(s) in shared workspace (${newRows} new row(s) inserted; ${users.length - newRows} already existed / skipped)`);
console.log('[share-workspace-migration] Done.');

db.close();
