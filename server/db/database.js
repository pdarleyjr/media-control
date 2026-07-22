const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');
const config = require('../config');

const dbDir = path.dirname(config.dbPath);
if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });

const db = new Database(config.dbPath, { timeout: 10000 });

// Enable WAL mode and foreign keys
db.pragma('busy_timeout = 10000');
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');
db.pragma('foreign_keys = ON');

// Run schema
const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
db.exec(schema);

// Self-heal the persisted authoritative-room revision ledger on every boot.
// This stays additive and idempotent so databases created by older images gain
// the resume cursor before Socket.IO begins accepting dashboard connections.
const { ensureRoomRevisionSchema } = require('../lib/room-snapshot');
ensureRoomRevisionSchema(db);

// Auto-apply Phase 1 multi-tenancy migration if not yet applied. Without this
// a self-hoster who pulls latest and restarts hits a crash in
// migrateFolderWorkspaceIds (queries workspaces table that doesn't exist).
// Pre-existing data is snapshotted to db/remote_display.pre-migration-<ts>.db
// before the migration runs - clear restore path on failure. Fresh installs
// run against empty data (creates tables, no rows to backfill).
function ensureMultitenancyMigration() {
  let applied = false;
  try {
    applied = !!db.prepare(
      "SELECT 1 FROM schema_migrations WHERE id = 'phase5_multitenancy_backfill'"
    ).get();
  } catch { /* schema_migrations may not exist yet; treat as not applied */ }
  if (applied) return;

  console.warn('[boot] Multi-tenancy schema not present - applying migration...');
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const snapshotPath = path.join(dbDir, `remote_display.pre-migration-${ts}.db`);
  try {
    db.pragma('wal_checkpoint(TRUNCATE)');
    fs.copyFileSync(config.dbPath, snapshotPath);
    console.warn(`[boot] Pre-migration snapshot: ${snapshotPath}`);
  } catch (e) {
    console.error(`[boot] Snapshot failed: ${e.message}`);
    process.exit(1);
  }

  try {
    const { runMigration } = require('../../scripts/migrate-multitenancy');
    runMigration({ db });
    console.warn('[boot] Migration complete, continuing startup');
  } catch (e) {
    console.error(`[boot] Migration FAILED: ${e.message}`);
    console.error(`[boot] Restore with: cp ${snapshotPath} ${config.dbPath}`);
    process.exit(1);
  }
}

// Note: ensureMultitenancyMigration() is called LATER, after the inline
// migrations array has added team_id and workspace_id columns. The Phase 1
// migration script reads team_id from resource tables during its backfill
// loop, so those columns must exist first. Definition kept here near the
// top so the auto-migration logic is easy to find when reading the file.

