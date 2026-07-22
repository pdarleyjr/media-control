CREATE TABLE IF NOT EXISTS plans (
    id              TEXT PRIMARY KEY,
    name            TEXT NOT NULL,
    display_name    TEXT NOT NULL,
    max_devices     INTEGER NOT NULL DEFAULT 2,
    max_storage_mb  INTEGER NOT NULL DEFAULT 500,
    remote_control  INTEGER NOT NULL DEFAULT 0,
    remote_url      INTEGER NOT NULL DEFAULT 0,
    priority_support INTEGER NOT NULL DEFAULT 0,
    price_monthly   REAL NOT NULL DEFAULT 0,
    price_yearly    REAL NOT NULL DEFAULT 0,
    stripe_monthly_id TEXT,
    stripe_yearly_id  TEXT,
    sort_order      INTEGER NOT NULL DEFAULT 0,
    active          INTEGER NOT NULL DEFAULT 1
);

-- Default plans
INSERT OR IGNORE INTO plans (id, name, display_name, max_devices, max_storage_mb, remote_control, remote_url, priority_support, price_monthly, price_yearly, sort_order)
VALUES
  ('free',       'free',       'Free',       2,    500,   0, 0, 0, 0,     0,     0),
  ('starter',    'starter',    'Starter',    8,    2048,  1, 0, 0, 9.99,  99,    1),
  ('pro',        'pro',        'Pro',        25,   10240, 1, 1, 0, 24.99, 249,   2),
  ('enterprise', 'enterprise', 'Enterprise', -1,   -1,    1, 1, 1, 49.99, 499,   3);

CREATE TABLE IF NOT EXISTS users (
    id              TEXT PRIMARY KEY,
    email           TEXT UNIQUE NOT NULL,
    username        TEXT,
    name            TEXT NOT NULL DEFAULT '',
    password_hash   TEXT,
    auth_provider   TEXT NOT NULL DEFAULT 'local',
    provider_id     TEXT,
    avatar_url      TEXT,
    role            TEXT NOT NULL DEFAULT 'user',
    plan_id         TEXT DEFAULT 'free' REFERENCES plans(id),
    stripe_customer_id TEXT,
    stripe_subscription_id TEXT,
    subscription_status TEXT DEFAULT 'active',
    subscription_ends  INTEGER,
    created_at      INTEGER NOT NULL DEFAULT (strftime('%s','now')),
    updated_at      INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);

CREATE TABLE IF NOT EXISTS devices (
    id              TEXT PRIMARY KEY,
    user_id         TEXT REFERENCES users(id),
    name            TEXT NOT NULL DEFAULT 'Unnamed Display',
    pairing_code    TEXT UNIQUE,
    status          TEXT NOT NULL DEFAULT 'offline',
    last_heartbeat  INTEGER,
    ip_address      TEXT,
    android_version TEXT,
    app_version     TEXT,
    screen_width    INTEGER,
    screen_height   INTEGER,
    playlist_id     TEXT REFERENCES playlists(id) ON DELETE SET NULL,
    created_at      INTEGER NOT NULL DEFAULT (strftime('%s','now')),
    updated_at      INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);

CREATE TABLE IF NOT EXISTS device_telemetry (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    device_id       TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
    battery_level   INTEGER,
    battery_charging INTEGER NOT NULL DEFAULT 0,
    storage_free_mb INTEGER,
    storage_total_mb INTEGER,
    ram_free_mb     INTEGER,
    ram_total_mb    INTEGER,
    cpu_usage       REAL,
    wifi_ssid       TEXT,
    wifi_rssi       INTEGER,
    uptime_seconds  INTEGER,
    reported_at     INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);

CREATE INDEX IF NOT EXISTS idx_telemetry_device ON device_telemetry(device_id, reported_at DESC);

CREATE TABLE IF NOT EXISTS content (
    id              TEXT PRIMARY KEY,
    user_id         TEXT REFERENCES users(id),
    filename        TEXT NOT NULL,
    filepath        TEXT NOT NULL DEFAULT '',
    mime_type       TEXT NOT NULL,
    file_size       INTEGER NOT NULL DEFAULT 0,
    duration_sec    REAL,
    thumbnail_path  TEXT,
    width           INTEGER,
    height          INTEGER,
    remote_url      TEXT,
    original_filepath TEXT,
    original_sha256 TEXT,
    processing_status TEXT NOT NULL DEFAULT 'uploaded',
    processing_error TEXT,
    media_probe_json TEXT,
    access_level    TEXT NOT NULL DEFAULT 'private',
    published_at   INTEGER,
    published_by   TEXT,
    source_content_id TEXT REFERENCES content(id) ON DELETE SET NULL,
    version         INTEGER NOT NULL DEFAULT 1,
    archived_at     INTEGER,
    updated_at      INTEGER,
    created_at      INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);

