const heartbeat = require('../services/heartbeat');
const { verifyToken } = require('../middleware/auth');
const { db } = require('../db/database');
const { accessContext, accessibleWorkspaceIds } = require('../lib/tenancy');
const { workspaceRoom, displayRoom, wallTargetRoom, groupRoom, nodeRoom, liveProgramRoom, roomStateRoom, userPrefRoom } = require('../lib/socket-rooms');
const whiteboardState = require('../services/whiteboard-state');
const { profileForDevice } = require('../lib/display-profiles');
const config = require('../config');
const { createLimiter } = require('../lib/socket-rate-limit');
const { audit } = require('../lib/audit');
const { getSocketIp } = require('../services/activity');
const { liveStreamDeviceId, liveStreamProgramState, markLiveContentChanged } = require('../lib/live-stream-display');
const commandModel = require('../lib/command-model');
const deviceContract = require('../player/device-contract');
const { createRoomSnapshot, publishRoomSnapshot } = require('../lib/room-state-broadcaster');
const { getRoomRevision } = require('../lib/room-snapshot');
const {
  TRANSPORT_ACTIONS,
  createLiveTransportMirror,
  createTransportTransactionCoordinator,
} = require('../lib/transport-transaction');

// Phase 2.3: workspace-scoped socket rooms + per-command permission gates.
// Replaces the previous flat dashboardNs.emit broadcast (which leaked every
// device's status/screenshot/playback events to every connected dashboard)
// and the legacy admin/superadmin role bypass (dead code post-Phase-1
// rename - admin -> user, superadmin -> platform_admin).
//
// On connect: enumerate the user's accessible workspace_ids and socket.join
// a room per workspace. Outbound broadcasts route via dashboardNs.to(room).
// Inbound commands check permission against the target device's workspace.

// Permission gate for inbound socket commands. Read tier = workspace_viewer+;
// write tier = workspace_editor+. Platform_admin and org_owner/admin always
// pass via actingAs.
function canActOnDevice(socket, deviceId, tier /* 'read' | 'write' */) {
  const device = db.prepare('SELECT workspace_id FROM devices WHERE id = ?').get(deviceId);
  if (!device || !device.workspace_id) return false;
  const ws = db.prepare('SELECT * FROM workspaces WHERE id = ?').get(device.workspace_id);
  if (!ws) return false;
  const ctx = accessContext(socket.userId, socket.userRole, ws);
  if (!ctx) return false;
  if (ctx.actingAs) return true; // platform_admin or org admin
  if (tier === 'read') return !!ctx.workspaceRole; // viewer/editor/admin all OK
  // write tier: workspace_editor or workspace_admin
  return ctx.workspaceRole === 'workspace_editor' || ctx.workspaceRole === 'workspace_admin';
}

// Phase 3: permission gate for scene (operational_activities) socket commands.
// A scene targets many devices, so the gate is against the SCENE's workspace
// rather than a single device, but uses the identical access-tier logic as
// canActOnDevice (platform/org admin pass via actingAs; write tier requires
// workspace_editor or workspace_admin).
function canActOnScene(socket, activityId, tier /* 'read' | 'write' */) {
  const scene = db.prepare('SELECT workspace_id FROM operational_activities WHERE id = ?').get(activityId);
  if (!scene || !scene.workspace_id) return false;
  const ws = db.prepare('SELECT * FROM workspaces WHERE id = ?').get(scene.workspace_id);
  if (!ws) return false;
  const ctx = accessContext(socket.userId, socket.userRole, ws);
  if (!ctx) return false;
  if (ctx.actingAs) return true;
  if (tier === 'read') return !!ctx.workspaceRole;
  return ctx.workspaceRole === 'workspace_editor' || ctx.workspaceRole === 'workspace_admin';
}

function buildIdentifyPayload(data, deviceId) {
  let label = null;
  try {
    const row = db.prepare('SELECT name FROM devices WHERE id = ?').get(deviceId);
    label = (row && row.name) ? row.name : String(deviceId).slice(0, 8);
  } catch (e) {
    label = String(deviceId).slice(0, 8);
  }

  const payload = { label };
  if (data && data.mode === 'calibration') {
    payload.mode = 'calibration';
    payload.enabled = data.enabled !== false;
    const duration = Number(data.duration_ms);
    payload.duration_ms = Number.isFinite(duration)
      ? Math.max(5000, Math.min(120000, Math.floor(duration)))
      : 30000;
  }
  return payload;
}