// Migrations for existing databases
const migrations = [
  // Optional username login. Email remains required in storage for backwards
  // compatibility, while the partial index permits legacy users with no username.
  'ALTER TABLE users ADD COLUMN username TEXT',
  "CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username_nocase ON users(username COLLATE NOCASE) WHERE username IS NOT NULL AND trim(username) <> ''",
  'ALTER TABLE content ADD COLUMN remote_url TEXT',
  'ALTER TABLE devices ADD COLUMN user_id TEXT REFERENCES users(id)',
  'ALTER TABLE content ADD COLUMN user_id TEXT REFERENCES users(id)',
  "ALTER TABLE users ADD COLUMN plan_id TEXT DEFAULT 'free'",
  'ALTER TABLE users ADD COLUMN stripe_customer_id TEXT',
  'ALTER TABLE users ADD COLUMN stripe_subscription_id TEXT',
  "ALTER TABLE users ADD COLUMN subscription_status TEXT DEFAULT 'active'",
  'ALTER TABLE users ADD COLUMN subscription_ends INTEGER',
  // Layout & zone support on devices and assignments
  'ALTER TABLE devices ADD COLUMN layout_id TEXT',
  'ALTER TABLE devices ADD COLUMN timezone TEXT DEFAULT \'UTC\'',
  'ALTER TABLE devices ADD COLUMN wall_id TEXT',
  'ALTER TABLE devices ADD COLUMN team_id TEXT',
  'ALTER TABLE assignments ADD COLUMN zone_id TEXT',
  'ALTER TABLE assignments ADD COLUMN widget_id TEXT',
  // Team support on content
  'ALTER TABLE content ADD COLUMN team_id TEXT',
  // Device notes
  'ALTER TABLE devices ADD COLUMN notes TEXT',
  // Email settings on users
  "ALTER TABLE users ADD COLUMN email_alerts INTEGER DEFAULT 1",
  // Content folders
  'ALTER TABLE content ADD COLUMN folder TEXT',
  // Device orientation and default content
  "ALTER TABLE devices ADD COLUMN orientation TEXT DEFAULT 'landscape'",
  'ALTER TABLE devices ADD COLUMN default_content_id TEXT',
  // Audio control per assignment
  "ALTER TABLE assignments ADD COLUMN muted INTEGER DEFAULT 0",
  // Trial tracking
  "ALTER TABLE users ADD COLUMN trial_started INTEGER",
  "ALTER TABLE users ADD COLUMN trial_plan TEXT DEFAULT 'pro'",
  // Stripe price IDs on plans
  "ALTER TABLE plans ADD COLUMN stripe_price_monthly TEXT",
  "ALTER TABLE plans ADD COLUMN stripe_price_yearly TEXT",
  // Last login tracking
  "ALTER TABLE users ADD COLUMN last_login INTEGER",
  // Phase 2: every device gets a playlist, schedules can override with a playlist
  "ALTER TABLE devices ADD COLUMN playlist_id TEXT REFERENCES playlists(id) ON DELETE SET NULL",
  "ALTER TABLE schedules ADD COLUMN playlist_id TEXT REFERENCES playlists(id) ON DELETE SET NULL",
  "ALTER TABLE playlists ADD COLUMN is_auto_generated INTEGER NOT NULL DEFAULT 0",
  // Device authentication token
  "ALTER TABLE devices ADD COLUMN device_token TEXT",
  // Phase 3: playlist publish/draft state
  "ALTER TABLE playlists ADD COLUMN status TEXT NOT NULL DEFAULT 'draft'",
  "ALTER TABLE playlists ADD COLUMN published_snapshot TEXT",
  // Phase 4: group scheduling (column add only — full migration with CHECK below)
  "ALTER TABLE schedules ADD COLUMN group_id TEXT REFERENCES device_groups(id) ON DELETE SET NULL",
  // Hierarchical content folders (per-user)
  `CREATE TABLE IF NOT EXISTS content_folders (
    id          TEXT PRIMARY KEY,
    user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    parent_id   TEXT REFERENCES content_folders(id) ON DELETE CASCADE,
    name        TEXT NOT NULL,
    created_at  INTEGER NOT NULL DEFAULT (strftime('%s','now'))
  )`,
  "CREATE INDEX IF NOT EXISTS idx_content_folders_user ON content_folders(user_id, parent_id)",
  "ALTER TABLE content ADD COLUMN folder_id TEXT REFERENCES content_folders(id) ON DELETE SET NULL",
  "CREATE INDEX IF NOT EXISTS idx_content_folder ON content(folder_id)",
  // Group-level playlist: when set, devices added to the group inherit it.
  "ALTER TABLE device_groups ADD COLUMN playlist_id TEXT REFERENCES playlists(id) ON DELETE SET NULL",
  // Wall-level playlist: video walls now play a playlist (not just one content).
  "ALTER TABLE video_walls ADD COLUMN playlist_id TEXT REFERENCES playlists(id) ON DELETE SET NULL",
  // Free-form canvas layout: walls store a player rect; member devices store
  // their own rect. Coordinates are in arbitrary canvas units (effectively px).
  "ALTER TABLE video_walls ADD COLUMN player_x REAL",
  "ALTER TABLE video_walls ADD COLUMN player_y REAL",
  "ALTER TABLE video_walls ADD COLUMN player_width REAL",
  "ALTER TABLE video_walls ADD COLUMN player_height REAL",
  "ALTER TABLE video_wall_devices ADD COLUMN canvas_x REAL",
  "ALTER TABLE video_wall_devices ADD COLUMN canvas_y REAL",
  "ALTER TABLE video_wall_devices ADD COLUMN canvas_width REAL",
  "ALTER TABLE video_wall_devices ADD COLUMN canvas_height REAL",
  // Phase 2.2c: content_folders gets workspace_id. Phase 1 missed this table.
  "ALTER TABLE content_folders ADD COLUMN workspace_id TEXT REFERENCES workspaces(id)",
  "CREATE INDEX IF NOT EXISTS idx_content_folders_workspace ON content_folders(workspace_id)",
  // Phase 2 zone_id regression fix: playlist_items needs zone_id so the
  // multi-zone-layout assignment feature works. The Phase 2 assignments->
  // playlist_items conversion (migrateAssignmentsToPlaylists) dropped this
  // column. Column ADD is idempotent via the surrounding try/catch loop.
  "ALTER TABLE playlist_items ADD COLUMN zone_id TEXT REFERENCES layout_zones(id) ON DELETE SET NULL",
  // 2026-05-28: per-item fit_mode override. Null = inherit zone's fit_mode (or
  // 'contain' in solo / 'fill' in wall mode). Explicit value overrides per item
  // so an instructor can mark "this MP4 should fill the screen edge-to-edge"
  // without having to redesign the layout. Mirrored on assignments for the
  // legacy assignment-based device flow.
  "ALTER TABLE playlist_items ADD COLUMN fit_mode TEXT",
  "ALTER TABLE assignments ADD COLUMN fit_mode TEXT",
  // 2026-05-28: admin override for display geometry. Auto-detect underreports
  // for video-wall mosaics (Fire TV reports the OS surface res, not the panel).
  // refresh_rate_hz is informational/UI; auto_detect_resolution controls whether
  // device:register may overwrite screen_width/height. Default=1 preserves
  // existing behaviour; admins can flip to 0 and write canonical values via the
  // wall editor.
  "ALTER TABLE devices ADD COLUMN refresh_rate_hz INTEGER",
  "ALTER TABLE devices ADD COLUMN auto_detect_resolution INTEGER NOT NULL DEFAULT 1",
  // 2026-05-28: video_walls gets a refresh_rate_hz hint. Canvas dimensions are
  // already supported via player_width/player_height; this completes the spec
  // for "12372x2160 @ 59.94 Hz" wall config that admins can dictate manually.
  "ALTER TABLE video_walls ADD COLUMN refresh_rate_hz REAL",
  // Wall lock flag: keep a classroom wall's member set fixed while preserving
  // its span/split playback and layout editing controls.
  "ALTER TABLE video_walls ADD COLUMN is_locked INTEGER NOT NULL DEFAULT 0",
  // 2026-05-28: stable slot identifiers on layout_zones so playlist_items.zone_id
  // can survive a layout duplicate / template-apply. Existing zones get NULL;
  // new layouts (and the editor's "Save" path) should populate slot_key with a
  // human-readable identifier ('main','side','ticker',etc.). buildPlaylistPayload
  // resolves zone_id by both id-match AND slot_key fallback.
  "ALTER TABLE layout_zones ADD COLUMN slot_key TEXT",
  // 2026-05-28: per-content default fit mode. New playlist_items default to
  // the content's default_fit_mode; playlist_items.fit_mode (the existing
  // column) remains an override. Resolution order in payload builder:
  //   playlist_items.fit_mode (override) > content.default_fit_mode > null (player default).
  "ALTER TABLE content ADD COLUMN default_fit_mode TEXT",
  // 2026-05-30 MBFD Media Control Studio: content becomes a first-class
  // content_item (presentation/video/image/webpage/...); metadata/tags/access.
  "ALTER TABLE content ADD COLUMN content_type TEXT",
  "ALTER TABLE content ADD COLUMN metadata_json TEXT",
  "ALTER TABLE content ADD COLUMN tags_json TEXT",
  "ALTER TABLE content ADD COLUMN access_level TEXT DEFAULT 'private'",
  // Audit-log extension (reuse activity_log instead of a new table): capture
  // resource type + before/after state for the Audit Log view.
  "ALTER TABLE activity_log ADD COLUMN resource_type TEXT",
  "ALTER TABLE activity_log ADD COLUMN before_state TEXT",
  "ALTER TABLE activity_log ADD COLUMN after_state TEXT",
  // 2026-06-01 Unified Media Control dashboard: authoritative blank/on state
  // per display (written only on ACKED device-command delivery), and a tiny
  // per-user "what was I controlling" selection so the unified stage re-hydrates.
  "ALTER TABLE devices ADD COLUMN screen_on INTEGER NOT NULL DEFAULT 1",
  // 2026-06-04 Video Wall 2 template card: a wall can render in 'span' mode
  // (one source stretched across every screen via the leader/follower
  // wall_config — the existing behaviour) OR 'split' mode (each member screen
  // plays its OWN content full-screen, independently — no wall_config emitted).
  // The dashboard wall card exposes this as a Span/Split template toggle.
  "ALTER TABLE video_walls ADD COLUMN layout_mode TEXT NOT NULL DEFAULT 'span'",
  // 2026-07-17: composable contiguous subgroups. Existing walls remain on the
  // legacy span/split projection until an operator explicitly applies a layout.
  "ALTER TABLE video_walls ADD COLUMN layout_json TEXT",
  "ALTER TABLE video_walls ADD COLUMN layout_revision INTEGER NOT NULL DEFAULT 0",
  // 2026-06-05: persistent whiteboard state per display. Stop/hide does not
  // clear strokes; explicit clear and media broadcasts do.
  `CREATE TABLE IF NOT EXISTS whiteboard_sessions (
    workspace_id TEXT NOT NULL,
    device_id TEXT NOT NULL,
    strokes_json TEXT NOT NULL DEFAULT '[]',
    updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
    PRIMARY KEY (workspace_id, device_id)
  )`,
  "CREATE INDEX IF NOT EXISTS idx_whiteboard_sessions_device ON whiteboard_sessions(device_id)",
];
for (const sql of migrations) {
  try { db.exec(sql); } catch (e) { /* already exists */ }
}

// Classroom 1 walls are fixed to the room's five-display appliance layout.
// Keep the classroom wall membership locked on startup even if the DB was
// restored from an older snapshot that predates the lock column.
try {
  db.prepare(`
    UPDATE video_walls
    SET is_locked = 1
    WHERE name IN (
      'Classroom 1 Video Wall 1',
      'Classroom 1 Video Wall 2',
      'Classroom 1 Primary Wall',
      'Classroom 1 Secondary Wall'
    )
  `).run();
} catch (e) { /* ignore */ }

