const { v4: uuidv4 } = require('uuid');
const crypto = require('crypto');
const deviceContract = require('../player/device-contract');
const path = require('path');
const fs = require('fs');
const { db, pruneTelemetry, pruneScreenshots } = require('../db/database');
const config = require('../config');
const heartbeat = require('../services/heartbeat');
const commandQueue = require('../lib/command-queue');
const {
  audioPolicyHeartbeatDecision,
  commonAudioPolicyFromAssignments,
  policyForDevice,
  storedAudioPolicyForDevice,
} = require('../lib/audio-ownership');
const { withLocalAssetUrls, withClassroomCacheUrls, withPublicContentAssetUrls } = require('../lib/local-asset-url');
const { profileForDevice, isClassroom1Smartboard } = require('../lib/display-profiles');
const whiteboardState = require('../services/whiteboard-state');
const {
  ensureAudioOwnershipAfterReconnect,
  recoverAudioOwnershipAfterLoss,
} = require('../lib/audio-owner-recovery');

// Debounce window for marking a device offline on socket disconnect. Brief
// flap (Wi-Fi blip, Engine.IO ping miss, server-side eviction-then-reconnect)
// shouldn't toggle the dashboard. If a fresh register lands within this
// window, the pending offline transition is cancelled. Per-device timer is
// stored here; cleared by the register handlers and by stale-disconnect
// guards. In-memory only - the heartbeat checker is the safety net for
// server-restart-during-grace-window edge cases (any 'online' rows whose
// last_heartbeat is older than heartbeatTimeout get marked offline by the
// next checker sweep within heartbeatInterval).
const pendingOfflines = new Map();
const OFFLINE_DEBOUNCE_MS = 5000;
// Phase 2.3: deviceRoom() resolves a device_id to its workspace room so
// dashboardNs.emit can be scoped instead of broadcast platform-wide.
const {
  deviceRoom,
  emitToWorkspace,
  targetRoomsForDevice,
  displayRoom,
  roomStateRoom,
  workspaceRoom,
} = require('../lib/socket-rooms');
const commandModel = require('../lib/command-model');
const { getBroadcastDeliveryStore } = require('../lib/broadcast-delivery');
const broadcastDelivery = getBroadcastDeliveryStore(db);
const nodeRegistry = require('../lib/node-registry');
const { recordPreparationResult } = require('../lib/classroom-preparation');
const { attachCaptionsToItems } = require('../lib/content-captions');
const {
  bindEnrollmentFingerprint,
  findReusablePendingEnrollment,
  pairingCodeExpiresAt,
} = require('../lib/device-enrollment');
const { parseStoredLayout, groupForDevice, resolveEffectiveLayoutLeaders } = require('../lib/wall-layout');
const { buildUniversalWallGeometry, buildLayoutAssignment } = require('../lib/wall-geometry');
const { createRoomSnapshot, scheduleRoomSnapshot } = require('../lib/room-state-broadcaster');
const {
  isProgramReceiverId,
  programReceiverEventGuard,
  resolveProgramReceiverSnapshotTarget,
} = require('../lib/program-receiver-policy');
const {
  managedComputerRouteFailureDetailInPlaylistItems,
} = require('../lib/managed-computer-routing');

function emitToDeviceWorkspace(dashboardNs, deviceId, event, payload) {
  emitToWorkspace(dashboardNs, deviceRoom(deviceId), event, payload);
}

function emitToDeviceTargetAndWorkspace(dashboardNs, deviceId, event, payload) {
  const rooms = Array.from(new Set([displayRoom(deviceId), deviceRoom(deviceId)].filter(Boolean)));
  if (!rooms.length) return;
  try {
    let op = dashboardNs;
    for (const room of rooms) op = op.to(room);
    op.emit(event, payload);
  } catch (_) {
    // Dashboard fanout is best-effort; device handling must keep running.
  }
}

function scheduleDeviceRoomSnapshot(io, deviceId, reason) {
  if (!io || !deviceId) return null;
  try {
    const device = db.prepare('SELECT workspace_id FROM devices WHERE id = ?').get(deviceId);
    if (!device?.workspace_id) return null;
    return scheduleRoomSnapshot(io, {
      workspaceId: device.workspace_id,
      roomId: config.console?.roomId,
      reason,
    });
  } catch (error) {
    console.warn(`[room-state] could not schedule ${reason || 'device transition'} for ${deviceId}: ${error.message}`);
    return null;
  }
}

const audioRecoveryFlights = new Map();

function audioRecoveryFlightKey(deviceId) {
  const policy = storedAudioPolicyForDevice(db, deviceId);
  return policy
    ? `${policy.source_key || policy.content_instance_id || policy.transaction_id}:${policy.revision}`
    : `device:${deviceId}`;
}

function runAudioRecoveryOnce(deviceId, recover) {
  const key = audioRecoveryFlightKey(deviceId);
  const active = audioRecoveryFlights.get(key);
  if (active) return active;
  const pending = Promise.resolve().then(recover).finally(() => {
    if (audioRecoveryFlights.get(key) === pending) audioRecoveryFlights.delete(key);
  });
  audioRecoveryFlights.set(key, pending);
  return pending;
}

function waitForAudioOwnerRecovery(deviceId) {
  return audioRecoveryFlights.get(audioRecoveryFlightKey(deviceId)) || null;
}

function recoverLostAudioOwner(deviceNs, deviceId) {
  return runAudioRecoveryOnce(deviceId, () => recoverAudioOwnershipAfterLoss({
    database: db,
    namespace: deviceNs,
    lostDeviceId: deviceId,
    buildPayload: buildPlaylistPayload,
    emitPolicyUpdate: (targetDeviceId) => commandQueue.queueOrEmitPlaylistUpdate(
      deviceNs,
      targetDeviceId,
      buildPlaylistPayload,
    ),
  }));
}

function ensureAudioOwnerAfterReconnect(deviceNs, deviceId) {
  return runAudioRecoveryOnce(deviceId, () => ensureAudioOwnershipAfterReconnect({
    database: db,
    namespace: deviceNs,
    deviceId,
    buildPayload: buildPlaylistPayload,
    emitPolicyUpdate: (targetDeviceId) => commandQueue.queueOrEmitPlaylistUpdate(
      deviceNs,
      targetDeviceId,
      buildPlaylistPayload,
    ),
  }));
}

function pushEffectiveWallLeadership(deviceNs, wallId, exceptDeviceId = null) {
  if (!wallId) return;
  const members = db.prepare('SELECT device_id FROM video_wall_devices WHERE wall_id = ?').all(wallId);
  for (const member of members) {
    if (member.device_id !== exceptDeviceId) {
      commandQueue.queueOrEmitPlaylistUpdate(deviceNs, member.device_id, buildPlaylistPayload);
    }
  }
}

// Phase 2: have a device socket join its per-target rooms (display:<id>,
// wall:<wallId>, group:<groupId>) in addition to the existing workspace room
// and its own deviceId room. Idempotent (Socket.IO join on an already-joined
// room is a no-op). Best-effort — wall/group backfill may have run before the
// device row existed, so re-resolve every register instead of caching.
function joinDeviceTargetRooms(socket, deviceId) {
  if (!deviceId || !socket) return;
  try {
    socket.join(displayRoom(deviceId));
    for (const room of targetRoomsForDevice(deviceId)) {
      if (room) socket.join(room);
    }
  } catch (e) {
    console.warn(`joinDeviceTargetRooms failed for ${deviceId}: ${e.message}`);
  }
}

// In-memory store for the latest screenshot per device, used for offline snapshots.
let lastScreenshots = {};
// Serialize writes per device without blocking the Node event loop. A player
// reconnect can deliver several screenshots within a few seconds; synchronous
// filesystem writes here previously stalled every HTTP and Socket.IO client.
const screenshotPersistChains = new Map();

function screenshotFilename(deviceId) {
  const safeId = String(deviceId || '').replace(/[^a-zA-Z0-9_-]/g, '_');
  return `${safeId}_latest.jpg`;
}

async function persistScreenshot(deviceId, imageB64, capturedAt) {
  const previous = screenshotPersistChains.get(deviceId) || Promise.resolve();
  const pending = previous.catch(() => {}).then(async () => {
    const buffer = Buffer.from(imageB64, 'base64');
    const filename = screenshotFilename(deviceId);
    const finalPath = path.join(config.screenshotsDir, filename);
    const temporaryPath = `${finalPath}.${process.pid}.${crypto.randomUUID()}.tmp`;
    const receivedAt = Math.floor(Date.now() / 1000);
    const requestedAt = Number(capturedAt);
    const capturedAtSeconds = Number.isFinite(requestedAt)
      ? Math.min(receivedAt, Math.floor(requestedAt > 1e12 ? requestedAt / 1000 : requestedAt))
      : receivedAt;
    const existing = db.prepare('SELECT id, captured_at FROM screenshots WHERE device_id = ? ORDER BY captured_at DESC LIMIT 1').get(deviceId);
    if (existing && Number(existing.captured_at) > capturedAtSeconds) {
      return { applied: false, reason: 'stale_screenshot', captured_at: Number(existing.captured_at) };
    }

    await fs.promises.mkdir(config.screenshotsDir, { recursive: true });
    try {
      await fs.promises.writeFile(temporaryPath, buffer);
      await fs.promises.rename(temporaryPath, finalPath);
    } finally {
      await fs.promises.unlink(temporaryPath).catch(() => {});
    }

    if (existing) {
      db.prepare('UPDATE screenshots SET filepath = ?, captured_at = ? WHERE id = ?').run(filename, capturedAtSeconds, existing.id);
    } else {
      db.prepare('INSERT INTO screenshots (device_id, filepath, captured_at) VALUES (?, ?, ?)').run(deviceId, filename, capturedAtSeconds);
    }
    pruneScreenshots(deviceId);
    return { applied: true, captured_at: capturedAtSeconds };
  });
  screenshotPersistChains.set(deviceId, pending);
  try {
    return await pending;
  } finally {
    if (screenshotPersistChains.get(deviceId) === pending) {
      screenshotPersistChains.delete(deviceId);
    }
  }
}