module.exports = function setupDashboardSocket(io) {
  const dashboardNs = io.of('/dashboard');
  const deviceNs = io.of('/device');

  // Per-socket token-bucket + queue-depth limiter for display-control events.
  // One instance for the namespace; state is keyed per socket.id and dropped on
  // disconnect. Excess events are rejected (dropped, or ack'd with a reason when
  // the client passed an ack callback) so a flood can't reach a display.
  const controlLimiter = createLimiter({
    ratePerSec: config.socketControlRatePerSec,
    burst: config.socketControlBurst,
    maxDepth: config.socketControlMaxDepth,
  });
  const _sweep = setInterval(() => controlLimiter.sweep(), 30000);
  if (_sweep.unref) _sweep.unref();

  // Audit a state-changing device-control action. Resolves the device's
  // workspace for scope and the socket's client IP for source attribution.
  // Never throws (audit() swallows its own errors). The detail payload is
  // redacted by lib/audit before it touches disk.
  function auditDeviceControl(socket, action, deviceId, details) {
    let workspaceId = null;
    try {
      const d = db.prepare('SELECT workspace_id FROM devices WHERE id = ?').get(deviceId);
      workspaceId = d && d.workspace_id || null;
    } catch (_) { /* non-fatal */ }
    audit({
      actorType: 'user',
      actorId: socket.userId,
      action,
      targetType: 'device',
      targetId: deviceId,
      workspaceId,
      sourceIp: getSocketIp(socket),
      details,
    });
  }

  function workspaceIdForDevice(deviceId, fallback = null) {
    try {
      return db.prepare('SELECT workspace_id FROM devices WHERE id = ?').get(deviceId)?.workspace_id || fallback;
    } catch (_) {
      return fallback;
    }
  }

  const liveTransportMirror = createLiveTransportMirror({
    lookupWorkspace: (deviceId) => workspaceIdForDevice(deviceId),
    getProgramState: (workspaceId) => liveStreamProgramState(workspaceId),
    getLiveDeviceId: (workspaceId) => liveStreamDeviceId(workspaceId),
    markContentChanged: (deviceId) => markLiveContentChanged(deviceId),
    persistCommand: (input) => commandModel.ingestCommand(input),
    isDeviceOnline: (deviceId) => {
      const room = deviceNs.adapter.rooms.get(deviceId);
      return !!(room && room.size > 0);
    },
    emitCommand: (deviceId, envelope) => {
      deviceNs.to(deviceId).emit('device:command', envelope);
    },
    queueCommand: (deviceId, envelope) => {
      try {
        const queue = require('../lib/command-queue');
        return queue.queueCommand(deviceId, 'device:command', envelope);
      } catch (_) {
        return false;
      }
    },
  });

  const transportTransactions = createTransportTransactionCoordinator({
    getDevice: (deviceId) => db.prepare(
      'SELECT id, name, workspace_id FROM devices WHERE id = ?',
    ).get(deviceId) || null,
    listWorkspaceDevices: (workspaceId) => db.prepare(`
      SELECT id, name, workspace_id
      FROM devices
      WHERE workspace_id = ?
        AND id NOT LIKE 'live-stream-program-%'
      ORDER BY name COLLATE NOCASE, id
    `).all(workspaceId),
    getDisplayState: (deviceId) => db.prepare(`
      SELECT current_content_id, current_asset_id, slide_index, slide_count,
             current_time, duration, paused, playback_revision, command_revision,
             state_revision
      FROM display_states
      WHERE target_type = 'display' AND target_id = ?
    `).get(deviceId) || null,
    getLiveState: (workspaceId) => liveStreamProgramState(workspaceId),
    getRoomRevision: (workspaceId, roomId) => getRoomRevision(
      db,
      workspaceId,
      roomId || config.roomId || 'classroom-1',
    ),
    getContentGeneration: (contentId) => {
      if (!contentId) return null;
      try {
        return db.prepare('SELECT version FROM content WHERE id = ?').get(contentId)?.version ?? null;
      } catch (_) {
        return null;
      }
    },
    isDeviceOnline: (deviceId) => {
      const room = deviceNs.adapter.rooms.get(deviceId);
      return Boolean(room && room.size > 0);
    },
    emitToDevice: (deviceId, envelope) => {
      deviceNs.to(deviceId).emit('device:command', envelope);
    },
    queueToDevice: (deviceId, envelope) => {
      try {
        const queue = require('../lib/command-queue');
        return queue.queueCommand(deviceId, 'device:command', envelope);
      } catch (_) {
        return false;
      }
    },
    ingestCommand: (values) => commandModel.ingestCommand(values),
    createCommand: (values) => deviceContract.createCommand(values),
    resolveAudioAuthority: (devices) => commandModel.resolveClassroomAudioAuthority(devices),
  });

  // Build a per-socket registrar for rate-limited control events. Each accepted
  // event consumes a token + a depth slot (released when the handler returns).
  // On reject: if the client supplied an ack callback (last arg is a function),
  // call it with { delivered:false, reason }; otherwise the event is silently
  // dropped (fire-and-forget events like remote-touch / wb-stroke). Handler
  // bodies are unchanged — they still close over `socket` — so this is a drop-in
  // swap of `socket.on(` for `onControl(`.
  function makeOnControl(socket) {
    return function onControl(event, handler) {
      socket.on(event, (...args) => {
        const ack = typeof args[args.length - 1] === 'function' ? args[args.length - 1] : null;
        const verdict = controlLimiter.tryConsume(socket.id);
        if (!verdict.allowed) {
          if (ack) ack({ delivered: false, reason: verdict.reason });
          return;
        }
        try {
          return handler(...args);
        } finally {
          verdict.release();
        }
      });
    };
  }

  dashboardNs.use((socket, next) => {
    const token = socket.handshake.auth?.token;
    if (!token) return next(new Error('Authentication required'));
    try {
      const decoded = verifyToken(token);
      socket.userId = decoded.id;
      socket.userRole = decoded.role;
      socket.requestedWorkspaceId = decoded.current_workspace_id || null;
      next();
    } catch {
      next(new Error('Invalid token'));
    }
  });

  dashboardNs.on('connection', (socket) => {
    // Note on workspace-switch lifecycle: the switcher (Phase 3 MVP) calls
    // window.location.reload() after switching, which forces a new socket
    // connection with fresh JWT claims. So workspace memberships are
    // re-evaluated at connect time and we don't need to re-evaluate per-emit.
    const wsIds = accessibleWorkspaceIds(socket.userId, socket.userRole);
    for (const wsId of wsIds) socket.join(workspaceRoom(wsId));
    const roomWorkspaceId = wsIds.includes(socket.requestedWorkspaceId)
      ? socket.requestedWorkspaceId
      : (wsIds[0] || null);
    const roomId = config.console.roomId;
    socket.roomWorkspaceId = roomWorkspaceId;
    socket.roomId = roomId;
    if (roomWorkspaceId) socket.join(roomStateRoom(roomWorkspaceId, roomId));
    // Join the per-user preference room for cross-session convergence (task §11).
    socket.join(userPrefRoom(socket.userId));
    console.log(`Dashboard client connected: ${socket.id} (user: ${socket.userId}, rooms: ${wsIds.length})`);

    function sendAuthoritativeRoomSnapshot(minimumTimestamp = 0) {
      if (!socket.roomWorkspaceId) return null;
      const snapshot = createRoomSnapshot({
        workspaceId: socket.roomWorkspaceId,
        roomId: socket.roomId,
      });
      snapshot.serverTimestamp = Math.max(
        Number(snapshot.serverTimestamp) || 0,
        (Number(minimumTimestamp) || 0) + 1,
      );
      socket.emit('room:snapshot', snapshot);
      return snapshot;
    }

    // Initial full truth is delivered on every connection. A reconnecting
    // client can then submit its last accepted revision; equal revisions get a
    // compact resume acknowledgement, while any mismatch receives full truth.
    sendAuthoritativeRoomSnapshot();
    let lastRoomResumeAt = 0;
    socket.on('dashboard:room-resume', (data) => {
      if (!socket.roomWorkspaceId) return;
      const now = Date.now();
      if (data?.force !== true && now - lastRoomResumeAt < 250) return;
      lastRoomResumeAt = now;
      const currentRevision = getRoomRevision(db, socket.roomWorkspaceId, socket.roomId);
      const requestedRevision = Number(data?.revision);
      if (data?.force === true) {
        sendAuthoritativeRoomSnapshot(data?.snapshot_timestamp);
        return;
      }
      if (Number.isInteger(requestedRevision) && requestedRevision === currentRevision) {
        socket.emit('room:resumed', {
          schemaVersion: 1,
          workspaceId: socket.roomWorkspaceId,
          roomId: socket.roomId,
          revision: currentRevision,
        });
        return;
      }
      sendAuthoritativeRoomSnapshot();
    });

    // Phase 2: dashboard selects the target it's currently controlling. It
    // joins the matching per-target room (display:<id>|wall:<id>|group:<id>|
    // node:<id>|live-program:<ws>) and leaves the previously-joined target
    // room so events from the old target stop arriving. Membership in the
    // target room is what delivers dashboard:state-sync, command:ack and the
    // existing dashboard:device-status broadcasts.
    function resolveTargetRoom(target_type, target_id) {
      switch (target_type) {
        case 'display': return displayRoom(target_id);
        case 'wall':    return wallTargetRoom(target_id);
        case 'group':   return groupRoom(target_id);
        case 'node':    return nodeRoom(target_id);
        case 'live-program': return liveProgramRoom(target_id);
        default: return null;
      }
    }

    function workspaceForTarget(targetType, targetId) {
      try {
        if (targetType === 'display') {
          return db.prepare('SELECT workspace_id FROM devices WHERE id = ?').get(targetId)?.workspace_id || null;
        }
        if (targetType === 'wall') {
          return db.prepare('SELECT workspace_id FROM video_walls WHERE id = ?').get(targetId)?.workspace_id || null;
        }
        if (targetType === 'group') {
          return db.prepare('SELECT workspace_id FROM device_groups WHERE id = ?').get(targetId)?.workspace_id || null;
        }
        if (targetType === 'node') {
          return db.prepare('SELECT workspace_id FROM managed_nodes WHERE node_id = ?').get(targetId)?.workspace_id || null;
        }
        if (targetType === 'live-program') return String(targetId || '');
      } catch (_) { /* reject below */ }
      return null;
    }

    socket.on('dashboard:select-target', (data) => {
      const target_type = data && data.target_type;
      const target_id = data && data.target_id;
      const newRoom = resolveTargetRoom(target_type, target_id);
      if (!newRoom) return;
      if (socket.currentTargetRoom === newRoom
          && socket.currentTarget?.target_type === target_type
          && socket.currentTarget?.target_id === target_id) return;
      if (workspaceForTarget(target_type, target_id) !== socket.roomWorkspaceId) {
        socket.emit('dashboard:target-rejected', { target_type, target_id, reason: 'forbidden' });
        return;
      }
      const prev = socket.currentTargetRoom;
      if (prev && prev !== newRoom) {
        try { socket.leave(prev); } catch (e) { /* non-fatal */ }
      }
      socket.join(newRoom);
      socket.currentTargetRoom = newRoom;
      socket.currentTarget = { target_type, target_id };
      console.log(`Dashboard ${socket.id} selected target ${target_type}:${target_id} (room ${newRoom})`);
    });

    socket.on('dashboard:clear-target', () => {
      if (socket.currentTargetRoom) {
        try { socket.leave(socket.currentTargetRoom); } catch (e) { /* non-fatal */ }
      }
      socket.currentTargetRoom = null;
      socket.currentTarget = null;
    });

    // Rate-limited registrar for display-control events (token bucket + queue
    // depth, per socket). Non-control events (none here) would use socket.on.
    const onControl = makeOnControl(socket);

    onControl('dashboard:request-screenshot', (data) => {
      const { device_id, correlation_id } = data;
      if (!canActOnDevice(socket, device_id, 'read')) return;
      const conn = heartbeat.getConnection(device_id);
      if (conn) {
        deviceNs.to(device_id).emit('device:screenshot-request', {
          correlation_id: correlation_id || null,
        });
      }
    });

    onControl('dashboard:remote-touch', (data) => {
      const { device_id, x, y, action } = data;
      if (!canActOnDevice(socket, device_id, 'write')) return;
      deviceNs.to(device_id).emit('device:remote-touch', { x, y, action });
    });

    onControl('dashboard:remote-key', (data) => {
      const { device_id, keycode } = data;
      if (!canActOnDevice(socket, device_id, 'write')) return;
      console.log(`Remote key: ${keycode} -> ${device_id}`);
      deviceNs.to(device_id).emit('device:remote-key', { keycode });
    });

    onControl('dashboard:remote-start', (data) => {
      const { device_id } = data;
      if (!canActOnDevice(socket, device_id, 'write')) return;
      const room = deviceNs.adapter.rooms.get(device_id);
      console.log(`Remote start for ${device_id}, room has ${room?.size || 0} socket(s)`);
      deviceNs.to(device_id).emit('device:remote-start', {});
      console.log(`Remote session started for device ${device_id}`);
      auditDeviceControl(socket, 'display.remote_start', device_id, {});
    });

    onControl('dashboard:remote-stop', (data) => {
      const { device_id } = data;
      if (!canActOnDevice(socket, device_id, 'write')) return;
      deviceNs.to(device_id).emit('device:remote-stop', {});
      console.log(`Remote session stopped for device ${device_id}`);
      auditDeviceControl(socket, 'display.remote_stop', device_id, {});
    });

    // Phase 2 (display self-report): flash an on-screen marker on a chosen
    // display so an admin can physically identify which panel is which.
    // Same write-tier gate + device-room emit pattern as dashboard:remote-*.
    // The label defaults to the device name (or a short id suffix) so the
    // player can render a human-readable badge.
    onControl('dashboard:identify', (data) => {
      const { device_id } = data || {};
      if (!canActOnDevice(socket, device_id, 'write')) return;
      const payload = buildIdentifyPayload(data, device_id);
      deviceNs.to(device_id).emit('device:identify', payload);
      console.log(`Identify flashed on device ${device_id} (mode: ${payload.mode || 'identify'}, label: ${payload.label})`);
    });

    // Phase 6 (Smartboard): relay whiteboard control/draw events from the
    // dashboard SPA to a single display on the /device namespace. Reuses the
    // exact write-tier gate + device-room emit pattern as dashboard:remote-* /
    // dashboard:identify (no new namespace). Coordinates in each stroke are
    // normalized 0..1 and are relayed verbatim; the player scales them by its
    // overlay canvas dimensions.
    onControl('dashboard:wb-start', (data, ack) => {
      const { device_id } = data || {};
      if (!canActOnDevice(socket, device_id, 'write')) {
        if (typeof ack === 'function') ack({ ok: false, error: 'forbidden' });
        return;
      }
      const device = db.prepare('SELECT id, name, workspace_id FROM devices WHERE id = ?').get(device_id);
      const session = whiteboardState.startSession(device && device.workspace_id, device_id);
      const profile = profileForDevice(device);
      const payload = {
        strokes: session.strokes,
        touch_enabled: !!profile,
        display_profile: profile,
        mode: data && data.mode === 'blank' ? 'blank' : 'overlay',
      };
      relayToTargets('device:wb-show', payload, wbTargets(data, device_id));
      if (typeof ack === 'function') ack({ ok: true, ...payload });
      console.log(`Whiteboard started on device ${device_id}`);
    });

    // Resolve the set of device rooms a whiteboard event should fan out to,
    // based on the envelope the controller sent:
    //   - split_device_id present → ONLY that one member TV (wall split mode)
    //   - wall_id present        → every member TV of the wall (span mode, so a
    //                              stroke composes across all screens at once)
    //   - otherwise              → just device_id (the legacy single-target path)
    // All lookups wrapped so a malformed/unknown wall id degrades silently to
    // the single-target default rather than dropping the event entirely.
    function wbTargets(data, deviceId) {
      try {
        if (data && data.split_device_id) return [String(data.split_device_id)];
        if (data && data.wall_id && data.group_id) {
          const { parseStoredLayout } = require('../lib/wall-layout');
          const wall = db.prepare('SELECT * FROM video_walls WHERE id = ?').get(data.wall_id);
          const members = wall ? db.prepare(`
            SELECT vwd.*, d.name AS device_name, d.playlist_id
            FROM video_wall_devices vwd JOIN devices d ON d.id = vwd.device_id
            WHERE vwd.wall_id = ? ORDER BY vwd.grid_row, vwd.grid_col
          `).all(data.wall_id) : [];
          const layout = wall ? parseStoredLayout(wall, members) : null;
          const group = layout?.groups?.find((candidate) => candidate.id === data.group_id);
          if (group) return group.member_ids;
        }
        if (data && data.wall_id) {
          const members = db.prepare('SELECT device_id FROM video_wall_devices WHERE wall_id = ?').all(data.wall_id);
          const ids = members.map(r => r.device_id);
          if (ids.length > 0) return ids;
        }
      } catch { /* fall through to default */ }
      return deviceId ? [deviceId] : [];
    }

    function relayToTargets(event, payload, targets) {
      for (const id of targets) {
        try { deviceNs.to(id).emit(event, payload); } catch { /* one bad target never blocks the rest */ }
      }
    }

    onControl('dashboard:wb-stroke', (data) => {
      try {
        const { device_id, stroke } = data || {};
        if (!canActOnDevice(socket, device_id, 'write')) return;
        const safeStroke = whiteboardState.appendStroke(null, device_id, stroke);
        if (!safeStroke) return;
        const memberStrokes = data && typeof data.member_strokes === 'object' ? data.member_strokes : {};
        for (const id of wbTargets(data, device_id)) {
          const hasMemberStrokes = Object.keys(memberStrokes).length > 0;
          const localStroke = hasMemberStrokes
            ? whiteboardState.normalizeStroke(memberStrokes[id])
            : safeStroke;
          if (!localStroke) continue;
          relayToTargets('device:wb-stroke', { stroke: localStroke }, [id]);
        }
      } catch (e) {
        console.warn(`dashboard:wb-stroke relay error: ${e.message}`);
      }
    });

    onControl('dashboard:wb-clear', (data) => {
      try {
        const { device_id } = data || {};
        if (!canActOnDevice(socket, device_id, 'write')) return;
        whiteboardState.clearSession(null, device_id);
        relayToTargets('device:wb-clear', {}, wbTargets(data, device_id));
      } catch (e) {
        console.warn(`dashboard:wb-clear relay error: ${e.message}`);
      }
    });

    onControl('dashboard:wb-undo', (data) => {
      try {
        const { device_id } = data || {};
        if (!canActOnDevice(socket, device_id, 'write')) return;
        whiteboardState.undoStroke(null, device_id);
        relayToTargets('device:wb-undo', {}, wbTargets(data, device_id));
      } catch (e) {
        console.warn(`dashboard:wb-undo relay error: ${e.message}`);
      }
    });

    onControl('dashboard:wb-redo', (data) => {
      try {
        const { device_id } = data || {};
        if (!canActOnDevice(socket, device_id, 'write')) return;
        const redone = whiteboardState.redoStroke(null, device_id);
        relayToTargets('device:wb-redo', { stroke: redone }, wbTargets(data, device_id));
      } catch (e) {
        console.warn(`dashboard:wb-redo relay error: ${e.message}`);
      }
    });

    onControl('dashboard:wb-stop', (data) => {
      const { device_id } = data || {};
      if (!canActOnDevice(socket, device_id, 'write')) return;
      relayToTargets('device:wb-stop', {}, wbTargets(data, device_id));
      console.log(`Whiteboard stopped on device ${device_id}`);
    });

    // Canonical workspace transport path: one operator action owns one
    // idempotency key and one shared content/revision/generation context across
    // every classroom renderer plus the managed Live Program receiver.
    onControl('dashboard:transport-transaction', (data, ack) => {
      const deviceIds = [...new Set(
        (Array.isArray(data?.device_ids) ? data.device_ids : [])
          .filter(Boolean)
          .map(String),
      )];
      if (!deviceIds.length) {
        if (typeof ack === 'function') ack({ ok: false, reason: 'missing_device_ids', targets: [] });
        return;
      }
      if (deviceIds.some((deviceId) => !canActOnDevice(socket, deviceId, 'write'))) {
        if (typeof ack === 'function') ack({ ok: false, reason: 'forbidden', targets: [] });
        return;
      }
      const firstDevice = db.prepare(
        'SELECT workspace_id FROM devices WHERE id = ?',
      ).get(deviceIds[0]);
      const workspaceId = firstDevice?.workspace_id || null;
      const payload = data?.payload && typeof data.payload === 'object'
        ? { ...data.payload }
        : {};
      const result = transportTransactions.dispatch({
        workspaceId,
        roomId: data?.room_id || socket.roomId,
        deviceIds,
        action: data?.action || payload.action,
        payload,
        issuedBy: socket.userId,
        idempotencyKey: data?.idempotency_key,
        contentInstanceId: data?.content_instance_id,
        expectedRevision: data?.expected_revision,
        expectedGeneration: data?.expected_generation,
      });
      if (!result.ok) {
        if (typeof ack === 'function') ack({ ...result, reason: result.error || 'transport_failed' });
        return;
      }
      for (const deviceId of deviceIds) {
        const target = result.targets.find((entry) => entry.device_id === deviceId);
        auditDeviceControl(socket, 'display.transport', deviceId, {
          type: result.action,
          command_id: target?.command_id || null,
          transport_transaction_id: result.transaction_id,
          delivered: target?.delivered === true,
          queued: target?.queued === true,
        });
      }
      publishRoomSnapshot(io, {
        workspaceId,
        roomId: data?.room_id || socket.roomId,
        reason: `transport:${result.action}`,
        bump: true,
      });
      if (typeof ack === 'function') ack(result);
    });

    onControl('dashboard:device-command', (data, ack) => {
      const { device_id } = data || {};
      if (!canActOnDevice(socket, device_id, 'write')) {
        if (typeof ack === 'function') ack({ delivered: false, reason: 'forbidden' });
        return;
      }
      const normalized = deviceContract.normalizeCommand(data && data.envelope ? data.envelope : data, {
        device_id,
        target_scope: 'display',
      });
      if (!normalized.ok) {
        if (typeof ack === 'function') ack({ delivered: false, reason: normalized.error.code, error: normalized.error });
        return;
      }
      const envelope = normalized.value;
      if (normalized.legacy) {
        console.warn(`[device-contract] normalized legacy dashboard command for ${device_id}`);
      }
      // Preserve explicit classroom targeting become authority on the player.
      // Client payload fields win; never invent a different zone from "last click".
      const incomingPayload = (data && data.payload && typeof data.payload === 'object') ? data.payload : {};
      const targetKeys = [
        'workspace_id', 'room_id', 'wall_id', 'zone_id', 'cell_id',
        'content_instance_id', 'content_id', 'expected_revision',
      ];
      for (const key of targetKeys) {
        const incoming = incomingPayload[key] ?? (data && data[key]);
        if (incoming != null && incoming !== '' && envelope.payload[key] == null) {
          envelope.payload[key] = incoming;
        }
      }
      if (envelope.payload.device_id == null) envelope.payload.device_id = device_id;
      // Reject wall-level payloads that claim a zone without a base target.
      if ((envelope.payload.zone_id || envelope.payload.cell_id) && !device_id) {
        if (typeof ack === 'function') ack({ delivered: false, reason: 'ambiguous_target' });
        return;
      }
      const room = deviceNs.adapter.rooms.get(device_id);
      const commandType = String(envelope.payload.action).toLowerCase();
      const requiresAck = 1;
      // Deployed dashboards historically sent one transport command per
      // physical screen. Fold that short burst into one shared transaction so
      // Live Program receives exactly one absolute command.
      if (TRANSPORT_ACTIONS.has(commandType)) {
        const workspaceId = workspaceIdForDevice(device_id, socket.roomWorkspaceId);
        const result = transportTransactions.dispatchLegacyTarget({
          workspaceId,
          roomId: envelope.payload.room_id || socket.roomId,
          deviceId: device_id,
          action: commandType,
          payload: envelope.payload,
          issuedBy: socket.userId,
          commandId: envelope.command_id,
        });
        const target = result.targets?.find((entry) => entry.device_id === device_id) || null;
        if (!result.ok || !target) {
          if (typeof ack === 'function') {
            ack({
              delivered: false,
              reason: result.error || 'transport_failed',
              transport_transaction: result,
            });
          }
          return;
        }
        if (typeof ack === 'function') {
          ack({
            delivered: target.delivered,
            queued: target.queued,
            reason: target.reason || null,
            command_id: target.command_id,
            transport_transaction: result,
          });
        }
        auditDeviceControl(socket, 'display.transport', device_id, {
          type: result.action,
          command_id: target.command_id,
          transport_transaction_id: result.transaction_id,
          delivered: target.delivered,
          queued: target.queued,
        });
        publishRoomSnapshot(io, {
          workspaceId,
          roomId: envelope.payload.room_id || socket.roomId,
          reason: `transport:${result.action}`,
          bump: true,
        });
        return;
      }
      if (room && room.size > 0) {
        let cmd = null;
        try { cmd = commandModel.ingestCommand({
          target_type: 'display', target_id: device_id, command_type: commandType,
          payload: envelope.payload, issued_by: socket.userId, requires_ack: requiresAck,
          command_id: envelope.command_id, created_at: Date.parse(envelope.issued_at),
        }); } catch (e) {
          if (typeof ack === 'function') ack({ delivered: false, reason: 'persistence_failed' });
          console.error(`[device-contract] command persistence failed for ${device_id}/${envelope.command_id}: ${e.message}`);
          return;
        }
        deviceNs.to(device_id).emit('device:command', envelope);
        const liveProgramResult = liveTransportMirror.dispatch({
          sourceDeviceId: device_id,
          envelope,
          userId: socket.userId,
        });
        console.log(`[device-contract] delivered ${envelope.command_id} ${commandType} to ${device_id}`);
        if (typeof ack === 'function') {
          ack({
            delivered: true,
            command_id: cmd ? cmd.command_id : null,
            live_program: liveProgramResult,
          });
        }
        auditDeviceControl(socket, 'display.command', device_id, { type: commandType, command_id: envelope.command_id, delivered: true });
        // Unified dashboard: record authoritative on/off ONLY when actually delivered
        // to a live display. Never write it for a merely-queued command — that would
        // make the dashboard lie about reality.
        if (commandType === 'screen_off' || commandType === 'screen_on') {
          try {
            db.prepare("UPDATE devices SET screen_on = ?, updated_at = strftime('%s','now') WHERE id = ?")
              .run(commandType === 'screen_on' ? 1 : 0, device_id);
          } catch (_) { /* non-fatal */ }
        }
        publishRoomSnapshot(io, {
          workspaceId: workspaceIdForDevice(device_id, socket.roomWorkspaceId),
          roomId: socket.roomId,
          reason: `command:${commandType}`,
          bump: true,
        });
        return;
      }
      // Device offline at emit time. Try to queue (lazy require so reverting
      // the queue commit doesn't break this commit - MODULE_NOT_FOUND on the
      // first try gets cached by Node's module loader, giving consistent
      // queued=false behavior on every subsequent call). Ingest the command
      // row anyway so the audit trail shows it was issued (fire-and-forget:
      // requires_ack=0, so it never times out).
      try { commandModel.ingestCommand({
        target_type: 'display', target_id: device_id, command_type: commandType,
        payload: envelope.payload, issued_by: socket.userId, requires_ack: 0,
        command_id: envelope.command_id, created_at: Date.parse(envelope.issued_at),
      }); } catch (e) { /* best-effort */ }
      let queued = false;
      try {
        const queue = require('../lib/command-queue');
        queued = queue.queueCommand(device_id, 'device:command', envelope);
      } catch (e) { /* command-queue module absent; fall through to lost */ }
      console.log(`Command for offline device ${device_id}: ${commandType} (queued=${queued})`);
      const liveProgramResult = liveTransportMirror.dispatch({
        sourceDeviceId: device_id,
        envelope,
        userId: socket.userId,
      });
      publishRoomSnapshot(io, {
        workspaceId: workspaceIdForDevice(device_id, socket.roomWorkspaceId),
        roomId: socket.roomId,
        reason: `command:${commandType}:queued`,
        bump: true,
      });
      if (typeof ack === 'function') {
        ack({
          delivered: false,
          queued,
          reason: 'offline',
          command_id: envelope.command_id,
          live_program: liveProgramResult,
        });
      }
      auditDeviceControl(socket, 'display.command', device_id, { type: commandType, command_id: envelope.command_id, delivered: false, queued });
    });

    // Phase 3: trigger an Operational Activity ("Scene") — pushes the scene to
    // all its displays via the existing device-content-push path. Permission
    // gate mirrors the write tier used by dashboard:remote-* / device-command,
    // but checked against the SCENE's workspace (a scene targets many devices)
    // rather than a single device. Follows the same ack-callback shape as
    // dashboard:device-command.
    onControl('dashboard:scene-trigger', (data, ack) => {
      const { activityId } = data || {};
      if (!activityId) {
        if (typeof ack === 'function') ack({ delivered: false, reason: 'missing_activity_id' });
        return;
      }
      if (!canActOnScene(socket, activityId, 'write')) {
        if (typeof ack === 'function') ack({ delivered: false, reason: 'forbidden' });
        return;
      }
      try {
        const sceneEngine = require('../services/scene-engine');
        const scene = db.prepare(`SELECT oa.workspace_id, w.organization_id
          FROM operational_activities oa JOIN workspaces w ON w.id = oa.workspace_id
          WHERE oa.id = ?`).get(activityId);
        const access = scene && accessContext(socket.userId, socket.userRole, { id: scene.workspace_id, organization_id: scene.organization_id });
        const orgMembership = scene && db.prepare(`SELECT role FROM organization_members
          WHERE organization_id = ? AND user_id = ?`).get(scene.organization_id, socket.userId);
        const result = sceneEngine.triggerScene(io, activityId, {
          userId: socket.userId,
          userRole: socket.userRole,
          workspaceId: scene?.workspace_id || null,
          organizationId: scene?.organization_id || null,
          workspaceRole: access?.workspaceRole || null,
          orgRole: orgMembership?.role || null,
          isPlatformAdmin: ['platform_admin', 'superadmin'].includes(socket.userRole),
        });
        console.log(`Scene triggered ${activityId}: pushed=${result.pushed}, failed=${result.failed}`);
        if (typeof ack === 'function') ack({ delivered: true, ...result });
        let sceneWs = null;
        try { sceneWs = (db.prepare('SELECT workspace_id FROM operational_activities WHERE id = ?').get(activityId) || {}).workspace_id || null; } catch (_) {}
        if (sceneWs) {
          publishRoomSnapshot(io, {
            workspaceId: sceneWs,
            roomId: socket.roomId,
            reason: 'scene:triggered',
            bump: true,
          });
        }
        audit({
          actorType: 'user', actorId: socket.userId, action: 'scene.trigger',
          targetType: 'scene', targetId: activityId, workspaceId: sceneWs,
          sourceIp: getSocketIp(socket), details: { pushed: result.pushed, failed: result.failed },
        });
      } catch (e) {
        console.error(`dashboard:scene-trigger failed for ${activityId}: ${e.message}`);
        if (typeof ack === 'function') ack({ delivered: false, reason: 'error' });
      }
    });

    socket.on('disconnect', () => {
      controlLimiter.forget(socket.id);
      console.log(`Dashboard client disconnected: ${socket.id}`);
    });
  });

  return dashboardNs;
};