// Fix assignments table: make content_id nullable (SQLite requires table rebuild)
try {
  const colInfo = db.prepare("PRAGMA table_info(assignments)").all();
  const contentCol = colInfo.find(c => c.name === 'content_id');
  if (contentCol && contentCol.notnull === 1) {
    console.log('Migrating assignments table: making content_id nullable...');
    db.exec(`
      CREATE TABLE assignments_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
        content_id TEXT REFERENCES content(id) ON DELETE CASCADE,
        widget_id TEXT REFERENCES widgets(id) ON DELETE CASCADE,
        zone_id TEXT,
        sort_order INTEGER NOT NULL DEFAULT 0,
        duration_sec INTEGER NOT NULL DEFAULT 10,
        schedule_start TEXT,
        schedule_end TEXT,
        schedule_days TEXT,
        enabled INTEGER NOT NULL DEFAULT 1,
        muted INTEGER DEFAULT 0,
        created_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
      );
      INSERT INTO assignments_new SELECT id, device_id, content_id, widget_id, zone_id, sort_order, duration_sec, schedule_start, schedule_end, schedule_days, enabled, muted, created_at FROM assignments;
      DROP TABLE assignments;
      ALTER TABLE assignments_new RENAME TO assignments;
    `);
    console.log('Assignments table migrated successfully.');
  }
} catch (e) {
  console.error('Assignments migration error:', e.message);
}

// Phase 2 migration: convert existing assignments into per-device playlists
const MIGRATION_ID = 'phase2_playlist_migration';

async function migrateAssignmentsToPlaylists() {
  // Skip if already ran (tracked in schema_migrations table)
  const already = db.prepare('SELECT 1 FROM schema_migrations WHERE id = ?').get(MIGRATION_ID);
  if (already) return;

  const { v4: uuidv4 } = require('uuid');
  const { execFile } = require('child_process');

  // Find devices that have at least one assignment
  const devicesWithAssignments = db.prepare(`
    SELECT DISTINCT d.id, d.name, d.user_id
    FROM devices d
    INNER JOIN assignments a ON a.device_id = d.id
    WHERE d.user_id IS NOT NULL
  `).all();

  if (devicesWithAssignments.length === 0) return;

  console.log(`Migrating ${devicesWithAssignments.length} device(s) from assignments to playlists...`);

  // Async ffprobe — matches the pattern in playlists.js probeAndUpdateDuration
  async function probeVideoDuration(content) {
    if (!content || !content.mime_type || !content.mime_type.startsWith('video/')) return null;
    if (content.duration_sec) return Math.ceil(content.duration_sec);
    if (!content.filepath) return null;
    try {
      const fullPath = path.join(config.contentDir, content.filepath);
      const stdout = await new Promise((resolve, reject) => {
        execFile('ffprobe', [
          '-v', 'quiet', '-print_format', 'json', '-show_format', fullPath
        ], { timeout: 15000 }, (err, out) => err ? reject(err) : resolve(out));
      });
      const info = JSON.parse(stdout);
      if (info.format?.duration) {
        const dur = parseFloat(info.format.duration);
        db.prepare('UPDATE content SET duration_sec = ? WHERE id = ?').run(dur, content.id);
        return Math.ceil(dur);
      }
    } catch (e) {
      console.warn(`  ffprobe failed for ${content.id}:`, e.message);
    }
    return null;
  }

  const getAssignments = db.prepare(`
    SELECT a.content_id, a.widget_id, a.sort_order, a.duration_sec,
           c.mime_type, c.filepath, c.duration_sec as content_duration
    FROM assignments a
    LEFT JOIN content c ON a.content_id = c.id
    WHERE a.device_id = ? AND a.enabled = 1
    ORDER BY a.sort_order ASC
  `);

  // Probe durations outside the transaction (async ffprobe can't run inside SQLite transaction)
  const devicePlaylists = [];
  let videosProbed = 0;
  let totalItems = 0;
  for (const device of devicesWithAssignments) {
    const playlistId = uuidv4();
    const assignments = getAssignments.all(device.id);
    const items = [];
    for (const a of assignments) {
      let duration = a.duration_sec;
      if (a.content_id && a.mime_type?.startsWith('video/')) {
        const probed = await probeVideoDuration({ id: a.content_id, mime_type: a.mime_type, filepath: a.filepath, duration_sec: a.content_duration });
        if (probed) { duration = probed; videosProbed++; }
      }
      items.push({ content_id: a.content_id, widget_id: a.widget_id, sort_order: a.sort_order, duration_sec: duration });
      totalItems++;
    }
    devicePlaylists.push({ device, playlistId, items });
  }

  // Insert everything in a single transaction
  const insertPlaylist = db.prepare(`INSERT INTO playlists (id, user_id, name, description, is_auto_generated) VALUES (?, ?, ?, ?, 1)`);
  const insertItem = db.prepare(`INSERT INTO playlist_items (playlist_id, content_id, widget_id, sort_order, duration_sec) VALUES (?, ?, ?, ?, ?)`);
  const setDevicePlaylist = db.prepare('UPDATE devices SET playlist_id = ? WHERE id = ?');

  const migrate = db.transaction(() => {
    for (const { device, playlistId, items } of devicePlaylists) {
      insertPlaylist.run(playlistId, device.user_id, `${device.name} (migrated)`, 'Auto-generated from previous assignments');
      for (const item of items) {
        insertItem.run(playlistId, item.content_id || null, item.widget_id || null, item.sort_order, item.duration_sec);
      }
      setDevicePlaylist.run(playlistId, device.id);
    }
  });
  migrate();

  // Record that this migration has run
  db.prepare('INSERT OR IGNORE INTO schema_migrations (id) VALUES (?)').run(MIGRATION_ID);

  const scheduleCount = db.prepare('SELECT COUNT(*) as count FROM schedules').get().count;
  console.log(`Migration complete: ${devicesWithAssignments.length} device(s), ${totalItems} playlist item(s), ${videosProbed} video(s) probed, ${scheduleCount} schedule(s).`);
}

migrateAssignmentsToPlaylists().catch(e => console.error('Migration error:', e));

// Phase 3 migration: snapshot existing playlist items into published_snapshot
const PHASE3_MIGRATION_ID = 'phase3_publish_snapshot';

function migratePublishSnapshots() {
  const already = db.prepare('SELECT 1 FROM schema_migrations WHERE id = ?').get(PHASE3_MIGRATION_ID);
  if (already) return;

  const playlists = db.prepare('SELECT id FROM playlists').all();
  if (playlists.length === 0) {
    db.prepare('INSERT OR IGNORE INTO schema_migrations (id) VALUES (?)').run(PHASE3_MIGRATION_ID);
    return;
  }

  console.log(`Phase 3 migration: snapshotting ${playlists.length} playlist(s) as published...`);

  const getItems = db.prepare(`
    SELECT pi.content_id, pi.widget_id, pi.sort_order, pi.duration_sec,
           COALESCE(c.filename, w.name) as filename, c.mime_type, c.filepath, c.file_size,
           c.duration_sec as content_duration, c.remote_url,
           w.name as widget_name, w.widget_type, w.config as widget_config
    FROM playlist_items pi
    LEFT JOIN content c ON pi.content_id = c.id
    LEFT JOIN widgets w ON pi.widget_id = w.id
    WHERE pi.playlist_id = ?
    ORDER BY pi.sort_order ASC
  `);
  const updatePlaylist = db.prepare("UPDATE playlists SET status = 'published', published_snapshot = ? WHERE id = ?");

  const migrate = db.transaction(() => {
    let snapshotted = 0;
    for (const playlist of playlists) {
      const items = getItems.all(playlist.id);
      updatePlaylist.run(JSON.stringify(items), playlist.id);
      snapshotted++;
    }
    db.prepare('INSERT OR IGNORE INTO schema_migrations (id) VALUES (?)').run(PHASE3_MIGRATION_ID);
    console.log(`Phase 3 migration complete: ${snapshotted} playlist(s) snapshotted as published.`);
  });
  migrate();
}