// Generate a random device token
function generateDeviceToken() {
  return crypto.randomBytes(32).toString('hex');
}

// Validate device_id + device_token pair. Returns true if valid.
function validateDeviceToken(deviceId, token) {
  if (!deviceId || !token) return false;
  const row = db.prepare('SELECT device_token FROM devices WHERE id = ?').get(deviceId);
  if (!row || !row.device_token) return false;
  // Constant-time comparison to prevent timing attacks
  try {
    return crypto.timingSafeEqual(Buffer.from(row.device_token), Buffer.from(token));
  } catch {
    return false;
  }
}

function getClientIp(socket) {
  const forwarded = socket.handshake.headers['x-forwarded-for'];
  if (forwarded) return forwarded.split(',')[0].trim();
  return socket.handshake.address;
}

function logDeviceStatus(deviceId, status) {
  try {
    db.prepare('INSERT INTO device_status_log (device_id, status) VALUES (?, ?)').run(deviceId, status);
    // Prune entries older than 7 days
    db.prepare("DELETE FROM device_status_log WHERE device_id = ? AND timestamp < strftime('%s','now') - 604800").run(deviceId);
  } catch (e) { /* table might not exist yet */ }
}


// Classroom-only local cache scoping. A device qualifies ONLY when the feature
// is enabled AND it belongs to one of the configured classroom video walls.
// This is deliberately membership-scoped (not workspace-scoped) so a different
// room's wall in the SAME workspace (e.g. the EOC wall) is never rerouted, and
// adding displays anywhere else is unaffected. Computed per call against the
// small video_wall_devices table; empty wallIds (default) => always false.
function isClassroomCacheDevice(deviceId) {
  try {
    const cc = config.classroomCache;
    if (!cc || !cc.enabled || !deviceId) return false;
    if (!Array.isArray(cc.wallIds) || cc.wallIds.length === 0) return false;
    const placeholders = cc.wallIds.map(() => '?').join(',');
    const row = db.prepare(
      `SELECT 1 FROM video_wall_devices WHERE device_id = ? AND wall_id IN (${placeholders}) LIMIT 1`
    ).get(deviceId, ...cc.wallIds);
    return !!row;
  } catch (e) {
    return false;
  }
}

function displayStateForDevice(deviceId) {
  if (!deviceId) return null;
  const row = db.prepare(`
    SELECT current_content_id, current_asset_id, content_type, layout_mode,
            slide_index, slide_count, current_time, duration, paused, muted, operator_muted, volume,
           local_asset_ready, render_state, error_state, screen_on, state_revision, updated_at
           , wall_id, layout_id, group_id, member_id, playback_revision, command_revision
    FROM display_states
    WHERE target_type = 'display' AND target_id = ?
  `).get(deviceId);
  if (!row) return null;
  return {
    current_content_id: row.current_content_id || null,
    current_asset_id: row.current_asset_id || null,
    content_type: row.content_type || null,
    layout_mode: row.layout_mode || null,
    slide_index: row.slide_index ?? null,
    slide_count: row.slide_count ?? null,
    slide_total: row.slide_count ?? null,
    current_time: row.current_time ?? null,
    duration: row.duration ?? null,
    paused: row.paused == null ? null : !!row.paused,
    muted: row.muted == null ? null : !!row.muted,
    operator_muted: row.operator_muted == null ? null : !!row.operator_muted,
    volume: row.volume ?? null,
    local_asset_ready: row.local_asset_ready ?? null,
    render_state: row.render_state || null,
    error_state: row.error_state || null,
    screen_on: row.screen_on == null ? null : row.screen_on !== 0,
    wall_id: row.wall_id || null,
    layout_id: row.layout_id || null,
    group_id: row.group_id || null,
    member_id: row.member_id || deviceId,
    playback_revision: Number(row.playback_revision) || 0,
    command_revision: row.command_revision || null,
    state_revision: Number(row.state_revision) || 0,
    updated_at: row.updated_at ?? null,
    restore_source: 'display',
    restore_source_device_id: deviceId,
  };
}

function restoreStateForDevice(deviceId, device, wall, layoutGroup) {
  const ownState = displayStateForDevice(deviceId);
  const leaderDeviceId = layoutGroup?.layout === 'span' && layoutGroup.member_ids.length > 1
    ? layoutGroup.leader_device_id
    : null;
  if (!device?.wall_id || !wall || !leaderDeviceId || leaderDeviceId === deviceId) {
    return ownState;
  }

  const leaderState = displayStateForDevice(leaderDeviceId);
  if (!leaderState || leaderState.slide_index == null) return ownState;

  // In span-wall mode the leader is authoritative for document/deck page
  // position. Only borrow it when it is clearly the same content; otherwise a
  // stale leader row could jump a reconnecting member to the wrong deck.
  if (ownState?.current_content_id && leaderState.current_content_id && ownState.current_content_id !== leaderState.current_content_id) {
    return ownState;
  }
  return {
    ...leaderState,
    // Slide position is group-authoritative, but optimistic state revisions
    // are per renderer. A follower must rebase from its own persisted counter
    // after a kiosk reload or every new report can be rejected as stale.
    state_revision: ownState?.state_revision ?? leaderState.state_revision,
    // Operator mute is renderer-local intent. A leader's mute must not become
    // a follower's stored preference merely because its continuity state is
    // borrowed for a span wall.
    operator_muted: ownState?.operator_muted ?? null,
    restore_source: 'layout_group_leader',
    restore_source_device_id: leaderDeviceId,
    wall_id: wall.id,
    layout_id: `${wall.id}:layout:${Number(wall.layout_revision) || 0}`,
    group_id: layoutGroup.id,
    member_id: deviceId,
  };
}

// Build playlist payload with layout and zones
// Reads from published_snapshot (Phase 3) so draft edits don't affect live devices
function blockedPlaylistPayload(device, failure) {
  const payload = {
    assignments: [],
    // Do not use the account-suspension branch here. The player deliberately
    // returns early for suspended accounts, whereas a normal empty playlist
    // applies audio_policy:null and tears down the current media element.
    delivery_blocked: true,
    delivery_block_code: failure.code,
    delivery_block_reason: failure.message,
    orientation: device?.orientation || 'landscape',
    layout: null,
    wall_config: null,
    layout_assignment: null,
    wall_layout: null,
    layout_context: null,
    device_geometry: {
      width: device?.screen_width || null,
      height: device?.screen_height || null,
      refresh_rate_hz: device?.refresh_rate_hz || null,
      auto_detected: !!device?.auto_detect_resolution,
    },
    display_profile: profileForDevice(device),
    audio_policy: null,
  };
  payload.playlist_revision = crypto.createHash('sha256').update(JSON.stringify({
    assignments: payload.assignments,
    delivery_block_code: payload.delivery_block_code,
    delivery_block_reason: payload.delivery_block_reason,
    orientation: payload.orientation,
    device_geometry: payload.device_geometry,
  })).digest('hex').slice(0, 24);
  return payload;
}

