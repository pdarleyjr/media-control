const express = require('express');
const router = express.Router();
const { db } = require('../db/database');
const { nowPlayingFromSnapshot, overlayNowPlaying } = require('../lib/display-state');
const { mapDisplayRow } = require('../lib/display-row');
const { userPrefRoom } = require('../lib/socket-rooms');
const { contextFromRequest, contentVisibilityScope } = require('../lib/content-visibility');
const config = require('../config');

// The io instance is set by server.js after Socket.IO initializes (task §11
// cross-session convergence). Routes require it lazily so the module load
// order doesn't break (routes are required before io is created).
let ioInstance = null;
function setIo(io) { ioInstance = io; }

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
    wall_id: row.wall_id ?? row.device_wall_id ?? null,
    layout_id: row.state_layout_id ?? row.layout_id ?? null,
    group_id: row.group_id ?? null,
    member_id: row.member_id ?? null,
    playback_revision: row.playback_revision ?? null,
    command_revision: row.command_revision ?? null,
    state_revision: Number(row.state_revision) || 0,
    screen_on: boolOrNull(row.confirmed_screen_on),
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
           d.wall_id AS device_wall_id,
           d.screen_on, d.playlist_id, d.layout_id,
           p.published_snapshot AS snapshot,
           ds.current_content_id, ds.current_asset_id, ds.content_type, ds.layout_mode,
           ds.slide_index, ds.slide_count, ds.current_time, ds.duration, ds.paused, ds.muted, ds.volume,
           ds.local_asset_ready, ds.last_ack_at, ds.last_heartbeat_at, ds.render_state, ds.error_state,
           ds.idle_screensaver_id, ds.default_screensaver_id, ds.updated_at AS state_updated_at,
           ds.wall_id, ds.layout_id AS state_layout_id, ds.group_id, ds.member_id,
           ds.playback_revision, ds.command_revision, ds.state_revision,
           ds.screen_on AS confirmed_screen_on,
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
  // video-frame thumbnail made at upload) so the dashboard shows a real preview
  // instead of a black tile. The URL is exposed only when this requesting user
  // can read the content; otherwise the stage falls back to the authorized live
  // screenshot without issuing a doomed/private thumbnail request. Images expose
  // their thumbnail as a content-bound fallback when a device capture is delayed;
  // fresh image screenshots still win in the stage.
  const POSTERABLE = new Set(['image', 'video', 'web', 'youtube', 'pdf', 'document']);
  const posterVisibility = contentVisibilityScope(contextFromRequest(req), { alias: 'c' });
  const posterStmt = db.prepare(`SELECT c.thumbnail_path FROM content c
    WHERE c.id = ? AND ${posterVisibility.clause}`);
  for (const d of displays) {
    const np = d.now_playing;
    if (np && np.contentId && POSTERABLE.has(np.kind)) {
      try {
        const c = posterStmt.get(np.contentId, ...posterVisibility.params);
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

// ── Per-user operator navigation preferences (v2) ─────────────────────────
// GET /api/displays/control-preferences — server-authoritative operator focus
// target + customizable quick-tab pins. Keyed by user + workspace + room.
// Any authenticated workspace MEMBER may read their own preferences (viewers
// included). A local cached copy may drive fast first paint, but this endpoint
// is authoritative so preferences follow the authenticated user.
router.get('/control-preferences', (req, res) => {
  if (!req.workspaceId) return res.json(defaultControlPreferences(canonicalRoomId()));
  const roomId = canonicalRoomId();
  const row = db.prepare(
    'SELECT last_focused_target_ref, pinned_target_refs_json, revision FROM control_preferences WHERE user_id = ? AND workspace_id = ? AND room_id = ?'
  ).get(req.user.id, req.workspaceId, roomId);
  res.json(row ? parseControlPreferencesV2(row, roomId) : defaultControlPreferences(roomId));
});

// PATCH /api/displays/control-preferences — partial update of last focused
// target and/or pinned quick-tab refs. Only fields PRESENT in the body are
// updated (PATCH semantics — a field omitted from the body is never erased).
// Any authenticated workspace MEMBER may write their OWN preferences (viewers
// included — this is a personal UI setting, not operational display control).
// Supports optimistic concurrency via If-Match: revision. Never emits a player
// command. Server-side target validation rejects invalid/foreign/retired refs.
function handleControlPreferencesUpdate(req, res) {
  if (!requireWorkspaceMembership(req, res)) return;
  const roomId = canonicalRoomId();
  const body = req.body || {};

  // Validate body types early (400 for invalid shapes, not silent truncation).
  if (body.last_focused_target_ref !== undefined && body.last_focused_target_ref !== null) {
    if (typeof body.last_focused_target_ref !== 'string') {
      return res.status(400).json({ error: 'last_focused_target_ref must be a string or null' });
    }
  }
  if (body.pinned_target_refs !== undefined) {
    if (!Array.isArray(body.pinned_target_refs)) {
      return res.status(400).json({ error: 'pinned_target_refs must be an array' });
    }
    for (const ref of body.pinned_target_refs) {
      if (typeof ref !== 'string' || !ref) {
        return res.status(400).json({ error: 'pinned_target_refs must contain only non-empty strings' });
      }
    }
    if (body.pinned_target_refs.length > 32) {
      return res.status(400).json({ error: 'pinned_target_refs must not exceed 32 entries' });
    }
  }

  // Optimistic concurrency: If-Match revision.
  const ifMatch = req.headers['if-match'];
  const existing = db.prepare(
    'SELECT last_focused_target_ref, pinned_target_refs_json, revision FROM control_preferences WHERE user_id = ? AND workspace_id = ? AND room_id = ?'
  ).get(req.user.id, req.workspaceId, roomId);
  const currentRevision = existing ? existing.revision : 0;
  if (ifMatch !== undefined && String(ifMatch) !== String(currentRevision)) {
    return res.status(412).json({
      error: 'preference_revision_conflict',
      revision: currentRevision,
      current: existing ? parseControlPreferencesV2(existing, roomId) : defaultControlPreferences(roomId),
    });
  }

  // Load the complete current row (only update fields PRESENT in the body).
  const current = existing ? parseControlPreferencesV2(existing, roomId) : defaultControlPreferences(roomId);
  const next = { ...current };

  if (body.last_focused_target_ref !== undefined) {
    const ref = body.last_focused_target_ref;
    if (ref === null) {
      next.last_focused_target_ref = null;
    } else {
      // Server-side target validation: reject invalid/foreign/retired refs.
      const validated = validateTargetRef(ref, req);
      if (!validated) {
        return res.status(400).json({ error: 'invalid_target_ref', ref });
      }
      next.last_focused_target_ref = ref;
    }
  }

  if (body.pinned_target_refs !== undefined) {
    // Server-side target validation + dedup (preserve order).
    const validated = [];
    const seen = new Set();
    for (const ref of body.pinned_target_refs) {
      if (seen.has(ref)) continue; // dedup
      if (validateTargetRef(ref, req)) {
        seen.add(ref);
        validated.push(ref);
      }
      // Invalid refs are silently pruned (not rejected — a retired target
      // should disappear from pins, not block the whole save).
    }
    next.pinned_target_refs = validated;
  }

  const nextRevision = currentRevision + 1;
  db.prepare(`
    INSERT INTO control_preferences
      (user_id, workspace_id, room_id, last_focused_target_ref, pinned_target_refs_json, revision, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, strftime('%s','now'))
    ON CONFLICT(user_id, workspace_id, room_id) DO UPDATE SET
      last_focused_target_ref  = excluded.last_focused_target_ref,
      pinned_target_refs_json  = excluded.pinned_target_refs_json,
      revision                 = excluded.revision,
      updated_at               = excluded.updated_at
  `).run(
    req.user.id, req.workspaceId, roomId,
    next.last_focused_target_ref,
    JSON.stringify(next.pinned_target_refs),
    nextRevision
  );
  res.json({ ...next, revision: nextRevision });

  // Cross-session convergence (task §11): emit the updated preference to the
  // user's other open sessions so they can reconcile their quick tabs and
  // last-focused target. Scoped to the user only (not other users). Never
  // issues a physical display command.
  try {
    if (ioInstance) {
      const dashboardNs = ioInstance.of('/dashboard');
      const room = userPrefRoom(req.user.id);
      if (room) dashboardNs.to(room).emit('control-preferences-updated', { ...next, revision: nextRevision });
    }
  } catch { /* best-effort: socket sync must never break a preference save */ }
}

// Register the same handler for both PATCH (preferred) and PUT (backward-compat
// alias — same partial-update semantics).
router.patch('/control-preferences', handleControlPreferencesUpdate);
router.put('/control-preferences', handleControlPreferencesUpdate);

// ── Preference-specific authorization ─────────────────────────────────────
// Any authenticated workspace MEMBER (including viewers) may save their OWN
// navigation preferences. This is NOT operational display control — it's a
// personal UI setting. Only workspace membership is required (not write role).
function requireWorkspaceMembership(req, res) {
  if (!req.user || !req.user.id) { res.status(401).json({ error: 'Authentication required' }); return false; }
  if (!req.workspaceId) { res.status(400).json({ error: 'No active workspace' }); return false; }
  // req.workspaceRole is set by resolveTenancy for any workspace member (direct
  // or via org). A null role means the user is not a member of this workspace.
  if (!req.workspaceRole && !req.isPlatformAdmin) {
    res.status(403).json({ error: 'Not a member of this workspace' });
    return false;
  }
  return true;
}

// The canonical room ID for this deployment. The room is fixed per installation
// (config.console.roomId, default 'classroom-1'). Including it in the key
// prevents future cross-room leakage if multi-room is ever added.
function canonicalRoomId() {
  return config.console?.roomId || process.env.ROOM_ID || 'classroom-1';
}

// Server-side target reference validation. Resolves the ref against the
// requesting user's authorized workspace catalog and rejects:
//   • malformed refs (not wall:/display:/group:)
//   • nonexistent targets (not in the workspace's walls/displays/groups)
//   • retired/disabled devices
//   • livestream receiver pseudo-devices
//   • camera / non-display sources
// Returns true if the ref is valid and authorized, false otherwise.
function validateTargetRef(ref, req) {
  if (typeof ref !== 'string' || !ref) return false;
  const sep = ref.indexOf(':');
  const type = sep > 0 ? ref.slice(0, sep) : '';
  const id = sep > 0 ? ref.slice(sep + 1) : '';
  if (!type || !id) return false;

  if (type === 'wall') {
    const wall = db.prepare(
      'SELECT id, is_locked FROM video_walls WHERE id = ? AND workspace_id = ?'
    ).get(id, req.workspaceId);
    return !!wall;
  }
  if (type === 'display') {
    const dev = db.prepare(
      'SELECT id, retired, name FROM devices WHERE id = ? AND workspace_id = ?'
    ).get(id, req.workspaceId);
    if (!dev) return false;
    if (dev.retired) return false;
    // Reject camera / non-display sources by name convention.
    if (/camera/i.test(dev.name || '')) return false;
    return true;
  }
  if (type === 'group') {
    // Layout groups are wall sub-regions. Validate the group exists in a wall
    // belonging to this workspace via layout_json.
    const walls = db.prepare(
      'SELECT id, layout_json FROM video_walls WHERE workspace_id = ? AND layout_json IS NOT NULL'
    ).all(req.workspaceId);
    for (const wall of walls) {
      try {
        const layout = JSON.parse(wall.layout_json);
        if (Array.isArray(layout?.groups)) {
          if (layout.groups.some((g) => g.id === id)) return true;
        }
      } catch { /* ignore malformed layout */ }
    }
    return false;
  }
  return false;
}

function defaultControlPreferences(roomId) {
  return { room_id: roomId, last_focused_target_ref: null, pinned_target_refs: [], revision: 0 };
}

function parseControlPreferencesV2(row, roomId) {
  let pinned = [];
  try { pinned = JSON.parse(row.pinned_target_refs_json) || []; } catch { pinned = []; }
  return {
    room_id: roomId,
    last_focused_target_ref: row.last_focused_target_ref || null,
    pinned_target_refs: Array.isArray(pinned) ? pinned : [],
    revision: row.revision || 0,
  };
}

module.exports = router;
module.exports.setIo = setIo;
