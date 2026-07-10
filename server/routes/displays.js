const express = require('express');
const router = express.Router();
const { db } = require('../db/database');
const { nowPlayingFromSnapshot } = require('../lib/display-state');
const { mapDisplayRow } = require('../lib/display-row');
const config = require('../config');

function boolOrNull(value) {
  return value == null ? null : !!value;
}

function buildLiveState(row) {
  return {
    current_content_id: row.current_content_id ?? null,
    current_asset_id: row.current_asset_id ?? null,
    content_type: row.content_type ?? null,
    layout_mode: row.layout_mode ?? null,
    slide_index: row.slide_index ?? null,
    slide_count: row.slide_count ?? null,
    slide_total: row.slide_count ?? null,
    current_time: row.current_time ?? null,
    duration: row.duration ?? null,
    paused: boolOrNull(row.paused),
    muted: boolOrNull(row.muted),
    volume: row.volume ?? null,
    local_asset_ready: boolOrNull(row.local_asset_ready),
    last_ack_at: row.last_ack_at ?? null,
    last_heartbeat_at: row.last_heartbeat_at ?? null,
    render_state: row.render_state ?? null,
    error_state: row.error_state ?? null,
    idle_screensaver_id: row.idle_screensaver_id ?? null,
    default_screensaver_id: row.default_screensaver_id ?? null,
    state_updated_at: row.state_updated_at ?? null,
  };
}

function buildTelemetry(row) {
  const hasTelemetry = [
    row.battery_level, row.battery_charging, row.storage_free_mb, row.storage_total_mb,
    row.ram_free_mb, row.ram_total_mb, row.cpu_usage, row.wifi_ssid, row.wifi_rssi,
    row.uptime_seconds, row.telemetry_reported_at,
  ].some((v) => v != null);
  if (!hasTelemetry) return null;
  return {
    battery_level: row.battery_level ?? null,
    battery_charging: boolOrNull(row.battery_charging),
    storage_free_mb: row.storage_free_mb ?? null,
    storage_total_mb: row.storage_total_mb ?? null,
    ram_free_mb: row.ram_free_mb ?? null,
    ram_total_mb: row.ram_total_mb ?? null,
    cpu_usage: row.cpu_usage ?? null,
    wifi_ssid: row.wifi_ssid ?? null,
    wifi_rssi: row.wifi_rssi ?? null,
    uptime_seconds: row.uptime_seconds ?? null,
    reported_at: row.telemetry_reported_at ?? null,
  };
}

function overlayNowPlaying(nowPlaying, liveState) {
  const np = { ...(nowPlaying || {}) };
  if (liveState.current_content_id != null) np.contentId = liveState.current_content_id;
  if (liveState.current_asset_id != null) np.assetId = liveState.current_asset_id;
  if (liveState.content_type) np.kind = liveState.content_type;
  if (liveState.paused != null) np.paused = liveState.paused;
  if (liveState.slide_index != null) np.slideIndex = liveState.slide_index;
  if (liveState.current_time != null) np.currentTime = liveState.current_time;
  if (liveState.duration != null) np.duration = liveState.duration;
  if (liveState.local_asset_ready != null) np.localAssetReady = liveState.local_asset_ready;
  if (liveState.render_state) np.render_state = liveState.render_state;
  if (liveState.error_state) np.error_state = liveState.error_state;
  return np;
}

// Deny writes for read-only members (mirrors scenes.js inline gate).
function requireWorkspaceWrite(req, res) {
  if (!req.workspaceId) { res.status(400).json({ error: 'No active workspace' }); return false; }
  if (!req.actingAs && req.workspaceRole === 'workspace_viewer') {
    res.status(403).json({ error: 'Read-only access' }); return false;
  }
  return true;
}