function buildPlaylistPayload(deviceId, delivery = null) {
  const device = db.prepare('SELECT id, name, playlist_id, layout_id, orientation, wall_id, screen_width, screen_height, refresh_rate_hz, auto_detect_resolution FROM devices WHERE id = ?').get(deviceId);

  let assignments = [];
  if (device?.playlist_id) {
    const playlist = db.prepare('SELECT published_snapshot FROM playlists WHERE id = ?').get(device.playlist_id);
    if (playlist?.published_snapshot) {
      try { assignments = JSON.parse(playlist.published_snapshot); } catch (e) { assignments = []; }
    }
    // 2026-05-28: Republish-from-snapshot drops fit_mode (added after the
    // initial snapshot schema). Backfill from playlist_items so existing
    // published playlists pick up per-item fit_mode without needing a
    // re-publish.
    try {
      const liveItems = db.prepare(`
        SELECT content_id, widget_id, sort_order, fit_mode
        FROM playlist_items WHERE playlist_id = ?
      `).all(device.playlist_id);
      const byKey = new Map();
      for (const li of liveItems) {
        const key = (li.content_id || '') + '|' + (li.widget_id || '') + '|' + li.sort_order;
        byKey.set(key, li.fit_mode);
      }
      for (const a of assignments) {
        if (a.fit_mode == null) {
          const key = (a.content_id || '') + '|' + (a.widget_id || '') + '|' + a.sort_order;
          if (byKey.has(key)) a.fit_mode = byKey.get(key);
        }
      }
    } catch (e) { /* live backfill is best-effort */ }

    // The published snapshot is a durable delivery boundary. It can be
    // reconstructed during reconnect, a queued flush, a sync repair, or a
    // legacy assignment writer, so recheck managed computer health here even
    // when a route already preflighted the original send.
    const managedComputerFailure = managedComputerRouteFailureDetailInPlaylistItems(assignments);
    if (managedComputerFailure) return blockedPlaylistPayload(device, managedComputerFailure);

    assignments = attachCaptionsToItems(db, assignments);

    // Asset URL resolution. Classroom-wall displays (when the feature is enabled)
    // get a read-through local-cache URL pointed at their on-box room-agent;
    // everyone else keeps the existing LAN/public-content behavior. The player
    // has an automatic origin fallback, so the local rewrite can never blank a
    // wall if the cache is down or cold.
    if (isClassroomCacheDevice(deviceId)) {
      assignments = withPublicContentAssetUrls(
        withClassroomCacheUrls(assignments, config.classroomCache.baseUrl)
      );
    } else {
      assignments = withPublicContentAssetUrls(
        withLocalAssetUrls(assignments, config.localContentBaseUrl)
      );
    }
  }

  const commonAudioPolicy = commonAudioPolicyFromAssignments(assignments);

  let layout = null;
  if (device?.layout_id) {
    layout = db.prepare('SELECT * FROM layouts WHERE id = ?').get(device.layout_id);
    if (layout) {
      layout.zones = db.prepare('SELECT * FROM layout_zones WHERE layout_id = ? ORDER BY sort_order').all(layout.id);
    }
  }

  // Wall membership flips the player into wall mode. The renderer needs two
  // rectangles in canvas-space: this device's screen rect, and the wall's
  // player rect. The intersection is what this screen displays. The leader
  // drives playback; followers track via wall:sync.
  let wall_config = null;
  let wall = null;
  let wallLayout = null;
  let layoutGroup = null;
  let layoutAssignment = null;
  if (device?.wall_id) {
    wall = db.prepare('SELECT * FROM video_walls WHERE id = ?').get(device.wall_id);
    const pos = db.prepare('SELECT * FROM video_wall_devices WHERE wall_id = ? AND device_id = ?').get(device.wall_id, deviceId);
    const allMembers = wall ? db.prepare(`
      SELECT vwd.*, d.name AS device_name, d.playlist_id, d.status,
             d.screen_width, d.screen_height
      FROM video_wall_devices vwd JOIN devices d ON d.id = vwd.device_id
      WHERE vwd.wall_id = ? ORDER BY vwd.grid_row, vwd.grid_col
    `).all(wall.id) : [];
    wallLayout = wall ? resolveEffectiveLayoutLeaders(parseStoredLayout(wall, allMembers), allMembers) : null;
    layoutGroup = groupForDevice(wallLayout, deviceId);
    if (
      wall
      && String(wall.layout_mode || '') === 'split'
      && allMembers.length === 1
      && Array.isArray(wallLayout?.regions)
      && wallLayout.regions.length > 0
    ) {
      // A Mosaic wall is one physical player with several authoritative logical
      // destinations. Project the persisted wall regions into the existing
      // percentage-zone player protocol while retaining both stable identities.
      layout = {
        id: wallLayout.id,
        name: `${wall.name || wall.id} Mosaic regions`,
        width: 100,
        height: 100,
        wall_id: wall.id,
        layout_revision: wallLayout.revision,
        authoritative_regions: true,
        zones: wallLayout.regions
          .filter((region) => region.enabled !== false && region.player_device_id === deviceId)
          .map((region, index) => ({
            id: region.zone_id,
            region_id: region.id,
            name: region.name,
            x_percent: region.x,
            y_percent: region.y,
            width_percent: region.width,
            height_percent: region.height,
            z_index: region.z_index,
            fit_mode: region.fit_mode,
            sort_order: index,
          })),
      };
    }
    if (wall && pos && layoutGroup) {
      // Canvas fallback now comes from each actual panel geometry. Calibrated
      // canvas_* values still win; mixed-resolution seams convert physical
      // bezel millimetres with a symmetric, deterministic density rule.
      const isFullWallGroup = layoutGroup.member_ids.length === allMembers.length;
      const geometry = buildUniversalWallGeometry({
        wall,
        members: allMembers,
        memberIds: layoutGroup.member_ids,
        deviceId,
        useExplicitPlayerRect: isFullWallGroup && layoutGroup.layout === 'span',
      });
      const restoredContentId = displayStateForDevice(deviceId)?.current_content_id || null;
      const selectedAssignment = assignments.find((item) => item.content_id && item.content_id === restoredContentId)
        || assignments[0]
        || null;
      layoutAssignment = buildLayoutAssignment({
        layoutId: wallLayout.id,
        layoutRevision: wallLayout.revision,
        contentId: wall.content_id || selectedAssignment?.content_id || restoredContentId || null,
        fitMode: selectedAssignment?.fit_mode || null,
        synchronizedStartAt: selectedAssignment?.synchronized_start_at || null,
        geometry,
      });

      // Solo groups keep normal independent playback. Only a multi-member span
      // enters legacy wall mode; all groups still receive layout_assignment.
      if (layoutGroup.layout === 'span' && layoutGroup.member_ids.length > 1 && geometry) {

        wall_config = {
          wall_id: wall.id,
          wall_name: wall.name || null,
          ...layoutAssignment,
          group_id: layoutGroup.id,
          member_id: deviceId,
          group_member_ids: layoutGroup.member_ids,
          grid_col: pos.grid_col,
          grid_row: pos.grid_row,
          grid_cols: layoutGroup.geometry.columns,
          grid_rows: layoutGroup.geometry.rows,
          // Backward-compatible player fields stay available while new clients
          // consume logical_canvas + viewport from the same geometry result.
          screen_rect: geometry.screenRect,
          player_rect: geometry.playerRect,
          is_leader: layoutGroup.leader_device_id === deviceId,
          rotation: pos.rotation || 0,
          refresh_rate_hz: wall.refresh_rate_hz || null,
        };
      }
    }
  }

  const payload = {
    assignments,
    layout,
    orientation: device?.orientation || 'landscape',
    wall_config,
    layout_assignment: layoutAssignment,
    display_state: restoreStateForDevice(deviceId, device, wall, layoutGroup),
    wall_layout: wallLayout,
    layout_context: layoutGroup ? {
      wall_id: wall?.id || null,
      layout_id: wallLayout?.id || null,
      layout_revision: wallLayout?.revision || 0,
      group_id: layoutGroup.id,
      member_id: deviceId,
      group_member_ids: layoutGroup.member_ids,
      group_layout: layoutGroup.layout,
      leader_device_id: layoutGroup.leader_device_id,
      configured_leader_device_id: layoutGroup.configured_leader_device_id,
      leader_failover_active: !!layoutGroup.leader_failover_active,
    } : null,
    // 2026-05-28: surface the device's authoritative geometry so the player
    // can size to the canonical (admin-overridden) resolution rather than the
    // browser-reported screen.width/height (which underreports on Fire TV).
    device_geometry: {
      width: device?.screen_width || null,
      height: device?.screen_height || null,
      refresh_rate_hz: device?.refresh_rate_hz || null,
      auto_detected: !!device?.auto_detect_resolution,
    },
    display_profile: profileForDevice(device),
    audio_policy: commonAudioPolicy,
  };

  // Stable revision for missed-push reconciliation. Playback state is excluded:
  // slide/time updates must not make the player rebuild otherwise unchanged
  // media. The player sends this value in a lightweight periodic sync check.
  payload.playlist_revision = crypto.createHash('sha256').update(JSON.stringify({
    assignments: payload.assignments,
    layout: payload.layout,
    orientation: payload.orientation,
    wall_config: payload.wall_config,
    layout_assignment: payload.layout_assignment,
    wall_layout: payload.wall_layout,
    layout_context: payload.layout_context,
    device_geometry: payload.device_geometry,
    display_profile: payload.display_profile,
    audio_policy: payload.audio_policy,
  })).digest('hex').slice(0, 24);
  if (commonAudioPolicy) {
    const deviceAudioPolicy = policyForDevice(
      commonAudioPolicy,
      deviceId,
      payload.playlist_revision,
    );
    payload.audio_policy = deviceAudioPolicy ? {
      ...deviceAudioPolicy,
      audio_allowed: deviceAudioPolicy.audio_allowed,
      force_muted: deviceAudioPolicy.force_muted,
      playlist_revision: payload.playlist_revision,
    } : null;
  }
  let activeDeliveries = Array.isArray(delivery)
    ? delivery
    : (delivery && typeof delivery === 'object' ? [delivery] : []);
  if (activeDeliveries.length === 0) {
    activeDeliveries = broadcastDelivery.pendingForDevice(deviceId, payload.playlist_revision);
  }
  payload.broadcast_deliveries = [];
  for (const activeDelivery of activeDeliveries) {
    if (
      !activeDelivery
      || typeof activeDelivery !== 'object'
      || !activeDelivery.requestId
      || !activeDelivery.commandId
      || !activeDelivery.sourceId
    ) continue;
    const prepared = broadcastDelivery.markPrepared({
      requestId: activeDelivery.requestId,
      deviceId,
      commandId: activeDelivery.commandId,
      playlistRevision: payload.playlist_revision,
      expectedSourceId: activeDelivery.expectedSourceId || null,
    });
    if (prepared.applied) payload.broadcast_deliveries.push({
      request_id: String(activeDelivery.requestId),
      command_id: String(activeDelivery.commandId),
      source_id: String(activeDelivery.sourceId),
      source_type: String(activeDelivery.sourceType || 'content'),
      expected_source_id: activeDelivery.expectedSourceId ? String(activeDelivery.expectedSourceId) : null,
      region_id: activeDelivery.regionId ? String(activeDelivery.regionId) : null,
      zone_id: activeDelivery.zoneId ? String(activeDelivery.zoneId) : null,
      expected_playlist_revision: payload.playlist_revision,
    });
  }
  if (payload.broadcast_deliveries.length > 0) {
    [payload.broadcast_delivery] = payload.broadcast_deliveries;
  } else {
    delete payload.broadcast_deliveries;
  }
  return payload;
}

// Device access gating (billing/trial/device-limit) has been removed.
// This function is retained with its original name and return shape so callers
// (the register handlers) continue to work unchanged. It now unconditionally
// grants access — no trial-expired screen, no device-limit block.
function checkDeviceAccess(deviceId) {
  return { allowed: true };
}