CREATE TABLE IF NOT EXISTS assignments (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    device_id       TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
    content_id      TEXT REFERENCES content(id) ON DELETE CASCADE,
    widget_id       TEXT REFERENCES widgets(id) ON DELETE CASCADE,
    zone_id         TEXT,
    sort_order      INTEGER NOT NULL DEFAULT 0,
    duration_sec    INTEGER NOT NULL DEFAULT 10,
    schedule_start  TEXT,
    schedule_end    TEXT,
    schedule_days   TEXT,
    enabled         INTEGER NOT NULL DEFAULT 1,
    created_at      INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);

CREATE TABLE IF NOT EXISTS screenshots (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    device_id       TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
    filepath        TEXT NOT NULL,
    captured_at     INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);

CREATE INDEX IF NOT EXISTS idx_screenshots_device ON screenshots(device_id, captured_at DESC);

-- ===================== LAYOUTS & ZONES =====================
-- Zones are stored as PERCENTAGES of the layout canvas (x_percent, y_percent,
-- width_percent, height_percent in 0..100), NOT pixels. The player renders them
-- as CSS percentages, so a single layout / split-screen template auto-scales and
-- snaps to ANY target geometry — a 1080p TV or the ultra-wide video-wall canvas —
-- with no per-display overrides. Keep new layout features percentage-based.

CREATE TABLE IF NOT EXISTS layouts (
    id              TEXT PRIMARY KEY,
    user_id         TEXT REFERENCES users(id),
    team_id         TEXT,
    name            TEXT NOT NULL,
    width           INTEGER NOT NULL DEFAULT 1920,
    height          INTEGER NOT NULL DEFAULT 1080,
    is_template     INTEGER NOT NULL DEFAULT 0,
    template_category TEXT,
    thumbnail_data  TEXT,
    created_at      INTEGER NOT NULL DEFAULT (strftime('%s','now')),
    updated_at      INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);