// GET /api/displays/state — authoritative "what is live where" for the stage.
// Resolves each workspace device's published_snapshot into a now-playing
// summary, plus live state/telemetry, online status, screen_on flag,
// geometry, and last screenshot.
router.get('/state', (req, res) => {
  if (!req.workspaceId) return res.json({ displays: [] });
  const now = Math.floor(Date.now() / 1000);
  const rows = db.prepare(`
    SELECT d.id, d.name, d.status, d.last_heartbeat, d.screen_width, d.screen_height,
           d.screen_on, d.playlist_id, d.layout_id,
           p.published_snapshot AS snapshot,
           ds.current_content_id, ds.current_asset_id, ds.content_type, ds.layout_mode,
           ds.slide_index, ds.slide_count, ds.current_time, ds.duration, ds.paused, ds.muted, ds.volume,
           ds.local_asset_ready, ds.last_ack_at, ds.last_heartbeat_at, ds.render_state, ds.error_state,
           ds.idle_screensaver_id, ds.default_screensaver_id, ds.updated_at AS state_updated_at,
           t.battery_level, t.battery_charging, t.storage_free_mb, t.storage_total_mb,
           t.ram_free_mb, t.ram_total_mb, t.cpu_usage, t.wifi_ssid, t.wifi_rssi,
           t.uptime_seconds, t.reported_at AS telemetry_reported_at,
           (SELECT s.captured_at FROM screenshots s WHERE s.device_id = d.id ORDER BY s.captured_at DESC LIMIT 1) AS shot_at
    FROM devices d
    LEFT JOIN playlists p ON p.id = d.playlist_id
    LEFT JOIN display_states ds ON ds.target_type = 'display' AND ds.target_id = d.id
    LEFT JOIN (
      SELECT dt.device_id, dt.battery_level, dt.battery_charging, dt.storage_free_mb, dt.storage_total_mb,
             dt.ram_free_mb, dt.ram_total_mb, dt.cpu_usage, dt.wifi_ssid, dt.wifi_rssi, dt.uptime_seconds, dt.reported_at
      FROM device_telemetry dt
      INNER JOIN (
        SELECT device_id, MAX(reported_at) AS max_at
        FROM device_telemetry
        GROUP BY device_id
      ) latest ON dt.device_id = latest.device_id AND dt.reported_at = latest.max_at
    ) t ON t.device_id = d.id
    WHERE d.workspace_id = ?
    ORDER BY d.name COLLATE NOCASE
    LIMIT 500
  `).all(req.workspaceId);

  const assetCache = config.localContentBaseUrl
    ? { mode: 'local', base_url: config.localContentBaseUrl }
    : { mode: 'direct' };
  const displays = rows.map((r) => {
    const base = mapDisplayRow(r, nowPlayingFromSnapshot(r.snapshot), now, assetCache);
    const liveState = buildLiveState(r);
    return {
      ...base,
      ...liveState,
      now_playing: overlayNowPlaying(base.now_playing, liveState),
      telemetry: buildTelemetry(r),
    };
  });

  // Poster preview for un-capturable content. Hardware-decoded video and
  // cross-origin deck / web / YouTube iframes paint BLACK to the player's canvas
  // screenshot, so the live capture is a useless preview. When such content is
  // playing, expose the content's generated poster (the sharp image / ffmpeg
  // video-frame thumbnail made at upload, served by the public, token-less
  // /api/content/:id/thumbnail route) so the dashboard shows a real preview
  // instead of a black tile. A still image captures fine, so images keep the
  // live screenshot; anything without a generated poster falls back to it too.
  const POSTERABLE = new Set(['video', 'web', 'youtube', 'pdf', 'document']);
  const posterStmt = db.prepare('SELECT thumbnail_path FROM content WHERE id = ?');
  for (const d of displays) {
    const np = d.now_playing;
    if (np && np.contentId && POSTERABLE.has(np.kind)) {
      try {
        const c = posterStmt.get(np.contentId);
        if (c && c.thumbnail_path) np.poster_url = `/api/content/${np.contentId}/thumbnail`;
      } catch { /* leave poster_url unset → cell falls back to the live screenshot */ }
    }
  }
  res.json({ displays });
});

// GET /api/displays/selection — the per-user "what was I last controlling".
router.get('/selection', (req, res) => {
  if (!req.workspaceId) return res.json({ device_ids: [] });
  const row = db.prepare('SELECT selection_json FROM dashboard_state WHERE user_id = ? AND workspace_id = ?')
    .get(req.user.id, req.workspaceId);
  let ids = [];
  if (row) { try { ids = JSON.parse(row.selection_json) || []; } catch { ids = []; } }
  res.json({ device_ids: Array.isArray(ids) ? ids : [] });
});

// PUT /api/displays/selection { device_ids: [] } — persist the stage selection.
router.put('/selection', (req, res) => {
  if (!requireWorkspaceWrite(req, res)) return;
  const ids = Array.isArray(req.body && req.body.device_ids) ? req.body.device_ids.filter(x => typeof x === 'string') : [];
  db.prepare(`
    INSERT INTO dashboard_state (user_id, workspace_id, selection_json, updated_at)
    VALUES (?, ?, ?, strftime('%s','now'))
    ON CONFLICT(user_id, workspace_id) DO UPDATE SET selection_json = excluded.selection_json, updated_at = excluded.updated_at
  `).run(req.user.id, req.workspaceId, JSON.stringify(ids));
  res.json({ device_ids: ids });
});

module.exports = router;