migratePublishSnapshots();

// Phase 4 migration: add group_id to schedules, make device_id nullable, add CHECK constraint
const PHASE4_MIGRATION_ID = 'phase4_group_schedules';

function migrateGroupSchedules() {
  const already = db.prepare('SELECT 1 FROM schema_migrations WHERE id = ?').get(PHASE4_MIGRATION_ID);
  if (already) return;

  console.log('Phase 4 migration: adding group_id to schedules, making device_id nullable...');

  const migrate = db.transaction(() => {
    db.exec(`
      CREATE TABLE schedules_new (
        id              TEXT PRIMARY KEY,
        user_id         TEXT NOT NULL REFERENCES users(id),
        device_id       TEXT REFERENCES devices(id) ON DELETE CASCADE,
        group_id        TEXT REFERENCES device_groups(id) ON DELETE SET NULL,
        zone_id         TEXT REFERENCES layout_zones(id) ON DELETE CASCADE,
        content_id      TEXT REFERENCES content(id) ON DELETE CASCADE,
        widget_id       TEXT REFERENCES widgets(id) ON DELETE CASCADE,
        layout_id       TEXT REFERENCES layouts(id) ON DELETE SET NULL,
        playlist_id     TEXT REFERENCES playlists(id) ON DELETE SET NULL,
        title           TEXT NOT NULL DEFAULT '',
        start_time      TEXT NOT NULL,
        end_time        TEXT NOT NULL,
        timezone        TEXT NOT NULL DEFAULT 'UTC',
        recurrence      TEXT,
        recurrence_end  TEXT,
        priority        INTEGER NOT NULL DEFAULT 0,
        enabled         INTEGER NOT NULL DEFAULT 1,
        color           TEXT DEFAULT '#3B82F6',
        created_at      INTEGER NOT NULL DEFAULT (strftime('%s','now')),
        updated_at      INTEGER NOT NULL DEFAULT (strftime('%s','now')),
        CHECK ((device_id IS NOT NULL AND group_id IS NULL) OR (device_id IS NULL AND group_id IS NOT NULL))
      );

      INSERT INTO schedules_new (id, user_id, device_id, zone_id, content_id, widget_id, layout_id, playlist_id,
        title, start_time, end_time, timezone, recurrence, recurrence_end, priority, enabled, color, created_at, updated_at)
      SELECT id, user_id, device_id, zone_id, content_id, widget_id, layout_id, playlist_id,
        title, start_time, end_time, timezone, recurrence, recurrence_end, priority, enabled, color, created_at, updated_at
      FROM schedules;

      DROP TABLE schedules;
      ALTER TABLE schedules_new RENAME TO schedules;

      CREATE INDEX idx_schedules_device ON schedules(device_id, enabled);
      CREATE INDEX idx_schedules_group ON schedules(group_id, enabled);
    `);

    db.prepare('INSERT OR IGNORE INTO schema_migrations (id) VALUES (?)').run(PHASE4_MIGRATION_ID);
    console.log('Phase 4 migration complete: schedules table rebuilt with group_id support.');
  });
  migrate();
}

migrateGroupSchedules();

// Phase 1 multi-tenancy migration (auto-applies if not yet run). Must come
// AFTER the inline migrations above so that team_id / workspace_id columns
// exist on resource tables - the Phase 1 backfill loop reads team_id and
// updates workspace_id.
ensureMultitenancyMigration();

// Phase 2.2c migration: backfill content_folders.workspace_id from owner's
// default workspace. The ALTER lives in the migrations array above; this
// one-shot populates the column for any rows that pre-date it.
const PHASE6_MIGRATION_ID = 'phase6_content_folders_workspace';

function migrateFolderWorkspaceIds() {
  const already = db.prepare('SELECT 1 FROM schema_migrations WHERE id = ?').get(PHASE6_MIGRATION_ID);
  if (already) return;

  // Belt-and-suspenders: if multi-tenancy tables aren't present (auto-runner
  // somehow skipped), skip cleanly instead of crashing on the JOIN below.
  const hasWorkspaces = db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type='table' AND name='workspaces'"
  ).get();
  if (!hasWorkspaces) {
    console.warn('migrateFolderWorkspaceIds: workspaces table missing, skipping');
    return;
  }

  // Check the column exists before trying to backfill. (Defensive: on a fresh
  // install the schema.sql defines content_folders without the column, the
  // ALTER above adds it, and we proceed; but if anything went sideways we
  // skip rather than throw.)
  const cols = db.prepare("PRAGMA table_info(content_folders)").all();
  if (!cols.some(c => c.name === 'workspace_id')) {
    console.warn('Phase 2.2c migration: content_folders.workspace_id column missing, skipping backfill');
    return;
  }

  const stmt = db.prepare(`
    UPDATE content_folders SET workspace_id = (
      SELECT w.id FROM workspaces w
      JOIN workspace_members wm ON wm.workspace_id = w.id
      WHERE wm.user_id = content_folders.user_id
      ORDER BY wm.joined_at ASC LIMIT 1
    )
    WHERE workspace_id IS NULL AND user_id IS NOT NULL
  `);

  const tx = db.transaction(() => {
    const result = stmt.run();
    db.prepare('INSERT OR IGNORE INTO schema_migrations (id) VALUES (?)').run(PHASE6_MIGRATION_ID);
    return result.changes;
  });
  const changes = tx();
  if (changes > 0) console.log(`Phase 2.2c migration: backfilled workspace_id on ${changes} content_folders row(s).`);
}

migrateFolderWorkspaceIds();

const PHASE_2_2_ACTIVITY_STOP_ID = 'phase_2_2_activity_log_stop_bleeding';

// One-time backfill of activity_log rows that were written between the
// Phase 1 schema migration and the writer-leak fix in this commit. Strategy:
//   * Rows with device_id: derive workspace_id from devices.workspace_id
//     (the activity is about a specific device, so this is unambiguous).
//   * Rows with no device_id but a user_id: derive from the user's oldest
//     workspace_members row (pre-flight confirmed 0 affected users have
//     more than one workspace, so the choice is unambiguous).
// Rows with user_id IS NULL (auth:login_failed and similar pre-tenancy
// system events) are left alone - they have no tenant context.
function backfillActivityLogWorkspace() {
  const already = db.prepare('SELECT 1 FROM schema_migrations WHERE id = ?').get(PHASE_2_2_ACTIVITY_STOP_ID);
  if (already) return;

  // Belt-and-suspenders: if multi-tenancy tables aren't present (auto-runner
  // somehow skipped), skip cleanly instead of crashing on workspace_members.
  const hasMembers = db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type='table' AND name='workspace_members'"
  ).get();
  if (!hasMembers) {
    console.warn('backfillActivityLogWorkspace: workspace_members table missing, skipping');
    return;
  }

  const viaDevice = db.prepare(`
    UPDATE activity_log SET workspace_id = (
      SELECT workspace_id FROM devices WHERE devices.id = activity_log.device_id
    )
    WHERE workspace_id IS NULL AND device_id IS NOT NULL
      AND EXISTS (SELECT 1 FROM devices WHERE devices.id = activity_log.device_id AND devices.workspace_id IS NOT NULL)
  `);

  const viaMembers = db.prepare(`
    UPDATE activity_log SET workspace_id = (
      SELECT wm.workspace_id FROM workspace_members wm
      WHERE wm.user_id = activity_log.user_id
      ORDER BY wm.joined_at ASC LIMIT 1
    )
    WHERE workspace_id IS NULL AND user_id IS NOT NULL AND device_id IS NULL
      AND EXISTS (SELECT 1 FROM workspace_members wm WHERE wm.user_id = activity_log.user_id)
  `);

  const tx = db.transaction(() => {
    const d = viaDevice.run().changes;
    const m = viaMembers.run().changes;
    db.prepare('INSERT OR IGNORE INTO schema_migrations (id) VALUES (?)').run(PHASE_2_2_ACTIVITY_STOP_ID);
    return { d, m };
  });
  const { d, m } = tx();
  if (d + m > 0) console.log(`activity_log backfill: ${d} via device.workspace_id, ${m} via workspace_members lookup`);
}

