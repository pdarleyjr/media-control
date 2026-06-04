// Phase 3: Operational Activities (Scenes) + Fast Broadcast engine.
//
// A "scene" (operational_activities row) is a named snapshot of which
// content/playlist shows on which display. Triggering a scene pushes each of
// its placements to the target device using the EXISTING device-content-push
// path — we do NOT invent a new player protocol.
//
// The push path reused here is the same one routes/playlists.js uses in
// `pushToDevices` / `POST /:id/assign`:
//   1. point devices.playlist_id at the playlist we want the device to show
//      (either an existing playlist for the "playlist" source, or the device's
//      own auto-playlist whose items we replace for the "content/remote_url"
//      source);
//   2. publish that playlist (status='published' + published_snapshot) so the
//      player — which reads published_snapshot in buildPlaylistPayload — sees
//      the new content;
//   3. commandQueue.queueOrEmitPlaylistUpdate(deviceNs, deviceId,
//      buildPlaylistPayload) — emits 'device:playlist-update' to the live
//      device or queues it for an offline one. Identical to the playlist route.
//
// All DB writes are wrapped in try/catch so a single bad placement can't crash
// the trigger loop or the Node process.

'use strict';

const { v4: uuidv4 } = require('uuid');
const { db } = require('../db/database');

// Mirror routes/playlists.js + routes/assignments.js snapshot select so the
// published snapshot the player consumes carries the same denormalized shape.
function buildSnapshotItems(playlistId) {
  return db.prepare(`
    SELECT pi.content_id, pi.widget_id, pi.zone_id, pi.sort_order, pi.duration_sec,
           COALESCE(pi.fit_mode, c.default_fit_mode) AS fit_mode,
           COALESCE(c.filename, w.name) as filename, c.mime_type, c.filepath, c.file_size,
           c.duration_sec as content_duration, c.remote_url,
           w.name as widget_name, w.widget_type, w.config as widget_config
    FROM playlist_items pi
    LEFT JOIN content c ON pi.content_id = c.id
    LEFT JOIN widgets w ON pi.widget_id = w.id
    WHERE pi.playlist_id = ?
    ORDER BY pi.sort_order ASC
  `).all(playlistId);
}

// Ensure the device has its OWN auto-playlist (the slot we replace for single
// content/remote_url pushes). Mirrors ensureDevicePlaylist in
// routes/assignments.js, including the workspace_id stamp.
function ensureDevicePlaylist(deviceId, userId) {
  const device = db.prepare('SELECT playlist_id, workspace_id, name, user_id FROM devices WHERE id = ?').get(deviceId);
  if (!device) return null;
  if (device.playlist_id) {
    // Verify it's a real, still-existing playlist (FK is SET NULL on delete).
    const exists = db.prepare('SELECT id FROM playlists WHERE id = ?').get(device.playlist_id);
    if (exists) return device.playlist_id;
  }
  const playlistId = uuidv4();
  db.prepare('INSERT INTO playlists (id, user_id, workspace_id, name, is_auto_generated) VALUES (?, ?, ?, ?, 1)')
    .run(playlistId, userId || device.user_id || null, device.workspace_id || null, `${device.name || 'Display'} playlist`);
  db.prepare('UPDATE devices SET playlist_id = ? WHERE id = ?').run(playlistId, deviceId);
  return playlistId;
}

