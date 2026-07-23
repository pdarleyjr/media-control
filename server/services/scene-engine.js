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
const { ensureDevicePlaylist } = require('../lib/wall-playlists');
const { parseStoredLayout, groupForDevice } = require('../lib/wall-layout');
const whiteboardState = require('./whiteboard-state');
const { contentUseDecision } = require('../lib/content-visibility');

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
  else if (/\.m3u8(?:[?#]|$)/i.test(remoteUrl)) mimeType = 'application/x-mpegURL';
  else if (/^rtmp?:\/\//i.test(remoteUrl) || /^rtsp:\/\//i.test(remoteUrl)) mimeType = 'video/mp4';
  else if (/\.(jpe?g|png|gif|webp|bmp|svg|avif)(?:[?#]|$)/i.test(remoteUrl)) mimeType = 'image/jpeg';
  // YouTube URLs must use video/youtube so the player renders them via the IFrame
  // API (createYoutubeEmbed). Storing them as text/html makes the player treat
  // them as an embedded webpage, which falls through to the server-side screenshot
  // path (/player/site.html) — a frozen, silent still instead of a live video.
  else if (/(?:youtube\.com\/(?:watch|embed|v|shorts)|youtu\.be\/)/i.test(remoteUrl)) mimeType = 'video/youtube';
  else mimeType = 'text/html';
  let filename;
  try { filename = new URL(remoteUrl).hostname || 'remote'; } catch { filename = 'remote'; }
  db.prepare(`
    INSERT INTO content (id, user_id, workspace_id, filename, filepath, mime_type, file_size, remote_url, access_level)
    VALUES (?, ?, ?, ?, '', ?, 0, ?, 'private')
  `).run(id, userId || null, workspaceId || null, filename, mimeType, remoteUrl);
  return id;
}

// Emit 'device:playlist-update' (or queue it) for a single device. EXACT reuse
// of the playlist-route push path. Lazy-requires deviceSocket / command-queue
// to avoid circular requires at module load.
function pushPlaylistUpdate(io, deviceId, delivery = null) {
  try {
    if (!io) return { delivered: false };
    const { buildPlaylistPayload } = require('../ws/deviceSocket');
    const commandQueue = require('../lib/command-queue');
    const deviceNs = io.of('/device');
    const result = commandQueue.queueOrEmitPlaylistUpdate(
      deviceNs,
      deviceId,
      buildPlaylistPayload,
      delivery,
    );
    if (result && result.delivered) {
      for (const delay of [1500, 6500]) {
        const timer = setTimeout(() => deviceNs.to(deviceId).emit('device:screenshot-request', {
          reason: 'content-changed',
        }), delay);
        if (timer.unref) timer.unref();
      }
    }
    return result;
  } catch (e) {
    console.warn(`[scene-engine] pushPlaylistUpdate failed for ${deviceId}: ${e.message}`);
    return { delivered: false };
  }
}

function playbackScopeForDevice(deviceId) {
  const wall = db.prepare(`
    SELECT vw.*
    FROM video_wall_devices vwd
    JOIN video_walls vw ON vw.id = vwd.wall_id
    WHERE vwd.device_id = ?
    LIMIT 1
  `).get(deviceId);
  if (!wall) return null;

  const members = db.prepare(`
    SELECT vwd.*, d.name AS device_name, d.playlist_id
    FROM video_wall_devices vwd
    JOIN devices d ON d.id = vwd.device_id
    WHERE vwd.wall_id = ?
    ORDER BY vwd.grid_row, vwd.grid_col
  `).all(wall.id);
  const layout = parseStoredLayout(wall, members);
  return { wall, members, layout, group: groupForDevice(layout, deviceId) };
}

function persistGroupPlaylist(scope, playlistId) {
  if (!scope?.group || scope.wall.layout_mode !== 'groups' || !scope.wall.layout_json) return;
  const groups = scope.layout.groups.map((group) => (
    group.id === scope.group.id ? { ...group, playlist_id: playlistId } : group
  ));
  db.prepare(`
    UPDATE video_walls
    SET layout_json = ?, updated_at = strftime('%s','now')
    WHERE id = ?
  `).run(JSON.stringify({
    version: scope.layout.version,
    id: scope.layout.id,
    wall_id: scope.layout.wall_id,
    mode: scope.layout.mode,
    revision: scope.layout.revision,
    groups,
  }), scope.wall.id);
}

function fanOutPlaylistToPlaybackScope(
  io,
  deviceId,
  playlistId,
  {
    singleScreenOnly = false,
    allowedDeviceIds = null,
    emitFollowers = true,
  } = {},
) {
  const scope = playbackScopeForDevice(deviceId);
  if (!scope || singleScreenOnly) return;
  const allowed = Array.isArray(allowedDeviceIds)
    ? new Set(allowedDeviceIds.filter(Boolean).map(String))
    : null;

  let memberIds = [];
  if (scope.wall.layout_mode === 'groups') {
    if (!scope.group) return;
    if (scope.group.layout !== 'span' || scope.group.member_ids.length <= 1) return;
    memberIds = scope.group.member_ids.filter((id) => !allowed || allowed.has(String(id)));
    if (memberIds.length === scope.group.member_ids.length) {
      persistGroupPlaylist(scope, playlistId);
    }
  } else {
    if (scope.wall.layout_mode === 'split') return;
    const allMemberIds = scope.members.map((member) => member.device_id);
    memberIds = allMemberIds.filter((id) => !allowed || allowed.has(String(id)));
    if (memberIds.length === allMemberIds.length) {
      db.prepare("UPDATE video_walls SET playlist_id = ?, updated_at = strftime('%s','now') WHERE id = ?")
        .run(playlistId, scope.wall.id);
    }
  }

  const followers = [];
  for (const followerId of memberIds) {
    if (!followerId || followerId === deviceId) continue;
    try {
      db.prepare('UPDATE devices SET playlist_id = ? WHERE id = ? AND (playlist_id IS NULL OR playlist_id != ?)')
        .run(playlistId, followerId, playlistId);
      whiteboardState.clearForMedia(io, followerId);
      followers.push(followerId);
    } catch (error) {
      console.warn(`[scene-engine] playback-scope DB update failed for ${followerId}: ${error.message}`);
    }
  }
  if (!emitFollowers) return;
  followers.forEach((followerId, index) => {
    const deliver = () => pushPlaylistUpdate(io, followerId);
    if (index === 0) deliver();
    else {
      const timer = setTimeout(deliver, index * 100);
      if (timer.unref) timer.unref();
    }
  });
}

// Make a single device show one source. `source` is { content_id?, remote_url?,
// playlist_id?, fit_mode?, duration_sec? }. Returns true on success.
//
// playlist source  -> point devices.playlist_id at that playlist (like /assign)
// content/remote   -> replace the device's own auto-playlist with one item,
//                     publish it, point devices.playlist_id at it.
function pushSourceToDevice(io, deviceId, source, opts = {}) {
  const {
    workspaceId = null,
    userId = null,
    targetDeviceIds = null,
    contentContext = null,
    delivery = null,
    returnDetails = false,
  } = opts;
  const authoritativeTargets = Array.isArray(targetDeviceIds);
  const finish = (ok, details = {}) => (
    returnDetails
      ? {
          ok: !!ok,
          delivered: details.delivered === true,
          queued: details.queued === true,
          playlistRevision: details.playlistRevision || null,
          expectedSourceId: details.expectedSourceId || null,
          failureReason: ok ? null : (details.failureReason || 'Broadcast mutation failed'),
        }
      : !!ok
  );
  try {
    const device = db.prepare('SELECT id, workspace_id, user_id FROM devices WHERE id = ?').get(deviceId);
    if (!device) return finish(false, { failureReason: 'Display not found' });

    // --- Playlist source: reuse the assign-then-push path verbatim. ---
    if (source.playlist_id) {
      const pl = db.prepare('SELECT id, workspace_id FROM playlists WHERE id = ?').get(source.playlist_id);
      if (!pl) return finish(false, { failureReason: 'Playlist not found' });
      // Tenancy guard: playlist must be in the device's workspace (or a
      // platform template with no workspace_id).
      if (pl.workspace_id && device.workspace_id && pl.workspace_id !== device.workspace_id) {
        return finish(false, { failureReason: 'Playlist workspace mismatch' });
      }
      const playlistContent = db.prepare(`
        SELECT DISTINCT content_id FROM playlist_items
        WHERE playlist_id = ? AND content_id IS NOT NULL
      `).all(source.playlist_id);
      const callerContext = { ...(contentContext || {}), userId: contentContext?.userId || userId };
      if (playlistContent.some((item) => !contentUseDecision(
        db,
        item.content_id,
        device.workspace_id || workspaceId,
        callerContext,
      ).allowed)) return finish(false, { failureReason: 'Playlist content unavailable' });
      db.prepare('UPDATE devices SET playlist_id = ? WHERE id = ?').run(source.playlist_id, deviceId);
      whiteboardState.clearForMedia(io, deviceId);
      const dispatch = pushPlaylistUpdate(io, deviceId, delivery
        ? { ...delivery, expectedSourceId: null }
        : null);
      // Routes that supplied an authoritative physical set already loop every
      // intended member. Hidden span-wall fan-out would duplicate those emits
      // and would mutate unrequested followers for a one-display action.
      fanOutPlaylistToPlaybackScope(io, deviceId, source.playlist_id, authoritativeTargets
        ? { allowedDeviceIds: targetDeviceIds, emitFollowers: false }
        : {});
      return finish(true, dispatch);
    }

    // --- Content / remote_url source: build a one-item published playlist. ---
    let contentId = source.content_id || null;
    if (!contentId && source.remote_url) {
      contentId = resolveRemoteUrlContent(source.remote_url, device.workspace_id || workspaceId, userId || device.user_id);
    }
    if (!contentId) return finish(false, { failureReason: 'Content could not be resolved' });

    // Tenancy guard for explicit content_id.
    const decision = contentUseDecision(
      db,
      contentId,
      device.workspace_id || workspaceId,
      { ...(contentContext || {}), userId: contentContext?.userId || userId },
    );
    const content = decision.content;
    if (!content || !decision.allowed) return finish(false, { failureReason: 'Content unavailable' });

    const playlistId = ensureDevicePlaylist(deviceId, userId || device.user_id, {
      mutableDeviceIds: targetDeviceIds,
    });
    if (!playlistId) return finish(false, { failureReason: 'Display playlist unavailable' });

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

    whiteboardState.clearForMedia(io, deviceId);
    const dispatch = pushPlaylistUpdate(io, deviceId, delivery
      ? { ...delivery, expectedSourceId: contentId }
      : null);

    // ── Span-wall fan-out ────────────────────────────────────────────────────
    // Every member needs the new playlist payload. wall:sync only carries a
    // playback position; it cannot replace a follower's in-memory playlist.
    // Omitting this push left followers on arbitrary old content until a page
    // reload. Stagger the small payloads so media fetches start a fraction of a
    // second apart without sacrificing the near-instant classroom response.
    try {
      // Generic external websites stay on the single targeted screen (per the
      // classroom rule). Everything else spans the wall (playlist assignment).
      const remote = String(content.remote_url || '');
      const isInternalPlayer = /\/player\//.test(remote);
      const isStreamingMedia = /\.m3u8(?:[?#]|$)/i.test(remote)
        || /^rtmp?:\/\//i.test(remote)
        || /^rtsp:\/\//i.test(remote);
      const isSingleScreenWeb = content.mime_type === 'text/html'
        && !isInternalPlayer
        && !isStreamingMedia;
      fanOutPlaylistToPlaybackScope(io, deviceId, playlistId, authoritativeTargets
        ? {
            singleScreenOnly: isSingleScreenWeb,
            allowedDeviceIds: targetDeviceIds,
            emitFollowers: false,
          }
        : { singleScreenOnly: isSingleScreenWeb });
    } catch (e) {
      console.warn(`[scene-engine] span fan-out lookup failed: ${e.message}`);
    }
    return finish(true, { ...dispatch, expectedSourceId: contentId });
  } catch (e) {
    console.warn(`[scene-engine] pushSourceToDevice failed for ${deviceId}: ${e.message}`);
    return finish(false, { failureReason: e.message });
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

// Expand saved scene placements to the current authoritative physical players.
// A wall placement is resolved from current membership at trigger time; a
// direct display placement remains isolated. Last placement for a device wins,
// matching the existing sequential mutation semantics without duplicate emits.
function resolveSceneActions(activityId) {
  const resolved = resolveScene(activityId);
  if (!resolved) return null;
  const actions = new Map();
  const typedTargets = [];
  for (const placement of resolved.placements) {
    let deviceIds = [];
    if (placement.wall_id) {
      const wall = db.prepare(`
        SELECT id, workspace_id, layout_revision
        FROM video_walls WHERE id = ?
      `).get(placement.wall_id);
      if (!wall || wall.workspace_id !== resolved.activity.workspace_id) continue;
      deviceIds = db.prepare(`
        SELECT d.id
        FROM video_wall_devices vwd
        JOIN devices d ON d.id = vwd.device_id
        WHERE vwd.wall_id = ? AND d.workspace_id = ?
        ORDER BY vwd.grid_row, vwd.grid_col
      `).all(wall.id, resolved.activity.workspace_id).map((row) => row.id);
      if (deviceIds.length) {
        typedTargets.push({
          type: 'wall',
          id: wall.id,
          layout_revision: Number(wall.layout_revision) || 0,
        });
      }
    } else if (placement.device_id) {
      const device = db.prepare(
        'SELECT id FROM devices WHERE id = ? AND workspace_id = ?'
      ).get(placement.device_id, resolved.activity.workspace_id);
      if (device) {
        deviceIds = [device.id];
        typedTargets.push({ type: 'display', id: device.id });
      }
    }
    for (const deviceId of deviceIds) {
      actions.set(deviceId, {
        deviceId,
        scopeDeviceIds: [...deviceIds],
        source: {
          content_id: placement.content_id,
          remote_url: placement.remote_url,
          playlist_id: placement.playlist_id,
          fit_mode: placement.fit_mode,
        },
      });
    }
  }
  return {
    activity: resolved.activity,
    actions: [...actions.values()],
    typedTargets,
  };
}

// Trigger a scene: loop placements, push each to its device. Returns a summary
// { activityId, pushed, failed, total }.
function triggerScene(io, activityId, contentContext = null) {
  const resolved = resolveSceneActions(activityId);
  if (!resolved) return { activityId, pushed: 0, failed: 0, total: 0, found: false };

  const { activity, actions } = resolved;
  let pushed = 0;
  let failed = 0;

  for (const action of actions) {
    const ok = pushSourceToDevice(io, action.deviceId, action.source, {
      workspaceId: activity.workspace_id,
      userId: contentContext?.userId || activity.created_by,
      contentContext,
      targetDeviceIds: action.scopeDeviceIds,
    });
    if (ok) pushed++; else failed++;
  }

  return { activityId, pushed, failed, total: actions.length, found: true };
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
  resolveSceneActions,
  triggerScene,
  captureCurrent,
  // Exposed for the broadcast route so it reuses the exact same per-device push.
  pushSourceToDevice,
};