backfillActivityLogWorkspace();

// Phase 2 zone_id backfill. Companion to the ADD COLUMN above. Attempts to
// recover zone_id values for playlist_items rows by joining back to the
// (legacy) assignments table on device+content/widget. On installs where
// assignments is empty or never had zone_id populated this is a no-op; the
// migration row is stamped regardless so it doesn't re-run.
//
// Also regenerates published_snapshot JSON for every published playlist so
// the snapshot the player consumes carries zone_id going forward (the
// player resolves a.zone_id === zone.id in renderZones). Even with zero
// rows backfilled, this republish closes the snapshot-staleness gap.
//
// Pre-migration snapshot is a one-off for this migration only - the general
// "every migration backs up first" framework is tracked as a separate
// concern, not built here.
const PHASE2_ZONE_ID_BACKFILL_ID = 'phase2_zone_id_backfill';
function backfillPlaylistItemsZoneId() {
  const already = db.prepare('SELECT 1 FROM schema_migrations WHERE id = ?').get(PHASE2_ZONE_ID_BACKFILL_ID);
  if (already) return;

  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const snapshotPath = path.join(dbDir, `remote_display.pre-zone-id-backfill-${ts}.db`);
  try {
    db.pragma('wal_checkpoint(TRUNCATE)');
    fs.copyFileSync(config.dbPath, snapshotPath);
    console.warn(`[zone-id backfill] Pre-migration snapshot: ${snapshotPath}`);
  } catch (e) {
    console.error(`[zone-id backfill] Snapshot failed: ${e.message}`);
    process.exit(1);
  }

  try {
    const tx = db.transaction(() => {
      // Backfill: best-effort match playlist_items back to assignments via
      // device.playlist_id and content/widget identity. LIMIT 1 covers the
      // unlikely "same content assigned twice in different zones on one
      // device" edge case. Items with no matching legacy assignment, or
      // matches that themselves had zone_id NULL, are left as NULL.
      const backfilled = db.prepare(`
        UPDATE playlist_items
        SET zone_id = (
          SELECT a.zone_id FROM assignments a
          JOIN devices d ON d.id = a.device_id
          WHERE d.playlist_id = playlist_items.playlist_id
            AND a.zone_id IS NOT NULL
            AND (
              (a.content_id IS NOT NULL AND a.content_id = playlist_items.content_id)
              OR
              (a.widget_id IS NOT NULL AND a.widget_id = playlist_items.widget_id)
            )
          LIMIT 1
        )
        WHERE zone_id IS NULL
          AND EXISTS (
            SELECT 1 FROM assignments a
            JOIN devices d ON d.id = a.device_id
            WHERE d.playlist_id = playlist_items.playlist_id
              AND a.zone_id IS NOT NULL
              AND (
                (a.content_id IS NOT NULL AND a.content_id = playlist_items.content_id)
                OR
                (a.widget_id IS NOT NULL AND a.widget_id = playlist_items.widget_id)
              )
          )
      `).run().changes;

      // Republish: regenerate published_snapshot for every published playlist
      // so the snapshot JSON carries zone_id. Mirrors buildSnapshotItems in
      // routes/playlists.js - kept inline here to avoid pulling routes/* in
      // at migration time (circular require).
      const publishedPlaylists = db.prepare("SELECT id FROM playlists WHERE status = 'published'").all();
      const buildSnapshot = db.prepare(`
        SELECT pi.content_id, pi.widget_id, pi.zone_id, pi.sort_order, pi.duration_sec,
               COALESCE(c.filename, w.name) as filename, c.mime_type, c.filepath, c.file_size,
               c.duration_sec as content_duration, c.remote_url,
               w.name as widget_name, w.widget_type, w.config as widget_config
        FROM playlist_items pi
        LEFT JOIN content c ON pi.content_id = c.id
        LEFT JOIN widgets w ON pi.widget_id = w.id
        WHERE pi.playlist_id = ?
        ORDER BY pi.sort_order ASC
      `);
      const updateSnap = db.prepare("UPDATE playlists SET published_snapshot = ?, updated_at = strftime('%s','now') WHERE id = ?");
      let republished = 0;
      for (const pl of publishedPlaylists) {
        const items = buildSnapshot.all(pl.id);
        updateSnap.run(JSON.stringify(items), pl.id);
        republished++;
      }

      db.prepare('INSERT OR IGNORE INTO schema_migrations (id) VALUES (?)').run(PHASE2_ZONE_ID_BACKFILL_ID);
      return { backfilled, republished };
    });
    const { backfilled, republished } = tx();
    console.log(`[zone-id backfill] ${backfilled} playlist_items recovered zone_id, ${republished} published_snapshots regenerated`);
  } catch (e) {
    console.error(`[zone-id backfill] Migration FAILED: ${e.message}`);
    console.error(`[zone-id backfill] Restore with: cp ${snapshotPath} ${config.dbPath}`);
    process.exit(1);
  }
}

backfillPlaylistItemsZoneId();

// Phase 2 (display self-report): add viewport / DPR / refresh / capabilities
// columns to devices so displays can auto-report their rendering geometry.
// Idempotent in two layers: (1) skip entirely once stamped in
// schema_migrations, and (2) each ADD COLUMN is wrapped in its own try/catch
// so a partially-applied run (or a column that already exists from a previous
// hand-applied ALTER) can't throw and crash boot. Mirrors the additive
// ALTER-in-a-loop pattern used by the inline `migrations` array above.
const MC_DISPLAY_VIEWPORT_ID = 'mc_display_viewport';
function migrateDisplayViewportColumns() {
  // Self-healing: ensure the columns exist on EVERY boot driven off PRAGMA
  // (the actual table shape), NOT the schema_migrations stamp. A prior boot
  // stamped this migration even though the ALTERs had not landed, which then
  // made a stamp-gated version skip the fix forever. Driving off real columns
  // is idempotent and recovers from that state.
  let cols;
  try { cols = db.prepare('PRAGMA table_info(devices)').all().map(c => c.name); }
  catch (e) { console.warn('[mc_display_viewport] table_info(devices) failed:', e.message); return; }
  const adds = [
    ['viewport_css_w', 'ALTER TABLE devices ADD COLUMN viewport_css_w INTEGER'],
    ['viewport_css_h', 'ALTER TABLE devices ADD COLUMN viewport_css_h INTEGER'],
    ['device_pixel_ratio', 'ALTER TABLE devices ADD COLUMN device_pixel_ratio REAL'],
    ['refresh_hz', 'ALTER TABLE devices ADD COLUMN refresh_hz INTEGER'],
    ['capabilities_json', 'ALTER TABLE devices ADD COLUMN capabilities_json TEXT'],
    ['last_viewport_at', 'ALTER TABLE devices ADD COLUMN last_viewport_at INTEGER'],
    ['location_label', 'ALTER TABLE devices ADD COLUMN location_label TEXT'],
  ];
  const missing = adds.filter(([name]) => !cols.includes(name));
  for (const [name, sql] of missing) {
    try { db.exec(sql); console.log('[mc_display_viewport] added column', name); }
    catch (e) { console.error('[mc_display_viewport] ADD COLUMN', name, 'failed:', e.message); }
  }
  try { db.prepare('INSERT OR IGNORE INTO schema_migrations (id) VALUES (?)').run(MC_DISPLAY_VIEWPORT_ID); }
  catch (e) { /* stamp best-effort */ }
}