CREATE TABLE IF NOT EXISTS layout_zones (
    id              TEXT PRIMARY KEY,
    layout_id       TEXT NOT NULL REFERENCES layouts(id) ON DELETE CASCADE,
    name            TEXT NOT NULL DEFAULT 'Zone',
    x_percent       REAL NOT NULL DEFAULT 0,
    y_percent       REAL NOT NULL DEFAULT 0,
    width_percent   REAL NOT NULL DEFAULT 100,
    height_percent  REAL NOT NULL DEFAULT 100,
    z_index         INTEGER NOT NULL DEFAULT 0,
    zone_type       TEXT NOT NULL DEFAULT 'content',
    fit_mode        TEXT NOT NULL DEFAULT 'cover',
    background_color TEXT DEFAULT '#000000',
    sort_order      INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_zones_layout ON layout_zones(layout_id);

-- Seed templates
INSERT OR IGNORE INTO layouts (id, user_id, name, is_template, template_category) VALUES
  ('tpl-fullscreen',  NULL, 'Fullscreen',           1, 'basic'),
  ('tpl-split-h',     NULL, 'Split Horizontal',     1, 'split'),
  ('tpl-split-v',     NULL, 'Split Vertical',       1, 'split'),
  ('tpl-l-bar',       NULL, 'L-Bar with Ticker',    1, 'news'),
  ('tpl-pip',         NULL, 'Picture in Picture',   1, 'overlay'),
  ('tpl-thirds',      NULL, 'Three Column',         1, 'grid'),
  ('tpl-quad',        NULL, 'Four Quadrants',       1, 'grid');

INSERT OR IGNORE INTO layout_zones (id, layout_id, name, x_percent, y_percent, width_percent, height_percent, z_index, sort_order) VALUES
  ('z-fs-1',    'tpl-fullscreen', 'Main',           0, 0, 100, 100, 0, 0),
  ('z-sh-1',    'tpl-split-h',   'Left',            0, 0, 50, 100, 0, 0),
  ('z-sh-2',    'tpl-split-h',   'Right',           50, 0, 50, 100, 0, 1),
  ('z-sv-1',    'tpl-split-v',   'Top',             0, 0, 100, 50, 0, 0),
  ('z-sv-2',    'tpl-split-v',   'Bottom',          0, 50, 100, 50, 0, 1),
  ('z-lb-1',    'tpl-l-bar',     'Main Content',    0, 0, 75, 85, 0, 0),
  ('z-lb-2',    'tpl-l-bar',     'Side Panel',      75, 0, 25, 100, 0, 1),
  ('z-lb-3',    'tpl-l-bar',     'Bottom Ticker',   0, 85, 75, 15, 1, 2),
  ('z-pip-1',   'tpl-pip',       'Background',      0, 0, 100, 100, 0, 0),
  ('z-pip-2',   'tpl-pip',       'PiP Window',      65, 5, 30, 30, 1, 1),
  ('z-th-1',    'tpl-thirds',    'Left',            0, 0, 33.33, 100, 0, 0),
  ('z-th-2',    'tpl-thirds',    'Center',          33.33, 0, 33.34, 100, 0, 1),
  ('z-th-3',    'tpl-thirds',    'Right',           66.67, 0, 33.33, 100, 0, 2),
  ('z-q-1',     'tpl-quad',      'Top Left',        0, 0, 50, 50, 0, 0),
  ('z-q-2',     'tpl-quad',      'Top Right',       50, 0, 50, 50, 0, 1),
  ('z-q-3',     'tpl-quad',      'Bottom Left',     0, 50, 50, 50, 0, 2),
  ('z-q-4',     'tpl-quad',      'Bottom Right',    50, 50, 50, 50, 0, 3);

-- ===================== WIDGETS =====================

CREATE TABLE IF NOT EXISTS widgets (
    id              TEXT PRIMARY KEY,
    user_id         TEXT REFERENCES users(id),
    team_id         TEXT,
    widget_type     TEXT NOT NULL,
    name            TEXT NOT NULL,
    config          TEXT NOT NULL DEFAULT '{}',
    created_at      INTEGER NOT NULL DEFAULT (strftime('%s','now')),
    updated_at      INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);

-- ===================== SCHEDULES =====================

CREATE TABLE IF NOT EXISTS schedules (
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

CREATE INDEX IF NOT EXISTS idx_schedules_device ON schedules(device_id, enabled);
-- Note: idx_schedules_group is created by the phase4 migration which rebuilds the table

-- ===================== VIDEO WALLS =====================

CREATE TABLE IF NOT EXISTS video_walls (
    id              TEXT PRIMARY KEY,
    user_id         TEXT NOT NULL REFERENCES users(id),
    team_id         TEXT,
    name            TEXT NOT NULL,
    grid_cols       INTEGER NOT NULL DEFAULT 2,
    grid_rows       INTEGER NOT NULL DEFAULT 2,
    bezel_h_mm      REAL NOT NULL DEFAULT 0,
    bezel_v_mm      REAL NOT NULL DEFAULT 0,
    screen_w_mm     REAL NOT NULL DEFAULT 400,
    screen_h_mm     REAL NOT NULL DEFAULT 225,
    sync_mode       TEXT NOT NULL DEFAULT 'leader',
    -- Locked walls keep their member set fixed while still allowing content
    -- routing, span/split mode changes, and per-device layout calibration.
    is_locked       INTEGER NOT NULL DEFAULT 0,
    leader_device_id TEXT REFERENCES devices(id) ON DELETE SET NULL,
    content_id      TEXT REFERENCES content(id) ON DELETE SET NULL,
    playlist_id     TEXT REFERENCES playlists(id) ON DELETE SET NULL,
    -- Free-form player rect on the wall canvas (NULL = use bounding box of screens)
    player_x        REAL,
    player_y        REAL,
    player_width    REAL,
    player_height   REAL,
    -- Versioned composable layout groups. NULL preserves legacy span/split.
    layout_json     TEXT,
    layout_revision INTEGER NOT NULL DEFAULT 0,
    created_at      INTEGER NOT NULL DEFAULT (strftime('%s','now')),
    updated_at      INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);

CREATE TABLE IF NOT EXISTS video_wall_devices (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    wall_id         TEXT NOT NULL REFERENCES video_walls(id) ON DELETE CASCADE,
    device_id       TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
    grid_col        INTEGER NOT NULL,
    grid_row        INTEGER NOT NULL,
    rotation        INTEGER NOT NULL DEFAULT 0,
    -- Free-form canvas rect (NULL = derive from grid_col/row + bezel as a fallback)
    canvas_x        REAL,
    canvas_y        REAL,
    canvas_width    REAL,
    canvas_height   REAL,
    UNIQUE(wall_id, device_id),
    UNIQUE(wall_id, grid_col, grid_row)
);

-- ===================== TEAMS =====================

CREATE TABLE IF NOT EXISTS teams (
    id              TEXT PRIMARY KEY,
    name            TEXT NOT NULL,
    owner_id        TEXT NOT NULL REFERENCES users(id),
    created_at      INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);

CREATE TABLE IF NOT EXISTS team_members (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    team_id         TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
    user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role            TEXT NOT NULL DEFAULT 'viewer',
    invited_by      TEXT REFERENCES users(id),
    joined_at       INTEGER NOT NULL DEFAULT (strftime('%s','now')),
    UNIQUE(team_id, user_id)
);

CREATE TABLE IF NOT EXISTS team_invites (
    id              TEXT PRIMARY KEY,
    team_id         TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
    email           TEXT NOT NULL,
    role            TEXT NOT NULL DEFAULT 'viewer',
    invited_by      TEXT NOT NULL REFERENCES users(id),
    expires_at      INTEGER NOT NULL,
    created_at      INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);

-- ===================== PROOF-OF-PLAY =====================

CREATE TABLE IF NOT EXISTS play_logs (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    device_id       TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
    content_id      TEXT REFERENCES content(id) ON DELETE SET NULL,
    widget_id       TEXT REFERENCES widgets(id) ON DELETE SET NULL,
    zone_id         TEXT,
    content_name    TEXT NOT NULL DEFAULT '',
    started_at      INTEGER NOT NULL,
    ended_at        INTEGER,
    duration_sec    INTEGER,
    completed       INTEGER NOT NULL DEFAULT 0,
    trigger_type    TEXT DEFAULT 'playlist',
    created_at      INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);

CREATE INDEX IF NOT EXISTS idx_play_logs_device ON play_logs(device_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_play_logs_content ON play_logs(content_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_play_logs_time ON play_logs(started_at, ended_at);

-- ===================== DEVICE GROUPS =====================

CREATE TABLE IF NOT EXISTS device_groups (
    id              TEXT PRIMARY KEY,
    user_id         TEXT NOT NULL REFERENCES users(id),
    name            TEXT NOT NULL,
    color           TEXT DEFAULT '#3B82F6',
    playlist_id     TEXT REFERENCES playlists(id) ON DELETE SET NULL,
    created_at      INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);

CREATE TABLE IF NOT EXISTS device_group_members (
    device_id       TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
    group_id        TEXT NOT NULL REFERENCES device_groups(id) ON DELETE CASCADE,
    PRIMARY KEY (device_id, group_id)
);

-- ===================== PLAYLISTS =====================

CREATE TABLE IF NOT EXISTS playlists (
    id              TEXT PRIMARY KEY,
    user_id         TEXT NOT NULL REFERENCES users(id),
    name            TEXT NOT NULL,
    description     TEXT DEFAULT '',
    is_auto_generated INTEGER NOT NULL DEFAULT 0,
    status          TEXT NOT NULL DEFAULT 'draft',
    published_snapshot TEXT,
    created_at      INTEGER NOT NULL DEFAULT (strftime('%s','now')),
    updated_at      INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);

CREATE TABLE IF NOT EXISTS playlist_items (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    playlist_id     TEXT NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
    content_id      TEXT REFERENCES content(id) ON DELETE CASCADE,
    widget_id       TEXT REFERENCES widgets(id) ON DELETE CASCADE,
    zone_id         TEXT REFERENCES layout_zones(id) ON DELETE SET NULL,
    sort_order      INTEGER NOT NULL DEFAULT 0,
    duration_sec    INTEGER NOT NULL DEFAULT 10,
    created_at      INTEGER NOT NULL DEFAULT (strftime('%s','now')),
    updated_at      INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);

-- ===================== ACTIVITY LOG =====================

CREATE TABLE IF NOT EXISTS activity_log (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id         TEXT REFERENCES users(id),
    device_id       TEXT,
    action          TEXT NOT NULL,
    details         TEXT,
    ip_address      TEXT,
    created_at      INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);

CREATE INDEX IF NOT EXISTS idx_activity_log_time ON activity_log(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_activity_log_user ON activity_log(user_id, created_at DESC);

-- ===================== EMAIL ALERTS =====================

-- ===================== WHITE LABEL =====================

CREATE TABLE IF NOT EXISTS white_labels (
    id              TEXT PRIMARY KEY,
    user_id         TEXT NOT NULL REFERENCES users(id),
    brand_name      TEXT NOT NULL DEFAULT 'Media Control',
    logo_url        TEXT,
    favicon_url     TEXT,
    primary_color   TEXT DEFAULT '#3B82F6',
    secondary_color TEXT DEFAULT '#1E293B',
    bg_color        TEXT DEFAULT '#111827',
    custom_domain   TEXT,
    custom_css      TEXT,
    hide_branding   INTEGER DEFAULT 0,
    created_at      INTEGER NOT NULL DEFAULT (strftime('%s','now')),
    updated_at      INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);

-- ===================== KIOSK PAGES =====================

CREATE TABLE IF NOT EXISTS kiosk_pages (
    id              TEXT PRIMARY KEY,
    user_id         TEXT NOT NULL REFERENCES users(id),
    name            TEXT NOT NULL,
    config          TEXT NOT NULL DEFAULT '{}',
    created_at      INTEGER NOT NULL DEFAULT (strftime('%s','now')),
    updated_at      INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);

-- ===================== DEVICE STATUS LOG =====================

CREATE TABLE IF NOT EXISTS device_status_log (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    device_id       TEXT NOT NULL,
    status          TEXT NOT NULL,
    timestamp       INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);

-- ===================== DEVICE FINGERPRINTS =====================

CREATE TABLE IF NOT EXISTS device_fingerprints (
    fingerprint     TEXT NOT NULL,
    device_id       TEXT REFERENCES devices(id) ON DELETE SET NULL,
    user_id         TEXT REFERENCES users(id),
    first_seen      INTEGER NOT NULL DEFAULT (strftime('%s','now')),
    last_seen       INTEGER NOT NULL DEFAULT (strftime('%s','now')),
    PRIMARY KEY (fingerprint)
);

CREATE TABLE IF NOT EXISTS alert_configs (
    id              TEXT PRIMARY KEY,
    user_id         TEXT NOT NULL REFERENCES users(id),
    alert_type      TEXT NOT NULL,
    enabled         INTEGER NOT NULL DEFAULT 1,
    config          TEXT NOT NULL DEFAULT '{}',
    created_at      INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);

CREATE TABLE IF NOT EXISTS device_status_log (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    device_id       TEXT NOT NULL,
    status          TEXT NOT NULL,
    timestamp       INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);

-- ===================== PLAYER DEBUG LOGS =====================
-- Smart TVs (Tizen, WebOS, Fire TV, etc.) have no accessible devtools. The
-- player captures errors into window.__debugLog client-side and POSTs them
-- to /api/player-debug. This table stores those reports. Submitter is
-- unauthenticated by design - the player may not have paired yet when an
-- error fires. device_id is nullable for unpaired players.
--
-- Capped at 10,000 rows with FIFO eviction on insert (route-side, no sweep).
-- error_fingerprint is a client-computed hash of (error message + first stack
-- frame) - indexed so a future "top N unique errors this week" query is fast
-- without a schema change.

CREATE TABLE IF NOT EXISTS player_debug_logs (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    device_id         TEXT,
    ip                TEXT,
    user_agent        TEXT,
    url               TEXT,
    error_fingerprint TEXT,
    error_data        TEXT,
    context           TEXT,
    created_at        INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);

CREATE INDEX IF NOT EXISTS idx_player_debug_fingerprint ON player_debug_logs(error_fingerprint);
CREATE INDEX IF NOT EXISTS idx_player_debug_created_at ON player_debug_logs(created_at);

-- ===================== SCHEMA MIGRATIONS =====================

CREATE TABLE IF NOT EXISTS schema_migrations (
    id              TEXT PRIMARY KEY,
    ran_at          INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);

-- ===================== MBFD MEDIA CONTROL STUDIO (2026-05-30) =====================
-- Presentation creation, AI generation, media variants, Nextcloud sync, downloads.
-- All additive (IF NOT EXISTS); workspace-scoped for multitenancy. The canonical
-- deck format is mbfd-deck-v1 stored in presentations.deck_json (the relational
-- slides/assets tables back the visual editor in a later phase).

CREATE TABLE IF NOT EXISTS presentations (
    id                  TEXT PRIMARY KEY,
    workspace_id        TEXT REFERENCES workspaces(id) ON DELETE CASCADE,
    user_id             TEXT NOT NULL REFERENCES users(id),
    title               TEXT NOT NULL,
    description         TEXT,
    theme               TEXT DEFAULT 'mbfd-command',
    canvas_profile      TEXT DEFAULT '16x9',
    deck_json           TEXT,                              -- canonical mbfd-deck-v1 document
    status              TEXT NOT NULL DEFAULT 'draft',     -- draft | published
    published_at        INTEGER,
    published_snapshot  TEXT,
    thumbnail_path      TEXT,
    created_by          TEXT REFERENCES users(id),
    created_at          INTEGER NOT NULL DEFAULT (strftime('%s','now')),
    updated_at          INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);

CREATE TABLE IF NOT EXISTS presentation_slides (
    id               TEXT PRIMARY KEY,
    presentation_id  TEXT NOT NULL REFERENCES presentations(id) ON DELETE CASCADE,
    layout_id        TEXT REFERENCES layouts(id) ON DELETE SET NULL,
    sort_order       INTEGER NOT NULL DEFAULT 0,
    slide_json       TEXT,                                 -- per-slide mbfd-deck-v1 object
    speaker_notes    TEXT,
    duration_seconds INTEGER,
    thumbnail_path   TEXT,
    created_at       INTEGER NOT NULL DEFAULT (strftime('%s','now')),
    updated_at       INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);

CREATE TABLE IF NOT EXISTS presentation_assets (
    id              TEXT PRIMARY KEY,
    presentation_id TEXT NOT NULL REFERENCES presentations(id) ON DELETE CASCADE,
    slide_id        TEXT REFERENCES presentation_slides(id) ON DELETE CASCADE,
    content_id      TEXT REFERENCES content(id) ON DELETE SET NULL,
    position_json   TEXT NOT NULL DEFAULT '{}',            -- {x,y,w,h,z}
    fit_mode        TEXT DEFAULT 'contain',
    created_at      INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);

CREATE TABLE IF NOT EXISTS presentation_exports (
    id              TEXT PRIMARY KEY,
    presentation_id TEXT NOT NULL REFERENCES presentations(id) ON DELETE CASCADE,
    export_format   TEXT NOT NULL,                         -- pdf | pptx | png | json | package
    file_path       TEXT,
    status          TEXT NOT NULL DEFAULT 'pending',
    error_msg       TEXT,
    created_at      INTEGER NOT NULL DEFAULT (strftime('%s','now')),
    completed_at    INTEGER
);

CREATE TABLE IF NOT EXISTS asset_variants (
    id               TEXT PRIMARY KEY,
    content_id       TEXT NOT NULL REFERENCES content(id) ON DELETE CASCADE,
    variant_type     TEXT NOT NULL,                        -- thumbnail | proxy | transcode
    file_path        TEXT,
    width            INTEGER,
    height           INTEGER,
    bitrate_kbps     INTEGER,
    codec            TEXT,
    duration_seconds REAL,
    created_at       INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);

CREATE TABLE IF NOT EXISTS ai_generation_jobs (
    id              TEXT PRIMARY KEY,
    workspace_id    TEXT REFERENCES workspaces(id) ON DELETE CASCADE,
    user_id         TEXT NOT NULL REFERENCES users(id),
    job_type        TEXT NOT NULL,                         -- outline|deck|rewrite_slide|speaker_notes|instructor|command|wall|repair
    model           TEXT,
    prompt          TEXT,
    presentation_id TEXT REFERENCES presentations(id) ON DELETE SET NULL,
    status          TEXT NOT NULL DEFAULT 'pending',       -- pending|running|done|error
    result_json     TEXT,
    error_msg       TEXT,
    created_at      INTEGER NOT NULL DEFAULT (strftime('%s','now')),
    completed_at    INTEGER
);

CREATE TABLE IF NOT EXISTS nextcloud_sync_jobs (
    id              TEXT PRIMARY KEY,
    workspace_id    TEXT REFERENCES workspaces(id) ON DELETE CASCADE,
    user_id         TEXT REFERENCES users(id),
    presentation_id TEXT REFERENCES presentations(id) ON DELETE SET NULL,
    content_id      TEXT REFERENCES content(id) ON DELETE SET NULL,
    nextcloud_path  TEXT NOT NULL,
    sync_direction  TEXT NOT NULL DEFAULT 'push',          -- push | pull
    status          TEXT NOT NULL DEFAULT 'pending',
    error_msg       TEXT,
    last_synced_at  INTEGER,
    created_at      INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);

CREATE TABLE IF NOT EXISTS download_jobs (
    id              TEXT PRIMARY KEY,
    workspace_id    TEXT REFERENCES workspaces(id) ON DELETE CASCADE,
    user_id         TEXT NOT NULL REFERENCES users(id),
    source_url      TEXT NOT NULL,
    title           TEXT,
    local_path      TEXT,
    content_id      TEXT REFERENCES content(id) ON DELETE SET NULL,
    status          TEXT NOT NULL DEFAULT 'pending',       -- pending|downloading|done|error
    progress_pct    INTEGER DEFAULT 0,
    error_msg       TEXT,
    started_at      INTEGER,
    completed_at    INTEGER,
    created_at      INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);

CREATE INDEX IF NOT EXISTS idx_presentations_workspace ON presentations(workspace_id);
CREATE INDEX IF NOT EXISTS idx_presentation_slides_presentation ON presentation_slides(presentation_id, sort_order);
CREATE INDEX IF NOT EXISTS idx_presentation_assets_slide ON presentation_assets(slide_id);
CREATE INDEX IF NOT EXISTS idx_asset_variants_content ON asset_variants(content_id);
CREATE INDEX IF NOT EXISTS idx_ai_jobs_workspace ON ai_generation_jobs(workspace_id, status);
CREATE INDEX IF NOT EXISTS idx_nextcloud_sync_workspace ON nextcloud_sync_jobs(workspace_id, status);
CREATE INDEX IF NOT EXISTS idx_download_jobs_workspace ON download_jobs(workspace_id, status);

-- 2026-06-01 Unified Media Control dashboard
CREATE TABLE IF NOT EXISTS dashboard_state (
    user_id        TEXT NOT NULL,
    workspace_id   TEXT NOT NULL,
    selection_json TEXT NOT NULL DEFAULT '[]',
    updated_at     INTEGER NOT NULL DEFAULT (strftime('%s','now')),
    PRIMARY KEY (user_id, workspace_id)
);

-- Persistent remote whiteboard state per display. Stop/hide does not delete this;
-- clear and media broadcasts do.
CREATE TABLE IF NOT EXISTS whiteboard_sessions (
    workspace_id  TEXT NOT NULL,
    device_id     TEXT NOT NULL,
    strokes_json  TEXT NOT NULL DEFAULT '[]',
    updated_at    INTEGER NOT NULL DEFAULT (strftime('%s','now')),
    PRIMARY KEY (workspace_id, device_id)
);

CREATE INDEX IF NOT EXISTS idx_whiteboard_sessions_device ON whiteboard_sessions(device_id);

-- Advanced coordinate canvases are additive to the legacy devices table.
-- Standard TVs continue to use devices/playlists; high-performance endpoints
-- persist their physical topology and absolute-coordinate layers here.
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

CREATE INDEX IF NOT EXISTS idx_advanced_canvas_workspace ON advanced_canvas_endpoints(workspace_id);
CREATE INDEX IF NOT EXISTS idx_advanced_canvas_layers_endpoint ON advanced_canvas_layers(endpoint_id, z_index);

-- ===================== PHASE 2: COMMAND / STATE MODEL =====================
-- Additive command (ingest/ack/timeout) event model. Rows below are written
-- ONLY by server/lib/command-model.js. Existing fire-and-forget device:command
-- emits keep working unchanged; requires_ack=0 rows are logged for audit but
-- never time out. See planning/command-center/COMMAND_EVENT_MODEL.md.

CREATE TABLE IF NOT EXISTS command_logs (
    command_id         TEXT PRIMARY KEY,
    target_type        TEXT NOT NULL,                  -- display|wall|group|node|live-program
    target_id          TEXT NOT NULL,
    command_type       TEXT NOT NULL,
    payload            TEXT,
    revision           INTEGER NOT NULL DEFAULT 0,
    parent_command_id  TEXT,                           -- set on fanned-out member rows
    issued_by          TEXT,
    created_at         INTEGER,
    requires_ack       INTEGER NOT NULL DEFAULT 0,
    ack_deadline       INTEGER,
    status             TEXT NOT NULL DEFAULT 'sent',    -- sent|acked|timeout|failed|stale|superseded
    ack_at            INTEGER,
    ack_error         TEXT
);

CREATE INDEX IF NOT EXISTS idx_command_logs_target_revision ON command_logs(target_id, revision);
CREATE INDEX IF NOT EXISTS idx_command_logs_status ON command_logs(status);

-- Last-acked playback state per target (display node). Written on device:ack
-- / device:state-report; consumed by the Command Center status chips. Kept
-- distinct from devices.screen_on (on/off) so it never clobbers the legacy flag.
CREATE TABLE IF NOT EXISTS display_states (
    target_type           TEXT NOT NULL,               -- display|node
    target_id             TEXT NOT NULL,
    workspace_id          TEXT,
    current_content_id    TEXT,
    current_asset_id      TEXT,
    content_type          TEXT,
    layout_mode           TEXT,
    slide_index           INTEGER,
    slide_count           INTEGER,
    current_time          REAL,
    duration              REAL,
    paused                INTEGER,
    muted                 INTEGER,
    volume                INTEGER,
    local_asset_ready     INTEGER,
    last_ack_at           INTEGER,
    last_heartbeat_at     INTEGER,
    render_state          TEXT,
    error_state           TEXT,
    idle_screensaver_id   TEXT,
    default_screensaver_id TEXT,
    wall_id               TEXT,
    layout_id             TEXT,
    group_id              TEXT,
    member_id             TEXT,
    playback_revision     INTEGER,
    command_revision      TEXT,
    state_revision        INTEGER NOT NULL DEFAULT 0,
    updated_at            INTEGER,
    PRIMARY KEY (target_type, target_id)
);

CREATE TABLE IF NOT EXISTS content_publication_requests (
    id                   TEXT PRIMARY KEY,
    content_id           TEXT NOT NULL REFERENCES content(id) ON DELETE CASCADE,
    requested_by         TEXT NOT NULL REFERENCES users(id),
    requested_visibility TEXT NOT NULL DEFAULT 'organization_shared'
                           CHECK (requested_visibility = 'organization_shared'),
    status               TEXT NOT NULL DEFAULT 'pending'
                           CHECK (status IN ('pending', 'approved', 'rejected', 'cancelled')),
    decided_by           TEXT REFERENCES users(id),
    decision_reason      TEXT,
    requested_version    INTEGER NOT NULL DEFAULT 1,
    requested_sha256     TEXT,
    decided_at           INTEGER,
    created_at           INTEGER NOT NULL DEFAULT (strftime('%s','now')),
    updated_at           INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);

CREATE TABLE IF NOT EXISTS content_template_assignments (
    content_id   TEXT NOT NULL REFERENCES content(id) ON DELETE CASCADE,
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    assigned_by  TEXT REFERENCES users(id),
    assigned_at  INTEGER NOT NULL DEFAULT (strftime('%s','now')),
    PRIMARY KEY (content_id, workspace_id)
);

-- Persisted global revision for the authoritative room snapshot contract.
-- A composite key keeps two control rooms in the same workspace independent,
-- while UPDATE ... revision + 1 provides a monotonic resume cursor that
-- survives server restarts.
CREATE TABLE IF NOT EXISTS room_state_revisions (
    workspace_id TEXT NOT NULL,
    room_id      TEXT NOT NULL,
    revision     INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
    last_reason  TEXT,
    created_at   INTEGER NOT NULL,
    updated_at   INTEGER NOT NULL,
    PRIMARY KEY (workspace_id, room_id)
);

CREATE INDEX IF NOT EXISTS idx_room_state_revisions_updated
    ON room_state_revisions(updated_at DESC);

-- P3/Kamrui managed-node registry. node_token is a per-node bearer (generated
-- server-side, stored hashed elsewhere); never committed in the clear.
CREATE TABLE IF NOT EXISTS managed_nodes (
    node_id          TEXT PRIMARY KEY,
    node_name        TEXT,
    node_type        TEXT,
    room_id         TEXT,
    workspace_id    TEXT,
    node_token      TEXT,
    last_heartbeat  INTEGER,
    software_version TEXT,
    free_disk       INTEGER,
    cache_size      INTEGER,
    sync_status     TEXT NOT NULL DEFAULT 'idle',
    audio_endpoint  TEXT,
    network_state_json TEXT,
    telemetry_json  TEXT,
    created_at      INTEGER,
    updated_at      INTEGER
);

-- Per-node desired asset set (asset sync ledger). PK(asset_id, node_id).
CREATE TABLE IF NOT EXISTS node_assets (
    asset_id          TEXT NOT NULL,
    node_id           TEXT NOT NULL,
    desired           INTEGER NOT NULL DEFAULT 1,
    sync_status       TEXT NOT NULL DEFAULT 'pending',
    local_path        TEXT,
    checksum_verified INTEGER NOT NULL DEFAULT 0,
    bytes_downloaded  INTEGER,
    last_attempt_at   INTEGER,
    last_success_at   INTEGER,
    error_message     TEXT,
    PRIMARY KEY (asset_id, node_id)
);

-- Canonical asset manifest: checksum + render metadata. content_id UNIQUE so
-- we have exactly one manifest row per content row (NULL-safe join). CASCADE
-- on content delete so removing media cleans its manifest.
CREATE TABLE IF NOT EXISTS asset_checksums (
    asset_id             TEXT PRIMARY KEY,
    content_id           TEXT UNIQUE REFERENCES content(id) ON DELETE CASCADE,
    sha256               TEXT,
    size_bytes           INTEGER,
    canonical_path       TEXT,
    canonical_url        TEXT,
    poster_path          TEXT,
    duration_sec         REAL,
    width                INTEGER,
    height               INTEGER,
    is_screensaver       INTEGER NOT NULL DEFAULT 0,
    screensaver_category TEXT,
    computed_at          INTEGER
);

-- Append-only node heartbeat history (analytics). Pruned periodically.
CREATE TABLE IF NOT EXISTS node_heartbeats (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    node_id          TEXT,
    ts               INTEGER,
    software_version TEXT,
    free_disk        INTEGER,
    cache_size       INTEGER,
    sync_status      TEXT,
    active_displays  TEXT,
    audio_endpoint   TEXT,
    network_state_json TEXT,
    telemetry_json  TEXT
);

CREATE INDEX IF NOT EXISTS idx_node_heartbeats_node_ts ON node_heartbeats(node_id, ts);