// Find an existing remote_url content row in the workspace, or create one.
// Keeps the broadcast path inside the existing playlist_item->content model
// rather than inventing a new payload type. Mirrors routes/content.js POST
// /remote (empty filepath, derived mime_type).
function resolveRemoteUrlContent(remoteUrl, workspaceId, userId) {
  const existing = db.prepare(
    'SELECT id, mime_type FROM content WHERE remote_url = ? AND (workspace_id = ? OR workspace_id IS NULL) LIMIT 1'
  ).get(remoteUrl, workspaceId || null);
  if (existing) {
    // Self-heal legacy deck/presentation rows that an older resolver stored as
    // image/jpeg. Players without the /player/deck/ URL rescue render those as a
    // broken <img> (blank) — the "presentation won't play on the wall" bug. A
    // deck URL is always an embedded web page, so correct the mime in place.
    if (/\/player\/deck\//.test(remoteUrl) && existing.mime_type !== 'text/html') {
      try { db.prepare("UPDATE content SET mime_type = 'text/html' WHERE id = ?").run(existing.id); } catch (_) {}
    }
    return existing.id;
  }

  const id = uuidv4();
  // Guess the media type from the URL so the player picks the right renderer.
  // Video extension -> video; image extension -> image; ANYTHING ELSE (a deck /
  // presentation player page, or any other web URL) is an embedded WEB PAGE the
  // player must IFRAME — NOT a still image. Defaulting to image/jpeg made the
  // player build <img src="…/player/deck/…"> against an HTML page, which renders
  // blank — the "presentation/deck won't play on the wall" bug.
  let mimeType;
  if (/\.(mp4|webm|mkv|avi|mov|m4v)(?:[?#]|$)/i.test(remoteUrl)) mimeType = 'video/mp4';
  else if (/\.(jpe?g|png|gif|webp|bmp|svg|avif)(?:[?#]|$)/i.test(remoteUrl)) mimeType = 'image/jpeg';
  else mimeType = 'text/html';
  let filename;
  try { filename = new URL(remoteUrl).hostname || 'remote'; } catch { filename = 'remote'; }
  db.prepare(`
    INSERT INTO content (id, user_id, workspace_id, filename, filepath, mime_type, file_size, remote_url)
    VALUES (?, ?, ?, ?, '', ?, 0, ?)
  `).run(id, userId || null, workspaceId || null, filename, mimeType, remoteUrl);
  return id;
}

// Emit 'device:playlist-update' (or queue it) for a single device. EXACT reuse
// of the playlist-route push path. Lazy-requires deviceSocket / command-queue
// to avoid circular requires at module load.
function pushPlaylistUpdate(io, deviceId) {
  try {
    if (!io) return { delivered: false };
    const { buildPlaylistPayload } = require('../ws/deviceSocket');
    const commandQueue = require('../lib/command-queue');
    return commandQueue.queueOrEmitPlaylistUpdate(io.of('/device'), deviceId, buildPlaylistPayload);
  } catch (e) {
    console.warn(`[scene-engine] pushPlaylistUpdate failed for ${deviceId}: ${e.message}`);
    return { delivered: false };
  }
}

// Make a single device show one source. `source` is { content_id?, remote_url?,
// playlist_id?, fit_mode?, duration_sec? }. Returns true on success.
//
// playlist source  -> point devices.playlist_id at that playlist (like /assign)
// content/remote   -> replace the device's own auto-playlist with one item,
//                     publish it, point devices.playlist_id at it.
function pushSourceToDevice(io, deviceId, source, opts = {}) {
  const { workspaceId = null, userId = null } = opts;
  try {
    const device = db.prepare('SELECT id, workspace_id, user_id FROM devices WHERE id = ?').get(deviceId);
    if (!device) return false;

    // --- Playlist source: reuse the assign-then-push path verbatim. ---
    if (source.playlist_id) {
      const pl = db.prepare('SELECT id, workspace_id FROM playlists WHERE id = ?').get(source.playlist_id);
      if (!pl) return false;
      // Tenancy guard: playlist must be in the device's workspace (or a
      // platform template with no workspace_id).
      if (pl.workspace_id && device.workspace_id && pl.workspace_id !== device.workspace_id) return false;
      db.prepare('UPDATE devices SET playlist_id = ? WHERE id = ?').run(source.playlist_id, deviceId);
      pushPlaylistUpdate(io, deviceId);
      return true;
    }

    // --- Content / remote_url source: build a one-item published playlist. ---
    let contentId = source.content_id || null;
    if (!contentId && source.remote_url) {
      contentId = resolveRemoteUrlContent(source.remote_url, device.workspace_id || workspaceId, userId || device.user_id);
    }
    if (!contentId) return false;

    // Tenancy guard for explicit content_id.
    const content = db.prepare('SELECT id, workspace_id FROM content WHERE id = ?').get(contentId);
    if (!content) return false;
    if (content.workspace_id && device.workspace_id && content.workspace_id !== device.workspace_id) return false;

    const playlistId = ensureDevicePlaylist(deviceId, userId || device.user_id);
    if (!playlistId) return false;

    const fitMode = typeof source.fit_mode === 'string' && source.fit_mode ? source.fit_mode : null;
    const duration = (typeof source.duration_sec === 'number' && source.duration_sec >= 1)
      ? Math.round(source.duration_sec) : 10;

    const tx = db.transaction(() => {
      db.prepare('DELETE FROM playlist_items WHERE playlist_id = ?').run(playlistId);
      db.prepare(`
        INSERT INTO playlist_items (playlist_id, content_id, sort_order, duration_sec, fit_mode)
        VALUES (?, ?, 0, ?, ?)
      `).run(playlistId, contentId, duration, fitMode);
      const snapshot = buildSnapshotItems(playlistId);
      db.prepare("UPDATE playlists SET status = 'published', published_snapshot = ?, updated_at = strftime('%s','now') WHERE id = ?")
        .run(JSON.stringify(snapshot), playlistId);
      db.prepare('UPDATE devices SET playlist_id = ? WHERE id = ?').run(playlistId, deviceId);
    });
    tx();

    pushPlaylistUpdate(io, deviceId);
    return true;
  } catch (e) {
    console.warn(`[scene-engine] pushSourceToDevice failed for ${deviceId}: ${e.message}`);
    return false;
  }
}

// Resolve a scene to its row + placements. Returns null if not found.
function resolveScene(activityId) {
  try {
    const activity = db.prepare('SELECT * FROM operational_activities WHERE id = ?').get(activityId);
    if (!activity) return null;
    const placements = db.prepare(
      'SELECT * FROM activity_asset_placements WHERE activity_id = ? ORDER BY sort_order ASC, id ASC'
    ).all(activityId);
    return { activity, placements };
  } catch (e) {
    console.warn(`[scene-engine] resolveScene failed for ${activityId}: ${e.message}`);
    return null;
  }
}

// Trigger a scene: loop placements, push each to its device. Returns a summary
// { activityId, pushed, failed, total }.
function triggerScene(io, activityId) {
  const resolved = resolveScene(activityId);
  if (!resolved) return { activityId, pushed: 0, failed: 0, total: 0, found: false };

  const { activity, placements } = resolved;
  let pushed = 0;
  let failed = 0;

  for (const p of placements) {
    if (!p.device_id) { failed++; continue; }
    const ok = pushSourceToDevice(io, p.device_id, {
      content_id: p.content_id,
      remote_url: p.remote_url,
      playlist_id: p.playlist_id,
      fit_mode: p.fit_mode,
    }, { workspaceId: activity.workspace_id, userId: activity.created_by });
    if (ok) pushed++; else failed++;
  }

  return { activityId, pushed, failed, total: placements.length, found: true };
}

// Capture the current state of the given devices into a NEW scene. Reads each
// device's current playlist_id and records a placement referencing that
// playlist. Returns the new activity row (or null on failure).
function captureCurrent(workspaceId, createdBy, name, deviceIds) {
  try {
    if (!workspaceId) return null;
    const activityId = uuidv4();
    const now = Math.floor(Date.now() / 1000);

    const tx = db.transaction(() => {
      db.prepare(`
        INSERT INTO operational_activities (id, workspace_id, name, description, created_by, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(activityId, workspaceId, (name || 'Captured scene'), null, createdBy || null, now, now);

      const ids = Array.isArray(deviceIds) ? deviceIds : [];
      let sort = 0;
      const insertPlacement = db.prepare(`
        INSERT INTO activity_asset_placements
          (id, activity_id, device_id, playlist_id, sort_order)
        VALUES (?, ?, ?, ?, ?)
      `);
      for (const deviceId of ids) {
        // Only capture devices that belong to this workspace.
        const device = db.prepare('SELECT id, playlist_id, workspace_id FROM devices WHERE id = ?').get(deviceId);
        if (!device || device.workspace_id !== workspaceId) continue;
        insertPlacement.run(uuidv4(), activityId, deviceId, device.playlist_id || null, sort++);
      }
    });
    tx();

    return db.prepare('SELECT * FROM operational_activities WHERE id = ?').get(activityId);
  } catch (e) {
    console.warn(`[scene-engine] captureCurrent failed: ${e.message}`);
    return null;
  }
}

module.exports = {
  resolveScene,
  triggerScene,
  captureCurrent,
  // Exposed for the broadcast route so it reuses the exact same per-device push.
  pushSourceToDevice,
};