migrateDisplayViewportColumns();

// Phase 2: node transport state. Keep node heartbeat transport metadata in
// sync with the schema even on older databases that predate the column.
const NODE_TRANSPORT_STATE_ID = 'node_transport_state';
function migrateNodeTransportStateColumns() {
  let managedCols = [];
  let heartbeatCols = [];
  try {
    managedCols = db.prepare('PRAGMA table_info(managed_nodes)').all().map((c) => c.name);
  } catch (e) {
    console.warn('[node_transport_state] table_info(managed_nodes) failed:', e.message);
    return;
  }
  try {
    heartbeatCols = db.prepare('PRAGMA table_info(node_heartbeats)').all().map((c) => c.name);
  } catch (e) {
    console.warn('[node_transport_state] table_info(node_heartbeats) failed:', e.message);
    return;
  }

  const adds = [
    ['managed_nodes', 'network_state_json', 'ALTER TABLE managed_nodes ADD COLUMN network_state_json TEXT', managedCols],
    ['node_heartbeats', 'network_state_json', 'ALTER TABLE node_heartbeats ADD COLUMN network_state_json TEXT', heartbeatCols],
    ['managed_nodes', 'telemetry_json', 'ALTER TABLE managed_nodes ADD COLUMN telemetry_json TEXT', managedCols],
    ['node_heartbeats', 'telemetry_json', 'ALTER TABLE node_heartbeats ADD COLUMN telemetry_json TEXT', heartbeatCols],
  ];

  for (const [table, column, sql, cols] of adds) {
    if (cols.includes(column)) continue;
    try {
      db.exec(sql);
      console.log(`[node_transport_state] added column ${table}.${column}`);
    } catch (e) {
      console.error(`[node_transport_state] ADD COLUMN ${table}.${column} failed:`, e.message);
    }
  }

  try {
    db.prepare('INSERT OR IGNORE INTO schema_migrations (id) VALUES (?)').run(NODE_TRANSPORT_STATE_ID);
  } catch (e) {
    console.warn('[node_transport_state] stamp failed:', e.message);
  }
}

migrateNodeTransportStateColumns();

const DISPLAY_STATE_REVISION_ID = 'display_state_revision';
function migrateDisplayStateRevision() {
  let cols = [];
  try { cols = db.prepare('PRAGMA table_info(display_states)').all().map((column) => column.name); }
  catch (e) { console.warn('[display_state_revision] table_info failed:', e.message); return; }
  const additions = [
    ['state_revision', 'ALTER TABLE display_states ADD COLUMN state_revision INTEGER NOT NULL DEFAULT 0'],
    ['slide_count', 'ALTER TABLE display_states ADD COLUMN slide_count INTEGER'],
    ['wall_id', 'ALTER TABLE display_states ADD COLUMN wall_id TEXT'],
    ['layout_id', 'ALTER TABLE display_states ADD COLUMN layout_id TEXT'],
    ['group_id', 'ALTER TABLE display_states ADD COLUMN group_id TEXT'],
    ['member_id', 'ALTER TABLE display_states ADD COLUMN member_id TEXT'],
    ['playback_revision', 'ALTER TABLE display_states ADD COLUMN playback_revision INTEGER'],
    ['command_revision', 'ALTER TABLE display_states ADD COLUMN command_revision TEXT'],
  ];
  for (const [name, sql] of additions) {
    if (cols.includes(name)) continue;
    try { db.exec(sql); }
    catch (e) { console.error(`[display_state_revision] ${name} failed:`, e.message); return; }
  }
  try { db.prepare('INSERT OR IGNORE INTO schema_migrations (id) VALUES (?)').run(DISPLAY_STATE_REVISION_ID); }
  catch (e) { console.warn('[display_state_revision] stamp failed:', e.message); }
}

migrateDisplayStateRevision();

const CONTENT_LIFECYCLE_ID = 'content_asset_lifecycle';
function migrateContentLifecycle() {
  let cols = [];
  try { cols = db.prepare('PRAGMA table_info(content)').all().map((column) => column.name); }
  catch (e) { console.warn('[content_asset_lifecycle] table_info failed:', e.message); return; }
  const additions = [
    ['original_filepath', 'ALTER TABLE content ADD COLUMN original_filepath TEXT'],
    ['original_sha256', 'ALTER TABLE content ADD COLUMN original_sha256 TEXT'],
    ['processing_status', "ALTER TABLE content ADD COLUMN processing_status TEXT NOT NULL DEFAULT 'uploaded'"],
    ['processing_error', 'ALTER TABLE content ADD COLUMN processing_error TEXT'],
    ['media_probe_json', 'ALTER TABLE content ADD COLUMN media_probe_json TEXT'],
    ['updated_at', 'ALTER TABLE content ADD COLUMN updated_at INTEGER'],
  ];
  for (const [name, sql] of additions) {
    if (cols.includes(name)) continue;
    try { db.exec(sql); }
    catch (e) { console.error(`[content_asset_lifecycle] ${name} failed:`, e.message); }
  }
  try { db.prepare('INSERT OR IGNORE INTO schema_migrations (id) VALUES (?)').run(CONTENT_LIFECYCLE_ID); }
  catch (e) { console.warn('[content_asset_lifecycle] stamp failed:', e.message); }
}

migrateContentLifecycle();

// Phase 3: Operational Activities ("Scenes") + asset placements.
// A scene is a named snapshot of which content/playlist shows on which display;
// one tap triggers it and pushes each placement to its device via the existing
// device-content-push path (services/scene-engine.js). Idempotent: tables use
// CREATE TABLE IF NOT EXISTS so a re-run can't throw, and we do NOT gate solely
// on the schema_migrations stamp (the stamp is best-effort/cosmetic). Mirrors
// the additive, self-healing pattern used by the migrations above.
const MC_SCENES_ID = 'mc_scenes';
function migrateScenes() {
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS operational_activities (
        id           TEXT PRIMARY KEY,
        workspace_id TEXT,
        name         TEXT NOT NULL,
        description  TEXT,
        created_by   TEXT,
        created_at   INTEGER,
        updated_at   INTEGER
      );
    `);
    db.exec(`
      CREATE TABLE IF NOT EXISTS activity_asset_placements (
        id                    TEXT PRIMARY KEY,
        activity_id           TEXT NOT NULL,
        device_id             TEXT,
        wall_id               TEXT,
        content_id            TEXT,
        remote_url            TEXT,
        playlist_id           TEXT,
        fit_mode              TEXT DEFAULT 'contain',
        rotation              TEXT DEFAULT '0',
        sort_order            INTEGER DEFAULT 0,
        custom_properties_json TEXT,
        FOREIGN KEY(activity_id) REFERENCES operational_activities(id) ON DELETE CASCADE
      );
    `);
    db.exec('CREATE INDEX IF NOT EXISTS idx_activity_placements_activity ON activity_asset_placements(activity_id)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_operational_activities_workspace ON operational_activities(workspace_id)');
  } catch (e) {
    console.error('[mc_scenes] migration failed:', e.message);
  }
  try { db.prepare('INSERT OR IGNORE INTO schema_migrations (id) VALUES (?)').run(MC_SCENES_ID); }
  catch (e) { /* stamp best-effort */ }
}

migrateScenes();

function migrateDashboardState() {
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS dashboard_state (
        user_id        TEXT NOT NULL,
        workspace_id   TEXT NOT NULL,
        selection_json TEXT NOT NULL DEFAULT '[]',
        updated_at     INTEGER NOT NULL DEFAULT (strftime('%s','now')),
        PRIMARY KEY (user_id, workspace_id)
      );
    `);
  } catch (e) {
    console.error('[dashboard_state] migration failed:', e.message);
  }
}
migrateDashboardState();