module.exports = function setupDeviceSocket(io, dependencies = {}) {
  // Expose helpers for use by route handlers
  module.exports.lastScreenshots = lastScreenshots;
  module.exports.buildPlaylistPayload = buildPlaylistPayload;
  module.exports.generateDeviceToken = generateDeviceToken;
  const ensureReconnectAudioOwner = typeof dependencies.ensureAudioOwnerAfterReconnect === 'function'
    ? dependencies.ensureAudioOwnerAfterReconnect
    : ensureAudioOwnerAfterReconnect;
  const deviceNs = io.of('/device');
  const dashboardNs = io.of('/dashboard');

  // Disconnect any existing socket that is currently registered for this device_id.
  // Called when a fresh registration comes in for the same device so the old (likely
  // half-dead) socket can't fire its disconnect handler and clobber the new entry.
  function evictPriorSocket(deviceId, exceptSocketId) {
    const prior = heartbeat.getConnection(deviceId);
    if (!prior || prior.socketId === exceptSocketId) return;
    const oldSocket = deviceNs.sockets.get(prior.socketId);
    if (oldSocket) {
      console.log(`Evicting prior socket ${prior.socketId} for device ${deviceId}`);
      try { oldSocket.disconnect(true); } catch (_) {}
    }
  }

  deviceNs.on('connection', (socket) => {
    console.log(`Device socket connected: ${socket.id}`);
    let currentDeviceId = null;
    let authenticated = false; // Track whether this socket has been authenticated
    let lastPlaylistSyncAt = 0;
    let audioReconnectBlockReason = null;

    function reassertReconnectFailMuted() {
      if (!audioReconnectBlockReason) return;
      socket.emit('device:audio-policy-clamp', {
        version: 1,
        reason: audioReconnectBlockReason,
        audio_policy: null,
      });
    }

    // Once the managed OBS receiver authenticates, constrain every subsequent
    // client-originated event to its read/report role. Ordinary displays and
    // room nodes retain their existing protocol.
    socket.use(programReceiverEventGuard(() => currentDeviceId));

    // ── Classroom room-agent ("node") branch ────────────────────────────────
    // A room-agent connects with handshake auth { role:'node', node_id, token }.
    // It is NOT a display: it never registers a device, never joins display
    // rooms, and only records heartbeats + receives the content pre-warm
    // manifest. Gated by a configured node token (feature off => rejected).
    const hsAuth = (socket.handshake && socket.handshake.auth) || {};
    if (hsAuth.role === 'node') {
      const nodeId = String(hsAuth.node_id || '').trim();
      if (!nodeId || !nodeRegistry.nodeAuthOk(hsAuth)) {
        socket.emit('node:auth-error', { error: 'invalid_node_token' });
        try { socket.disconnect(true); } catch (_) {}
        return;
      }
      socket.data.nodeId = nodeId;
      socket.data.cacheProtocolVersion = nodeRegistry.normalizeCacheProtocolVersion(
        hsAuth.cache_protocol_version,
      );
      const emitManifest = () => socket.emit(
        'node:sync-manifest',
        nodeRegistry.manifestPayloadForNode(db, {
          nodeId,
          cacheProtocolVersion: socket.data.cacheProtocolVersion,
        }),
      );
      try { socket.join('node:' + nodeId); } catch (_) {}
      console.log(`Node connected: ${nodeId} (${hsAuth.node_type || 'node'})`);
      socket.emit('node:joined', {
        node_id: nodeId,
        cache_protocol_version: socket.data.cacheProtocolVersion,
      });
      // Push the initial pre-warm manifest so the cache fills ahead of use.
      try {
        emitManifest();
      } catch (error) {
        console.warn(`[node-manifest] initial sync withheld for ${nodeId}: ${error.message}`);
      }
      socket.on('node:heartbeat', (payload) => {
        const heartbeatProtocolVersion = nodeRegistry.normalizeCacheProtocolVersion(
          payload?.cache_protocol_version,
        );
        if (heartbeatProtocolVersion >= nodeRegistry.CACHE_PROTOCOL_VERSION
          && heartbeatProtocolVersion > socket.data.cacheProtocolVersion) {
          socket.data.cacheProtocolVersion = heartbeatProtocolVersion;
          try {
            emitManifest();
          } catch (error) {
            console.warn(`[node-manifest] v2 capability refresh withheld for ${nodeId}: ${error.message}`);
          }
        }
        let recorded = false;
        try { recorded = nodeRegistry.recordHeartbeat(db, nodeId, payload); } catch (_) {}
        try {
          const node = recorded ? db.prepare(`
            SELECT node_id, node_name, node_type, room_id, workspace_id, last_heartbeat,
                   software_version, free_disk, cache_size, sync_status, audio_endpoint
            FROM managed_nodes WHERE node_id = ?
          `).get(nodeId) : null;
          if (!node?.workspace_id || !node?.room_id) return;
          dashboardNs.to(roomStateRoom(node.workspace_id, node.room_id)).emit('dashboard:node-status', {
            node_id: nodeId,
            node_name: node.node_name || nodeId,
            node_type: node.node_type || 'node',
            room_id: node.room_id,
            status: 'online',
            last_heartbeat: node.last_heartbeat ?? null,
            software_version: node.software_version || null,
            free_disk: node.free_disk ?? null,
            cache_size: node.cache_size ?? null,
            sync_status: node.sync_status || 'unknown',
            audio_endpoint: node.audio_endpoint || null,
          });
          scheduleRoomSnapshot(io, {
            workspaceId: node.workspace_id,
            roomId: node.room_id,
            reason: 'node:heartbeat',
          }, 250);
        } catch (_) {}
      });
      socket.on('node:request-manifest', () => {
        try {
          emitManifest();
        } catch (error) {
          console.warn(`[node-manifest] requested sync withheld for ${nodeId}: ${error.message}`);
        }
      });
      socket.on('node:prewarm-result', (payload) => {
        try {
          const result = recordPreparationResult(db, nodeId, payload);
          if (!result.applied) return;
          const node = db.prepare(
            'SELECT workspace_id, room_id FROM managed_nodes WHERE node_id = ?',
          ).get(nodeId);
          if (!node?.workspace_id) return;
          dashboardNs.to(workspaceRoom(node.workspace_id)).emit('dashboard:content-preparation', {
            node_id: nodeId,
            content_id: String(payload?.content_id || ''),
            generation: Number(payload?.generation) || null,
            state: result.state,
          });
          if (node.room_id) {
            scheduleRoomSnapshot(io, {
              workspaceId: node.workspace_id,
              roomId: node.room_id,
              reason: 'node:prewarm-result',
            }, 100);
          }
        } catch (error) {
          console.warn(`Node prewarm result rejected for ${nodeId}: ${error.message}`);
        }
      });
      socket.on('join', (data) => {
        try { if (data && data.room) socket.join(String(data.room)); } catch (_) {}
      });
      socket.on('disconnect', (reason) => {
        console.log(`Node disconnected: ${nodeId} (${reason})`);
      });
      return; // a node socket never runs the display registration handlers
    }

    // Device registers with a pairing code (first time) or device_id + device_token (reconnect)
    socket.on('device:register', async (data) => {
      const { pairing_code, device_id, device_token, device_info, fingerprint } = data;

      // Socket.IO reconnects can occur before an operator claims a pairing
      // code. Reuse that one provisional row instead of minting another
      // Unnamed Display on every transport flap/page reload.
      if (!device_id && /^\d{6}$/.test(String(pairing_code || ''))) {
        const pendingDevice = findReusablePendingEnrollment(db, pairing_code);
        if (pendingDevice) {
          const newToken = generateDeviceToken();
          currentDeviceId = pendingDevice.id;
          authenticated = true;
          if (pendingOfflines.has(pendingDevice.id)) {
            clearTimeout(pendingOfflines.get(pendingDevice.id));
            pendingOfflines.delete(pendingDevice.id);
          }
          evictPriorSocket(pendingDevice.id, socket.id);
          db.prepare(`
            UPDATE devices
            SET device_token = ?, status = 'provisioning',
                pairing_expires_at = ?,
                last_heartbeat = strftime('%s','now'), ip_address = ?,
                android_version = ?, app_version = ?,
                screen_width = ?, screen_height = ?,
                updated_at = strftime('%s','now')
            WHERE id = ?
          `).run(
            newToken,
            pairingCodeExpiresAt(),
            getClientIp(socket),
            device_info?.android_version || null,
            device_info?.app_version || null,
            device_info?.screen_width || null,
            device_info?.screen_height || null,
            pendingDevice.id,
          );
          bindEnrollmentFingerprint(db, fingerprint, pendingDevice.id);
          heartbeat.registerConnection(pendingDevice.id, socket.id);
          socket.join(pendingDevice.id);
          joinDeviceTargetRooms(socket, pendingDevice.id);
          socket.emit('device:registered', {
            device_id: pendingDevice.id,
            device_token: newToken,
            status: 'provisioning',
          });
          console.log(`Pending device enrollment resumed: ${pendingDevice.id}`);
          return;
        }
      }

      // A browser fingerprint is not a device credential: identical displays
      // can legitimately report the same value. Touch/bind it for diagnostics,
      // but never use it to reclaim or overwrite another display identity.
      // Identity resumption is based on the device token above, or the exact
      // still-pending pairing code handled above.
      if (fingerprint) {
        try {
          const existing = db.prepare('SELECT * FROM device_fingerprints WHERE fingerprint = ?').get(fingerprint);
          if (existing) {
            db.prepare("UPDATE device_fingerprints SET last_seen = strftime('%s','now') WHERE fingerprint = ?")
              .run(fingerprint);
          }
          if (device_id) bindEnrollmentFingerprint(db, fingerprint, device_id);
        } catch (e) {
          console.error('Fingerprint tracking error:', e.message);
        }
      }

      if (device_id) {
        // Reconnecting known device — require valid token
        const device = db.prepare('SELECT * FROM devices WHERE id = ?').get(device_id);
        if (device) {
          // Validate device token (skip for legacy devices that don't have a token yet)
          if (device.device_token && !validateDeviceToken(device_id, device_token)) {
            console.warn(`Invalid device token for ${device_id} from ${getClientIp(socket)} — received_len=${(device_token || '').length}, stored_len=${device.device_token.length}`);
            socket.emit('device:auth-error', { error: 'Invalid device token' });
            return;
          }

          currentDeviceId = device_id;
          authenticated = true;
          // Cancel any pending offline timer - device is back in the grace window
          if (pendingOfflines.has(device_id)) {
            clearTimeout(pendingOfflines.get(device_id));
            pendingOfflines.delete(device_id);
          }
          evictPriorSocket(device_id, socket.id);
          db.prepare("UPDATE devices SET status = 'online', last_heartbeat = strftime('%s','now'), ip_address = ?, updated_at = strftime('%s','now') WHERE id = ?")
            .run(getClientIp(socket), device_id);

          // Generate token for legacy devices that don't have one yet
          let tokenToSend = device.device_token;
          if (!tokenToSend) {
            tokenToSend = generateDeviceToken();
            db.prepare('UPDATE devices SET device_token = ? WHERE id = ?').run(tokenToSend, device_id);
          }

          if (device_info) {
            // 2026-05-28: only overwrite reported screen dimensions when the
            // device is in auto-detect mode. Admins can pin canonical values
            // (e.g. 12372x2160 wall) via /api/devices/:id and have those
            // survive reconnects even though the Fire TV keeps reporting
            // 1920x1080 (the OS surface res, not panel res).
            const fresh = db.prepare('SELECT auto_detect_resolution FROM devices WHERE id = ?').get(device_id);
            const autoDetect = !fresh || fresh.auto_detect_resolution !== 0;
            if (autoDetect) {
              db.prepare('UPDATE devices SET android_version = ?, app_version = ?, screen_width = ?, screen_height = ? WHERE id = ?')
                .run(device_info.android_version, device_info.app_version, device_info.screen_width, device_info.screen_height, device_id);
            } else {
              db.prepare('UPDATE devices SET android_version = ?, app_version = ? WHERE id = ?')
                .run(device_info.android_version, device_info.app_version, device_id);
            }
          }

          heartbeat.registerConnection(device_id, socket.id);
          socket.join(device_id);
          joinDeviceTargetRooms(socket, device_id);
          audioReconnectBlockReason = 'audio_reconnect_recovery_pending';
          socket.emit('device:registered', {
            device_id,
            device_token: tokenToSend,
            status: 'online',
            audio_ready: false,
          });
          logDeviceStatus(device_id, 'online');
          try {
            await ensureReconnectAudioOwner(deviceNs, device_id);
            audioReconnectBlockReason = null;
          } catch (error) {
            audioReconnectBlockReason = 'audio_reconnect_recovery_failed';
            console.error(`Audio reconnect recovery failed for ${device_id}: ${error.message}`);
            reassertReconnectFailMuted();
            emitToDeviceWorkspace(dashboardNs, device_id, 'dashboard:device-status', {
              device_id,
              status: 'online',
              audio_ready: false,
              audio_status: 'fail_muted',
              audio_error: audioReconnectBlockReason,
            });
            return;
          }
          // Flush any commands/playlist-updates queued while this device was offline.
          commandQueue.flushQueue(deviceNs, device_id, buildPlaylistPayload);

          // Recompute effective (online) leadership in payloads without ever
          // rewriting the persisted configured leader. Peers receive the same
          // deterministic failover view; when the configured leader returns,
          // it resumes automatically without a topology revision or restart.
          if (device.wall_id) {
            try {
              pushEffectiveWallLeadership(deviceNs, device.wall_id, device_id);
            } catch (e) { console.error('Wall effective-leader refresh failed:', e.message); }
          }

          // Device access gating removed — checkDeviceAccess always grants access.
          const access = checkDeviceAccess(device_id);
          if (!access.allowed) {
            socket.emit('device:playlist-update', { assignments: [], suspended: true, message: access.message, detail: access.detail });
          } else {
            socket.emit('device:playlist-update', buildPlaylistPayload(device_id));
          }

          emitToDeviceWorkspace(dashboardNs, device_id, 'dashboard:device-status', { device_id, status: 'online' });
          scheduleDeviceRoomSnapshot(io, device_id, 'device:online');
          console.log(`Device reconnected: ${device_id}`);
          return;
        }

        // Device ID not found in database - tell device to re-provision
        console.log(`Device ${device_id} not found in database, sending unpaired`);
        socket.emit('device:unpaired', { reason: 'not_found' });
        return;
      }

      if (/^\d{6}$/.test(String(pairing_code || ''))) {
        // New device registering with pairing code — generate a device_token
        const id = uuidv4();
        const newToken = generateDeviceToken();
        currentDeviceId = id;
        authenticated = true;

        db.prepare(`
          INSERT INTO devices (id, pairing_code, pairing_expires_at, device_token, status, ip_address, android_version, app_version, screen_width, screen_height, last_heartbeat)
          VALUES (?, ?, ?, ?, 'provisioning', ?, ?, ?, ?, ?, strftime('%s','now'))
        `).run(
          id, pairing_code, pairingCodeExpiresAt(), newToken, getClientIp(socket),
          device_info?.android_version || null,
          device_info?.app_version || null,
          device_info?.screen_width || null,
          device_info?.screen_height || null
        );
        bindEnrollmentFingerprint(db, fingerprint, id);

        heartbeat.registerConnection(id, socket.id);
        socket.join(id);
        joinDeviceTargetRooms(socket, id);
        socket.emit('device:registered', { device_id: id, device_token: newToken, status: 'provisioning' });

        // Newly-provisioned devices have no workspace_id yet (they'll get one
        // on pair claim). emitToDeviceWorkspace silently drops when there's no
        // workspace; that's safer than the previous platform-wide broadcast.
        // Dashboards refresh /api/devices/unassigned on poll for the
        // platform_admin pairing view.
        emitToDeviceWorkspace(dashboardNs, id, 'dashboard:device-added', db.prepare('SELECT * FROM devices WHERE id = ?').get(id));
        console.log(`New device registered for pairing: ${id}`);
      }
    });

    // Require authentication for all events after register
    function requireDeviceAuth() {
      if (!authenticated || !currentDeviceId) {
        socket.emit('device:auth-error', { error: 'Not authenticated. Send device:register first.' });
        return false;
      }
      return true;
    }

    // The OBS receiver explicitly requests a complete, authoritative room
    // snapshot after each registration/reconnect. Tenancy is derived from its
    // authenticated device row; client-supplied workspace/room values may only
    // confirm that identity, never select another tenant.
    socket.on('device:room-snapshot', (data, acknowledge) => {
      const reply = typeof acknowledge === 'function' ? acknowledge : () => {};
      try {
        if (!requireDeviceAuth()) return reply({ ok: false, code: 'DEVICE_AUTH_REQUIRED' });
        if (!isProgramReceiverId(currentDeviceId)) {
          return reply({ ok: false, code: 'PROGRAM_RECEIVER_REQUIRED' });
        }
        const target = resolveProgramReceiverSnapshotTarget({
          db,
          deviceId: currentDeviceId,
          configuredRoomId: config.liveStream?.roomId || config.console?.roomId,
          requestedWorkspaceId: data?.workspace_id || data?.workspaceId,
          requestedRoomId: data?.room_id || data?.roomId,
        });
        const snapshot = createRoomSnapshot({
          workspaceId: target.workspaceId,
          roomId: target.roomId,
          reason: 'device:room-snapshot',
        });
        socket.emit('device:room-snapshot', snapshot);
        return reply({
          ok: true,
          schemaVersion: snapshot.schemaVersion,
          revision: snapshot.revision,
          serverTimestamp: snapshot.serverTimestamp,
        });
      } catch (error) {
        const code = error?.code || 'PROGRAM_RECEIVER_SNAPSHOT_FAILED';
        console.warn(`device:room-snapshot failed for ${currentDeviceId || 'unauthenticated'}: ${code}`);
        return reply({ ok: false, code });
      }
    });

    // Heartbeat with telemetry
    // 2026-05-28: hardened against process-killing FK violations. If the
    // device row is deleted (by an admin or a reset) between socket register
    // and the heartbeat firing, the INSERT INTO device_telemetry would throw
    // SQLITE_CONSTRAINT_FOREIGNKEY and propagate out of the Socket.IO event
    // handler, crashing Node. Now we (a) re-check the parent row exists
    // before any FK insert, and (b) wrap each write in try/catch so a single
    // malformed payload never restarts the container.
    socket.on('device:heartbeat', async (data, acknowledge) => {
      try {
        if (!requireDeviceAuth()) return;
        const { device_id, telemetry, audio_policy_state } = data || {};
        if (!device_id || device_id !== currentDeviceId) return;

        // Parent existence check: if the device row was deleted server-side
        // (workspace cleanup, admin delete, schema rebuild) the socket is
        // stale. Tell the player to re-provision and bail.
        const exists = db.prepare('SELECT 1 FROM devices WHERE id = ?').get(device_id);
        if (!exists) {
          try { socket.emit('device:unpaired', { reason: 'not_found' }); } catch (_) {}
          authenticated = false;
          currentDeviceId = null;
          return;
        }

        heartbeat.updateHeartbeat(device_id);

        try { commandModel.recordHeartbeat({ target_type: 'display', target_id: device_id, ts: Date.now() }); }
        catch (e) { /* command-model heartbeat upsert is best-effort */ }

        try {
          db.prepare(`
            UPDATE devices
            SET status = 'online', last_heartbeat = strftime('%s','now'),
                pairing_expires_at = CASE WHEN user_id IS NULL THEN ? ELSE pairing_expires_at END,
                updated_at = strftime('%s','now')
            WHERE id = ?
          `).run(pairingCodeExpiresAt(), device_id);
        } catch (e) {
          console.warn(`heartbeat UPDATE devices failed for ${device_id}: ${e.message}`);
        }

        if (telemetry) {
          try {
            db.prepare(`
              INSERT INTO device_telemetry (device_id, battery_level, battery_charging, storage_free_mb, storage_total_mb,
                ram_free_mb, ram_total_mb, cpu_usage, wifi_ssid, wifi_rssi, uptime_seconds)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `).run(
              device_id,
              telemetry.battery_level ?? null,
              telemetry.battery_charging ? 1 : 0,
              telemetry.storage_free_mb ?? null,
              telemetry.storage_total_mb ?? null,
              telemetry.ram_free_mb ?? null,
              telemetry.ram_total_mb ?? null,
              telemetry.cpu_usage ?? null,
              telemetry.wifi_ssid ?? null,
              telemetry.wifi_rssi ?? null,
              telemetry.uptime_seconds ?? null
            );
            pruneTelemetry(device_id);
          } catch (e) {
            // FK violation, race with delete, etc. Log and skip telemetry —
            // don't crash the whole device namespace.
            console.warn(`device_telemetry INSERT failed for ${device_id}: ${e.message}`);
          }

          try {
            emitToDeviceWorkspace(dashboardNs, device_id, 'dashboard:device-status', {
              device_id,
              status: 'online',
              telemetry
            });
          } catch (e) {
            console.warn(`dashboard emit failed for ${device_id}: ${e.message}`);
          }
        }
        if (audioReconnectBlockReason) {
          reassertReconnectFailMuted();
          if (typeof acknowledge === 'function') acknowledge({
            ok: true,
            audio_policy: null,
            audio_policy_decision: {
              clamp: true,
              reason: audioReconnectBlockReason,
            },
          });
          return;
        }
        await waitForAudioOwnerRecovery(currentDeviceId);
        const authoritativeAudioPolicy = buildPlaylistPayload(device_id).audio_policy || null;
        const audioPolicyDecision = audioPolicyHeartbeatDecision(
          authoritativeAudioPolicy,
          audio_policy_state,
        );
        if (audioPolicyDecision.clamp) {
          socket.emit('device:audio-policy-clamp', {
            version: 1,
            reason: audioPolicyDecision.reason,
            audio_policy: authoritativeAudioPolicy,
          });
        }
        if (authoritativeAudioPolicy && !authoritativeAudioPolicy.owner_device_id) {
          void ensureAudioOwnerAfterReconnect(deviceNs, device_id).catch((error) => {
            console.error(`Audio heartbeat recovery failed for ${device_id}: ${error.message}`);
          });
        }
        if (typeof acknowledge === 'function') acknowledge({
          ok: true,
          audio_policy: authoritativeAudioPolicy,
          audio_policy_decision: audioPolicyDecision,
        });
      } catch (e) {
        // Catch-all so a malformed payload never escapes the event loop.
        console.error(`device:heartbeat handler crashed: ${e.message}`, e.stack);
        if (typeof acknowledge === 'function') acknowledge({ ok: false, error: 'heartbeat_failed' });
      }
    });

    // Repair a missed live playlist push without re-registering or reloading the
    // whole kiosk page. The client sends only its applied revision; a full
    // payload is returned only when DB/wall geometry actually differs.
    socket.on('device:playlist-sync', async (data, acknowledge) => {
      try {
        if (!requireDeviceAuth()) return;
        const now = Date.now();
        if (now - lastPlaylistSyncAt < 1000) {
          if (typeof acknowledge === 'function') acknowledge({ ok: false, rate_limited: true });
          return;
        }
        lastPlaylistSyncAt = now;
        if (audioReconnectBlockReason) {
          reassertReconnectFailMuted();
          if (typeof acknowledge === 'function') acknowledge({
            ok: false,
            fail_muted: true,
            error: audioReconnectBlockReason,
          });
          return;
        }
        await waitForAudioOwnerRecovery(currentDeviceId);
        const payload = buildPlaylistPayload(currentDeviceId);
        if (payload.delivery_blocked) {
          socket.emit('device:playlist-update', payload);
          if (typeof acknowledge === 'function') {
            acknowledge({
              ok: false,
              delivery_blocked: true,
              error: payload.delivery_block_reason,
              playlist_revision: payload.playlist_revision,
            });
          }
          return;
        }
        const appliedRevision = data && typeof data.playlist_revision === 'string'
          ? data.playlist_revision
          : null;
        const changed = !appliedRevision || appliedRevision !== payload.playlist_revision;
        if (changed) socket.emit('device:playlist-update', payload);
        if (typeof acknowledge === 'function') {
          acknowledge({ ok: true, changed, playlist_revision: payload.playlist_revision });
        }
      } catch (e) {
        console.warn(`device:playlist-sync failed for ${currentDeviceId}: ${e.message}`);
        if (typeof acknowledge === 'function') acknowledge({ ok: false, error: 'sync_failed' });
      }
    });

    // Screenshot received from device - relay via WebSocket, keep latest in memory
    socket.on('device:screenshot', async (data) => {
      if (!requireDeviceAuth()) return;
      const { device_id, image_b64, captured_at, timestamp, correlation_id } = data;
      if (!device_id || device_id !== currentDeviceId || !image_b64) return;
      // Validate screenshot size (max 2MB base64 ≈ 1.5MB image)
      if (image_b64.length > 2 * 1024 * 1024) return;

      // Store latest screenshot in memory (for Now Playing preview and offline snapshot)
      if (!lastScreenshots) lastScreenshots = {};
      lastScreenshots[device_id] = image_b64;

      // Keep the hydrated dashboard preview timestamp in sync with live captures.
      try {
        const result = await persistScreenshot(device_id, image_b64, captured_at ?? timestamp);
        if (result && result.applied === false) return;
      } catch (err) {
        console.error('Screenshot persist error:', err);
      }

      // Relay directly to open dashboards for immediate refresh.
      try {
        emitToDeviceWorkspace(dashboardNs, device_id, 'dashboard:screenshot-ready', {
          device_id,
          image_data: `data:image/jpeg;base64,${image_b64}`,
          timestamp: Date.now(),
          captured_at: Math.floor(Date.now() / 1000),
          correlation_id: correlation_id || null,
        });
      } catch (err) {
        console.error('Screenshot save error:', err);
      }
    });

    // Content download acknowledgement
    socket.on('device:content-ack', (data) => {
      if (!requireDeviceAuth()) return;
      const { device_id, content_id, status } = data;
      if (device_id !== currentDeviceId) return;
      console.log(`Device ${device_id} content ${content_id}: ${status}`);
      emitToDeviceWorkspace(dashboardNs, device_id, 'dashboard:content-ack', { device_id, content_id, status });
    });

    // Content-broadcast receipt/render proof. The player socket is already
    // authenticated; always stamp currentDeviceId instead of trusting a
    // client-provided device id. The store rejects the event unless request,
    // per-device command, and exact playlist revision all match.
    socket.on('device:broadcast-status', (data) => {
      try {
        if (!requireDeviceAuth()) return;
        const raw = data && typeof data === 'object' ? data : {};
        const requestId = String(raw.request_id || '').slice(0, 128);
        const commandId = String(raw.command_id || '').slice(0, 128);
        const playlistRevision = String(raw.playlist_revision || '').slice(0, 128);
        const phase = String(raw.phase || '').toLowerCase();
        if (!requestId || !commandId || !playlistRevision) return;

        const rawState = raw.player_state && typeof raw.player_state === 'object'
          ? raw.player_state
          : {};
        const playerState = {
          current_content_id: rawState.current_content_id || null,
          content_instance_id: rawState.content_instance_id || null,
          current_asset_id: rawState.current_asset_id || null,
          content_type: rawState.content_type || null,
          layout_mode: rawState.layout_mode || null,
          render_state: rawState.render_state || null,
          error_state: rawState.error_state || null,
          paused: rawState.paused == null ? null : !!rawState.paused,
          muted: rawState.muted == null ? null : !!rawState.muted,
          volume: Number.isFinite(Number(rawState.volume)) ? Number(rawState.volume) : null,
          wall_id: rawState.wall_id || null,
          group_id: rawState.group_id || null,
          member_id: rawState.member_id || currentDeviceId,
          region_states: Array.isArray(rawState.region_states)
            ? rawState.region_states.slice(0, 32).map((region) => ({
              region_id: region?.region_id || null,
              zone_id: region?.zone_id || null,
              current_content_id: region?.current_content_id || null,
              content_instance_id: region?.content_instance_id || null,
              content_type: region?.content_type || null,
              render_state: region?.render_state || null,
              paused: region?.paused == null ? null : !!region.paused,
            }))
            : [],
        };
        const result = broadcastDelivery.markPlayerStatus({
          requestId,
          deviceId: currentDeviceId,
          commandId,
          phase,
          playlistRevision,
          rendererSessionId: raw.renderer_session_id,
          renderGeneration: raw.render_generation,
          playerState,
          failureReason: raw.failure_reason ? String(raw.failure_reason).slice(0, 500) : null,
        });
        if (!result.applied) return;

        const request = broadcastDelivery.getRequest(requestId);
        const device = request?.devices?.find((entry) => entry.device_id === currentDeviceId) || null;
        emitToDeviceWorkspace(dashboardNs, currentDeviceId, 'dashboard:broadcast-status', {
          request_id: requestId,
          status: request?.status || 'in_progress',
          device,
        });
        scheduleDeviceRoomSnapshot(io, currentDeviceId, `broadcast:${phase}`);
      } catch (e) {
        console.warn(`device:broadcast-status handler error for ${currentDeviceId}: ${e.message}`);
      }
    });

    // ── Phase 2: reliable command/state model ─────────────────────────────
    // Device acks a command_id it received via device:command. Server updates
    // command_logs (bubbling child → parent for wall/group commands), upserts
    // display_states if a state snapshot is attached, and relays command:ack to
    // both the selected target room and the workspace stream. The workspace
    // stream keeps web/Electron controllers in sync even before they select a
    // specific target room.
    socket.on('device:ack', (data) => {
      try {
        if (!requireDeviceAuth()) return;
        const ack = deviceContract.createAck({ ...(data || {}), device_id: currentDeviceId });
        const { command_id, ok, error, state } = ack;
        if (!command_id) return;
        commandModel.recordAck({
          command_id,
          ok: ok !== false,
          error: error ? `${error.code}: ${error.message}` : null,
          state: state || null,
          target_type: 'display',
          target_id: currentDeviceId,
        });
        emitToDeviceTargetAndWorkspace(dashboardNs, currentDeviceId, 'command:ack', {
          ...ack, target_type: 'display', target_id: currentDeviceId,
          status: ok === false ? 'failed' : 'acked',
        });
        scheduleDeviceRoomSnapshot(io, currentDeviceId, ok === false ? 'command:failed' : 'command:acked');
      } catch (e) {
        console.warn(`device:ack handler error for ${currentDeviceId}: ${e.message}`);
        const commandId = data && data.command_id;
        if (commandId) {
          emitToDeviceTargetAndWorkspace(dashboardNs, currentDeviceId, 'command:ack', deviceContract.createAck({
            command_id: commandId,
            device_id: currentDeviceId,
            ok: false,
            error: { code: 'state_persistence_failed', message: e.message },
          }));
        }
      }
    });

    // Periodic / on-demand display state self-report. Server upserts
    // display_states and emits dashboard:state-sync to the target room and the
    // workspace stream so every open controller hydrates from device truth
    // without waiting for polling/screenshot refresh.
    socket.on('device:state-report', (data) => {
      try {
        if (!requireDeviceAuth()) return;
        const rawState = data && data.state ? data.state : data;
        const state = rawState && typeof rawState === 'object'
          ? { ...rawState, slide_count: rawState.slide_count ?? rawState.slide_total ?? null }
          : {};
        const result = commandModel.mergeDisplayState('display', currentDeviceId, state);
        if (result && result.applied === false) {
          console.warn(`[state-report] rejected ${currentDeviceId} revision ${state && state.state_revision}: ${result.reason}`);
          return;
        }
        commandModel.recordHeartbeat({ target_type: 'display', target_id: currentDeviceId, ts: Date.now() });
        emitToDeviceTargetAndWorkspace(dashboardNs, currentDeviceId, 'dashboard:state-sync', {
          version: 1, type: 'device:state-report', target_type: 'display', target_id: currentDeviceId,
          state: { ...(state || {}), state_revision: result.state_revision },
        });
        scheduleDeviceRoomSnapshot(io, currentDeviceId, 'device:state-report');
      } catch (e) {
        console.warn(`device:state-report handler error: ${e.message}`);
      }
    });

    // Playback state update
    socket.on('device:playback-state', (data) => {
      if (!requireDeviceAuth()) return;
      // currentDeviceId is the authenticated device for this socket; use it
      // for the workspace lookup since data may not carry device_id consistently.
      emitToDeviceWorkspace(dashboardNs, currentDeviceId, 'dashboard:playback-state', data);
    });

    // Play event logging (proof-of-play)
    socket.on('device:play-event', (data) => {
      if (!requireDeviceAuth()) return;
      const { device_id, event, content_id, content_name, zone_id, completed, duration_sec } = data;
      if (device_id !== currentDeviceId) return;
      try {
        if (event === 'play_start') {
          db.prepare(`
            INSERT INTO play_logs (device_id, content_id, zone_id, content_name, started_at, trigger_type)
            VALUES (?, ?, ?, ?, strftime('%s','now'), 'playlist')
          `).run(device_id, content_id || null, zone_id || null, content_name || 'Unknown');
          // Forward to dashboard so it can render a per-device progress bar.
          // Server-side timestamp avoids clock-skew between player and dashboard.
          emitToDeviceWorkspace(dashboardNs, device_id, 'dashboard:playback-progress', {
            device_id,
            content_id: content_id || null,
            content_name: content_name || null,
            duration_sec: typeof duration_sec === 'number' && duration_sec > 0 ? duration_sec : null,
            started_at: Date.now(),
          });
        } else if (event === 'play_end') {
          db.prepare(`
            UPDATE play_logs SET ended_at = strftime('%s','now'),
              duration_sec = strftime('%s','now') - started_at,
              completed = ?
            WHERE id = (
              SELECT id FROM play_logs WHERE device_id = ? AND content_id = ? AND ended_at IS NULL
              ORDER BY started_at DESC LIMIT 1
            )
          `).run(completed ? 1 : 0, device_id, content_id);
        }
      } catch (err) {
        console.error('Play log error:', err.message);
      }
    });

    // Phase 2 (display self-report): the player reports its rendering
    // geometry/capabilities so the dashboard can show real per-display info
    // (CSS viewport, screen res, DPR, refresh rate, orientation) and so admins
    // can spot a misreporting panel. Trust ONLY the server-stamped
    // currentDeviceId — never the client-supplied id — for the row update.
    // Every DB write is wrapped in try/catch so a malformed payload can't crash
    // the device namespace (same hardening as device:heartbeat).
    socket.on('display:viewport', (data) => {
      try {
        if (!requireDeviceAuth()) return;
        const deviceId = currentDeviceId;
        const {
          css_w, css_h, screen_w, screen_h,
          device_pixel_ratio, refresh_hz, orientation, capabilities,
        } = data || {};

        // Parent existence check: the device row may have been deleted
        // server-side between register and this event. Bail quietly.
        const exists = db.prepare('SELECT 1 FROM devices WHERE id = ?').get(deviceId);
        if (!exists) return;

        // Coerce to safe types. Anything non-finite becomes null rather than
        // poisoning the row. capabilities is stringified defensively.
        const toInt = (v) => { const n = Number(v); return Number.isFinite(n) ? Math.round(n) : null; };
        const toReal = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null; };
        let capsJson = '{}';
        try { capsJson = JSON.stringify(capabilities || {}); } catch (_) { capsJson = '{}'; }

        const cssW = toInt(css_w);
        const cssH = toInt(css_h);
        const dpr = toReal(device_pixel_ratio);
        const hz = toInt(refresh_hz);
        const nowSec = Math.floor(Date.now() / 1000);

        try {
          db.prepare(`
            UPDATE devices SET
              viewport_css_w = ?, viewport_css_h = ?,
              device_pixel_ratio = ?, refresh_hz = ?,
              capabilities_json = ?, last_viewport_at = ?
            WHERE id = ?
          `).run(cssW, cssH, dpr, hz, capsJson, nowSec, deviceId);
        } catch (e) {
          console.warn(`display:viewport UPDATE devices failed for ${deviceId}: ${e.message}`);
        }

        // orientation + screen_width/screen_height live on the base schema /
        // earlier migrations. Only write them when the device supplied a value.
        // screen_width/height are also fed by device:register; respect the
        // admin auto_detect_resolution pin so a self-report can't clobber a
        // manually-set wall geometry.
        try {
          if (orientation === 'landscape' || orientation === 'portrait') {
            db.prepare('UPDATE devices SET orientation = ? WHERE id = ?').run(orientation, deviceId);
          }
        } catch (e) {
          console.warn(`display:viewport orientation update failed for ${deviceId}: ${e.message}`);
        }

        try {
          const sw = toInt(screen_w);
          const sh = toInt(screen_h);
          if (sw != null || sh != null) {
            const fresh = db.prepare('SELECT auto_detect_resolution FROM devices WHERE id = ?').get(deviceId);
            const autoDetect = !fresh || fresh.auto_detect_resolution !== 0;
            if (autoDetect) {
              if (sw != null) db.prepare('UPDATE devices SET screen_width = ? WHERE id = ?').run(sw, deviceId);
              if (sh != null) db.prepare('UPDATE devices SET screen_height = ? WHERE id = ?').run(sh, deviceId);
            }
          }
        } catch (e) {
          console.warn(`display:viewport screen dims update failed for ${deviceId}: ${e.message}`);
        }

        // Notify the dashboard (workspace-scoped) so it can live-update the
        // per-display panel. Reuse the existing dashboard:device-status event
        // and helper used by heartbeat/register, adding viewport fields.
        try {
          const row = db.prepare(
            'SELECT screen_width, screen_height, orientation FROM devices WHERE id = ?'
          ).get(deviceId) || {};
          emitToDeviceWorkspace(dashboardNs, deviceId, 'dashboard:device-status', {
            device_id: deviceId,
            status: 'online',
            viewport: {
              css_w: cssW,
              css_h: cssH,
              screen_w: row.screen_width ?? null,
              screen_h: row.screen_height ?? null,
              device_pixel_ratio: dpr,
              refresh_hz: hz,
              orientation: row.orientation ?? (orientation || null),
              capabilities: capabilities || {},
              last_viewport_at: nowSec,
            },
          });
        } catch (e) {
          console.warn(`display:viewport dashboard emit failed for ${deviceId}: ${e.message}`);
        }
      } catch (e) {
        // Catch-all so a malformed payload never escapes the event loop.
        console.error(`display:viewport handler crashed: ${e.message}`, e.stack);
      }
    });

    // Native Classroom 1 Smartboard whiteboard input. Only the dedicated
    // Classroom 1 profile may originate whiteboard writes from the display
    // itself; all other displays remain dashboard-controlled receivers.
    function canUseNativeWhiteboard() {
      if (!currentDeviceId) return false;
      const device = db.prepare('SELECT id, name FROM devices WHERE id = ?').get(currentDeviceId);
      return isClassroom1Smartboard(device);
    }

    socket.on('device:wb-stroke', (data) => {
      try {
        if (!requireDeviceAuth() || !canUseNativeWhiteboard()) return;
        const stroke = whiteboardState.appendStroke(null, currentDeviceId, data && data.stroke);
        if (!stroke) return;
        emitToDeviceWorkspace(dashboardNs, currentDeviceId, 'dashboard:wb-stroke', { device_id: currentDeviceId, stroke });
      } catch (e) {
        console.warn(`device:wb-stroke handler error: ${e.message}`);
      }
    });

    socket.on('device:wb-clear', () => {
      try {
        if (!requireDeviceAuth() || !canUseNativeWhiteboard()) return;
        whiteboardState.clearSession(null, currentDeviceId);
        emitToDeviceWorkspace(dashboardNs, currentDeviceId, 'dashboard:wb-clear', { device_id: currentDeviceId });
      } catch (e) {
        console.warn(`device:wb-clear handler error: ${e.message}`);
      }
    });

socket.on('device:wb-undo', () => {
      try {
        if (!requireDeviceAuth() || !canUseNativeWhiteboard()) return;
        // undoStroke now returns the popped stroke (or null). We no longer fan
        // the entire remaining list out — undo is a single-stroke pop and the
        // player redraws from its own state on 'device:wb-undo'.
        whiteboardState.undoStroke(null, currentDeviceId);
        emitToDeviceWorkspace(dashboardNs, currentDeviceId, 'dashboard:wb-undo', { device_id: currentDeviceId });
      } catch (e) {
        console.warn(`device:wb-undo handler error: ${e.message}`);
      }
    });

    socket.on('device:wb-redo', () => {
      try {
        if (!requireDeviceAuth() || !canUseNativeWhiteboard()) return;
        const stroke = whiteboardState.redoStroke(null, currentDeviceId);
        emitToDeviceWorkspace(dashboardNs, currentDeviceId, 'dashboard:wb-redo', { device_id: currentDeviceId, stroke });
      } catch (e) {
        console.warn(`device:wb-redo handler error: ${e.message}`);
      }
    });

    // Catch-all for any uncaught throw on this socket so the device
    // namespace stays alive even if a future handler is buggy. Node would
    // otherwise terminate the entire process on an emit-from-handler throw.
    socket.on('error', (err) => {
      console.error(`device socket error (id=${socket.id}, dev=${currentDeviceId}):`, err?.message || err);
    });

    // Video wall sync relay. Sender must be a member of the wall it claims —
    // otherwise an authenticated device could inject sync packets into a wall
    // it doesn't belong to (jitter/DoS that wall's playback). Exclusion uses
    // currentDeviceId, never the client-supplied data.device_id.
    socket.on('wall:sync', (data) => {
      try {
      if (!requireDeviceAuth()) return;
      if (!data?.wall_id) return;
      const wall = db.prepare('SELECT * FROM video_walls WHERE id = ?').get(data.wall_id);
      const members = wall ? db.prepare(`
        SELECT vwd.*, d.name AS device_name, d.playlist_id, d.status
        FROM video_wall_devices vwd JOIN devices d ON d.id = vwd.device_id
        WHERE vwd.wall_id = ? ORDER BY vwd.grid_row, vwd.grid_col
      `).all(data.wall_id) : [];
      const layout = wall ? resolveEffectiveLayoutLeaders(parseStoredLayout(wall, members), members) : null;
      const group = groupForDevice(layout, currentDeviceId);
      if (!group || group.layout !== 'span' || group.leader_device_id !== currentDeviceId) return;
      const wallDevices = group.member_ids.filter((id) => id !== currentDeviceId);
      // Stamp device_id with the authenticated id so followers can trust it.
      const payload = { ...data, group_id: group.id, device_id: currentDeviceId };
      for (const deviceId of wallDevices) {
        deviceNs.to(deviceId).emit('wall:sync', payload);
      }
      } catch (e) {
        console.warn(`wall:sync handler error: ${e.message}`);
      }
    });

    // A follower asks for an immediate position update from the leader.
    // Used on (re)connect so the follower doesn't drift for ~1s waiting on
    // the next periodic wall:sync tick. Server forwards only to the leader,
    // and only when the requester is actually a member of the named wall.
    socket.on('wall:sync-request', (data) => {
      try {
        if (!requireDeviceAuth()) return;
        if (!data?.wall_id) return;
        const wall = db.prepare('SELECT * FROM video_walls WHERE id = ?').get(data.wall_id);
        const members = wall ? db.prepare(`
          SELECT vwd.*, d.name AS device_name, d.playlist_id, d.status
          FROM video_wall_devices vwd JOIN devices d ON d.id = vwd.device_id
          WHERE vwd.wall_id = ? ORDER BY vwd.grid_row, vwd.grid_col
        `).all(data.wall_id) : [];
        const layout = wall ? resolveEffectiveLayoutLeaders(parseStoredLayout(wall, members), members) : null;
        const group = groupForDevice(layout, currentDeviceId);
        if (!group || group.layout !== 'span' || group.leader_device_id === currentDeviceId) return;
        deviceNs.to(group.leader_device_id).emit('wall:sync-request', {
          wall_id: data.wall_id,
          group_id: group.id,
          requested_by: currentDeviceId,
        });
      } catch (e) {
        console.warn(`wall:sync-request handler error: ${e.message}`);
      }
    });

    socket.on('disconnect', () => {
      if (!currentDeviceId) return;

      // Stale-disconnect guard: a newer socket already took over this device_id
      // via eviction. Skip the offline transition entirely - don't even start a
      // debounce timer.
      const activeConn = heartbeat.getConnection(currentDeviceId);
      if (activeConn && activeConn.socketId !== socket.id) {
        console.log(`Stale disconnect for ${currentDeviceId} (socket ${socket.id}); active is ${activeConn.socketId}, skipping offline`);
        return;
      }

      const deviceId = currentDeviceId;
      const closingSocketId = socket.id;
      console.log(`Device disconnected: ${deviceId} (offline transition deferred ${OFFLINE_DEBOUNCE_MS}ms)`);

      // Defensive: clear any existing timer for this device. Shouldn't happen
      // (register would have cleared it), but if two disconnects fire in
      // sequence we want the second to refresh the window, not double up.
      if (pendingOfflines.has(deviceId)) clearTimeout(pendingOfflines.get(deviceId));

      pendingOfflines.set(deviceId, setTimeout(() => {
        pendingOfflines.delete(deviceId);
        // Re-check at fire time: did a DIFFERENT socket reclaim during the
        // grace window? If activeConn exists but it's still our (now-closed)
        // socket's entry, the entry is just stale - heartbeat.removeConnection
        // hasn't run yet because we defer it inside this same block. Only
        // abort if a genuinely different socket has registered.
        const activeNow = heartbeat.getConnection(deviceId);
        if (activeNow && activeNow.socketId !== closingSocketId) return;

        db.prepare("UPDATE devices SET status = 'offline', updated_at = strftime('%s','now') WHERE id = ?").run(deviceId);
        heartbeat.removeConnection(deviceId);
        logDeviceStatus(deviceId, 'offline');
        emitToDeviceWorkspace(dashboardNs, deviceId, 'dashboard:device-status', { device_id: deviceId, status: 'offline' });
        scheduleDeviceRoomSnapshot(io, deviceId, 'device:offline');

        // Notify wall peers so their payloads derive the same deterministic
        // online failover leader. The configured leader remains persisted and
        // is never changed by a transient socket disconnect.
        try {
          const wall = db.prepare('SELECT wall_id AS id FROM video_wall_devices WHERE device_id = ?').get(deviceId);
          if (wall) pushEffectiveWallLeadership(deviceNs, wall.id, deviceId);
        } catch (e) { console.error('Wall effective-leader refresh failed:', e.message); }
        void recoverLostAudioOwner(deviceNs, deviceId).catch((error) => {
          console.error(`Audio owner recovery failed for ${deviceId}: ${error.message}`);
        });

        // Save last screenshot to disk as offline snapshot
        const lastB64 = lastScreenshots[deviceId];
        if (lastB64) {
          void persistScreenshot(deviceId, lastB64, Date.now())
            .catch((e) => {
              console.error('Failed to save offline screenshot:', e.message);
            })
            .finally(() => {
              delete lastScreenshots[deviceId];
            });
        }
      }, OFFLINE_DEBOUNCE_MS));
    });
  });

  return deviceNs;
};

// Exposed for focused contract tests and internal reconciliation callers. The
// production export remains the namespace setup function above.
module.exports.buildPlaylistPayload = buildPlaylistPayload;
module.exports.ensureAudioOwnerAfterReconnect = ensureAudioOwnerAfterReconnect;
module.exports.recoverLostAudioOwner = recoverLostAudioOwner;