function migrateAdvancedCanvas() {
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS advanced_canvas_endpoints (
        id              TEXT PRIMARY KEY,
        workspace_id    TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        name            TEXT NOT NULL,
        token_hash      TEXT NOT NULL,
        status          TEXT NOT NULL DEFAULT 'offline',
        last_heartbeat  INTEGER,
        topology_json   TEXT,
        canvas_width    INTEGER NOT NULL DEFAULT 1920,
        canvas_height   INTEGER NOT NULL DEFAULT 1080,
        scene_revision  INTEGER NOT NULL DEFAULT 0,
        active          INTEGER NOT NULL DEFAULT 0,
        created_at      INTEGER NOT NULL DEFAULT (strftime('%s','now')),
        updated_at      INTEGER NOT NULL DEFAULT (strftime('%s','now'))
      );
      CREATE TABLE IF NOT EXISTS advanced_canvas_layers (
        id              TEXT PRIMARY KEY,
        endpoint_id     TEXT NOT NULL REFERENCES advanced_canvas_endpoints(id) ON DELETE CASCADE,
        x               REAL NOT NULL,
        y               REAL NOT NULL,
        width           REAL NOT NULL,
        height          REAL NOT NULL,
        z_index         INTEGER NOT NULL DEFAULT 0,
        label           TEXT,
        source_json     TEXT NOT NULL,
        render_json     TEXT NOT NULL,
        fit_mode        TEXT NOT NULL DEFAULT 'contain',
        muted           INTEGER NOT NULL DEFAULT 1,
        created_at      INTEGER NOT NULL DEFAULT (strftime('%s','now')),
        updated_at      INTEGER NOT NULL DEFAULT (strftime('%s','now'))
      );
      CREATE INDEX IF NOT EXISTS idx_advanced_canvas_workspace
        ON advanced_canvas_endpoints(workspace_id);
      CREATE INDEX IF NOT EXISTS idx_advanced_canvas_layers_endpoint
        ON advanced_canvas_layers(endpoint_id, z_index);
    `);
  } catch (e) {
    console.error('[advanced_canvas] migration failed:', e.message);
  }
}
migrateAdvancedCanvas();

// Security hardening (2026-06-06): dedicated append-only audit log for
// state-changing display-control actions (commands to displays, scene/playlist
// changes, provisioning/pairing, kiosk actions). Separate from activity_log so
// security review has one purpose-built, redacted trail that the app's own
// activity-feed pruning/queries can't dilute. Idempotent CREATE IF NOT EXISTS
// + best-effort stamp, mirroring migrateScenes / migrateDashboardState. See
// lib/audit.js for the writer (it redacts secrets/tokens before insert).
const MC_AUDIT_LOG_ID = 'mc_audit_log';
function migrateAuditLog() {
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS audit_log (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        created_at    INTEGER NOT NULL DEFAULT (strftime('%s','now')),
        actor_type    TEXT NOT NULL,        -- 'user' | 'device' | 'system'
        actor_id      TEXT,                 -- user id or device id
        action        TEXT NOT NULL,        -- e.g. 'display.command', 'scene.trigger'
        target_type   TEXT,                 -- 'device' | 'workspace' | 'scene' | 'kiosk' | ...
        target_id     TEXT,
        workspace_id  TEXT,
        source_ip     TEXT,
        details       TEXT                  -- redacted JSON summary (no secrets/tokens)
      );
    `);
    db.exec('CREATE INDEX IF NOT EXISTS idx_audit_log_created ON audit_log(created_at)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_audit_log_workspace ON audit_log(workspace_id, created_at)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_audit_log_target ON audit_log(target_type, target_id)');
  } catch (e) {
    console.error('[mc_audit_log] migration failed:', e.message);
  }
  try { db.prepare('INSERT OR IGNORE INTO schema_migrations (id) VALUES (?)').run(MC_AUDIT_LOG_ID); }
  catch (e) { /* stamp best-effort */ }
}
migrateAuditLog();

// The legacy Classroom-1 wall-to-group backfill is retired. It now writes only
// its one-shot retirement marker so fresh databases cannot recreate the old
// wall/group mutual-exclusivity violation. Existing rows require the explicit,
// audited topology repair command.
const CLASSROOM1_GROUP_MEMBERS_ID = 'classroom1_group_members';
function backfillClassroomGroupMembers() {
  const already = db.prepare('SELECT 1 FROM schema_migrations WHERE id = ?').get(CLASSROOM1_GROUP_MEMBERS_ID);
  if (already) return;
  try {
    const { runBackfill } = require('../scripts/backfill-classroom-groups');
    const r = runBackfill({ db });
    if (!r.skipped) {
      console.log(`[classroom1_group_members] ${r.reason}`);
    }
  } catch (e) {
    console.warn(`[classroom1_group_members] backfill failed: ${e.message}`);
  }
}
backfillClassroomGroupMembers();

// Phase 6 Screensaver folder seed: ensure every workspace owns a content_folders
// row named "Screensavers" so the Stage screensaver dropdown can open the media
// drawer filtered to it. Idempotent (INSERT OR IGNORE + per-workspace existence
// check) and gated on schema_migrations so it runs exactly once per database.
// Mirrors the classroom1_group_members harness above. See
// scripts/seed-screensaver-folder.js.
const SCREENSAVER_FOLDER_SEED_ID = 'screensaver_folder_seed';
function seedScreensaverFolderRow() {
  const already = db.prepare('SELECT 1 FROM schema_migrations WHERE id = ?').get(SCREENSAVER_FOLDER_SEED_ID);
  if (already) return;
  try {
    const { runSeed } = require('../scripts/seed-screensaver-folder');
    const r = runSeed({ db });
    if (!r.skipped) {
      console.log(`[screensaver_folder_seed] seeded ${r.created} folder(s) across ${r.workspaces} workspace(s)`);
    }
  } catch (e) {
    console.warn(`[screensaver_folder_seed] seed failed: ${e.message}`);
  }
}
seedScreensaverFolderRow();

// Phase-2 follow-up: flip existing advanced-canvas layers' fit_mode from
// 'contain' or 'cover' (the historical default / a later attempt) to 'fill'
// — the operator-confirmed wallpaper behavior: wall content stretches to the
// layer box edge-to-bezel with NO letterbox and NO crop (exactly edge-to-edge
// of the wall). Additive, idempotent: gated on schema_migrations so it runs
// exactly once per database. See server/lib/advanced-canvas.js
// getEndpointLayers/normalizeSceneLayers (default now 'fill') and
// planning/command-center/FINAL_IMPLEMENTATION_SUMMARY.md.
const CANVAS_LAYERS_DEFAULT_FILL_ID = 'advanced_canvas_layers_default_fill_v2';
function applyCanvasLayersDefaultFill() {
  const already = db.prepare('SELECT 1 FROM schema_migrations WHERE id = ?').get(CANVAS_LAYERS_DEFAULT_FILL_ID);
  if (already) return;
  try {
    // Skip silently if the additive Phase-2 tables aren't present yet (early
    // boot before the schema migrations array applied on first run).
    db.prepare('SELECT 1 FROM advanced_canvas_layers LIMIT 1').get();
    const res = db.prepare(`UPDATE advanced_canvas_layers
      SET fit_mode = 'fill'
      WHERE fit_mode IS NULL OR fit_mode = '' OR fit_mode = 'contain' OR fit_mode = 'cover'`).run();
    console.log(`[advanced_canvas_layers_default_fill_v2] updated ${res.changes} layer(s) contain/cover -> fill`);
  } catch (e) {
    console.warn(`[advanced_canvas_layers_default_fill_v2] skipped: ${e.message}`);
  }
  db.prepare('INSERT OR IGNORE INTO schema_migrations (id) VALUES (?)').run(CANVAS_LAYERS_DEFAULT_FILL_ID);
}
applyCanvasLayersDefaultFill();

// The MBFD Map is authored as one full-wall composite. Older imports saved it
// with a per-item "contain" override, which overruled the wall player's fill
// default and letterboxed the map. Heal that known content row without changing
// the fit policy of unrelated images.
const MBFD_MAP_WALL_FILL_ID = 'mbfd_map_wall_fill_v2';
function healMbfdMapWallFit() {
  const already = db.prepare('SELECT 1 FROM schema_migrations WHERE id = ?').get(MBFD_MAP_WALL_FILL_ID);
  if (already) return;
  try {
    const updated = db.prepare(`
      UPDATE content
      SET default_fit_mode = 'fill'
      WHERE lower(trim(filename)) = 'mbfd_map.png'
        AND (default_fit_mode IS NULL OR lower(trim(default_fit_mode)) <> 'fill')
    `).run();
    console.log(`[mbfd_map_wall_fill_v2] updated ${updated.changes} content row(s)`);
  } catch (e) {
    console.warn(`[mbfd_map_wall_fill_v2] skipped: ${e.message}`);
  }
  try { db.prepare('INSERT OR IGNORE INTO schema_migrations (id) VALUES (?)').run(MBFD_MAP_WALL_FILL_ID); }
  catch { /* best-effort stamp */ }
}
healMbfdMapWallFit();

// ── YouTube MIME self-heal ─────────────────────────────────────────────────────
// Content rows created before the MIME resolver fix were stored with mime_type
// 'text/html' or 'image/jpeg' for YouTube URLs. The player routes those through
// /player/site.html → Chromium headless → YouTube shows "sign in to confirm
// you're not a bot" → screenshot of the bot-check page plays on the display.
// Fix: one-time UPDATE of all such rows to mime_type='video/youtube'.
const YOUTUBE_MIME_HEAL_ID = 'youtube_mime_heal_v1';
function healYoutubeMimeTypes() {
  const already = db.prepare('SELECT 1 FROM schema_migrations WHERE id = ?').get(YOUTUBE_MIME_HEAL_ID);
  if (already) return;
  try {
    const updated = db.prepare(`
      UPDATE content
      SET mime_type = 'video/youtube'
      WHERE mime_type IN ('text/html', 'image/jpeg', 'image/png')
        AND remote_url REGEXP '(?:youtube\.com/(?:watch|embed|v|shorts)|youtu\.be/)'
    `).run();
    // SQLite doesn't have REGEXP by default — use a JS loop as a fallback.
    if (updated === undefined || updated.changes === undefined) throw new Error('regexp_unsupported');
    console.log(`[boot] YouTube MIME heal: updated ${updated.changes} row(s) to video/youtube`);
  } catch {
    // REGEXP not available — iterate with JS
    try {
      const rows = db.prepare(
        "SELECT id, remote_url FROM content WHERE mime_type IN ('text/html','image/jpeg','image/png') AND remote_url LIKE '%youtube%'"
      ).all();
      const ytRe = /(?:youtube\.com\/(?:watch|embed|v|shorts)|youtu\.be\/)/i;
      let count = 0;
      const stmt = db.prepare("UPDATE content SET mime_type='video/youtube' WHERE id=?");
      for (const r of rows) {
        if (ytRe.test(r.remote_url || '')) { stmt.run(r.id); count++; }
      }
      console.log(`[boot] YouTube MIME heal (JS): updated ${count} row(s) to video/youtube`);
    } catch (e2) {
      console.warn('[boot] YouTube MIME heal skipped:', e2.message);
    }
  }
  try { db.prepare('INSERT OR IGNORE INTO schema_migrations (id) VALUES (?)').run(YOUTUBE_MIME_HEAL_ID); } catch { /* ignore */ }
}
healYoutubeMimeTypes();

// Clean databases should enforce topology invariants from their first boot.
// Existing installations with drift stay available for the explicit,
// hash-guarded repair workflow: never auto-repair or partially constrain an
// inconsistent topology here.
function activateDisplayTopologyGuards() {
  try {
    const { analyzeTopology, installTopologyGuards } = require('../lib/topology-repair');
    const report = analyzeTopology(db);
    if (report.issueCount === 0) {
      installTopologyGuards(db);
      console.log('[display_topology_integrity_v1] durable guards active');
      return;
    }
    console.warn(
      `[display_topology_integrity_v1] ${report.issueCount} issue(s) detected; ` +
      'guards pending explicit topology repair'
    );
  } catch (error) {
    console.warn(`[display_topology_integrity_v1] guard activation skipped: ${error.message}`);
  }
}
activateDisplayTopologyGuards();

// Prune old telemetry (keep last 24h worth at 15s intervals = ~5760, cap at 6000)
function pruneTelemetry(deviceId) {
  db.prepare(`
    DELETE FROM device_telemetry
    WHERE device_id = ? AND id NOT IN (
      SELECT id FROM device_telemetry
      WHERE device_id = ?
      ORDER BY reported_at DESC LIMIT 6000
    )
  `).run(deviceId, deviceId);
}

// Prune old screenshots (keep only latest per device)
function pruneScreenshots(deviceId) {
  const old = db.prepare(`
    SELECT filepath FROM screenshots
    WHERE device_id = ? AND id NOT IN (
      SELECT id FROM screenshots WHERE device_id = ? ORDER BY captured_at DESC LIMIT 1
    )
  `).all(deviceId, deviceId);

  for (const row of old) {
    const fullPath = path.join(config.screenshotsDir, row.filepath);
    if (fs.existsSync(fullPath)) fs.unlinkSync(fullPath);
  }

  db.prepare(`
    DELETE FROM screenshots
    WHERE device_id = ? AND id NOT IN (
      SELECT id FROM screenshots WHERE device_id = ? ORDER BY captured_at DESC LIMIT 1
    )
  `).run(deviceId, deviceId);
}

module.exports = { db, pruneTelemetry, pruneScreenshots };
