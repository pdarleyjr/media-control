const heartbeat = require('../services/heartbeat');
const { verifyToken } = require('../middleware/auth');
const { db } = require('../db/database');
const { accessContext, accessibleWorkspaceIds } = require('../lib/tenancy');
const { workspaceRoom } = require('../lib/socket-rooms');
const whiteboardState = require('../services/whiteboard-state');
const { profileForDevice } = require('../lib/display-profiles');

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

  dashboardNs.use((socket, next) => {
    const token = socket.handshake.auth?.token;
    if (!token) return next(new Error('Authentication required'));
    try {
      const decoded = verifyToken(token);
      socket.userId = decoded.id;
      socket.userRole = decoded.role;
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
    console.log(`Dashboard client connected: ${socket.id} (user: ${socket.userId}, rooms: ${wsIds.length})`);

    socket.on('dashboard:request-screenshot', (data) => {
      const { device_id } = data;
      if (!canActOnDevice(socket, device_id, 'read')) return;
      const conn = heartbeat.getConnection(device_id);
      if (conn) deviceNs.to(device_id).emit('device:screenshot-request', {});
    });

    socket.on('dashboard:remote-touch', (data) => {
      const { device_id, x, y, action } = data;
      if (!canActOnDevice(socket, device_id, 'write')) return;
      deviceNs.to(device_id).emit('device:remote-touch', { x, y, action });
    });

    socket.on('dashboard:remote-key', (data) => {
      const { device_id, keycode } = data;
      if (!canActOnDevice(socket, device_id, 'write')) return;
      console.log(`Remote key: ${keycode} -> ${device_id}`);
      deviceNs.to(device_id).emit('device:remote-key', { keycode });
    });

    socket.on('dashboard:remote-start', (data) => {
      const { device_id } = data;
      if (!canActOnDevice(socket, device_id, 'write')) return;
      const room = deviceNs.adapter.rooms.get(device_id);
      console.log(`Remote start for ${device_id}, room has ${room?.size || 0} socket(s)`);
      deviceNs.to(device_id).emit('device:remote-start', {});
      console.log(`Remote session started for device ${device_id}`);
    });

    socket.on('dashboard:remote-stop', (data) => {
      const { device_id } = data;
      if (!canActOnDevice(socket, device_id, 'write')) return;
      deviceNs.to(device_id).emit('device:remote-stop', {});
      console.log(`Remote session stopped for device ${device_id}`);
    });

    // Phase 2 (display self-report): flash an on-screen marker on a chosen
    // display so an admin can physically identify which panel is which.
    // Same write-tier gate + device-room emit pattern as dashboard:remote-*.
    // The label defaults to the device name (or a short id suffix) so the
    // player can render a human-readable badge.
    socket.on('dashboard:identify', (data) => {
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
    socket.on('dashboard:wb-start', (data, ack) => {
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
      };
      deviceNs.to(device_id).emit('device:wb-show', payload);
      if (typeof ack === 'function') ack({ ok: true, ...payload });
      console.log(`Whiteboard started on device ${device_id}`);
    });

    socket.on('dashboard:wb-stroke', (data) => {
      const { device_id, stroke } = data || {};
      if (!canActOnDevice(socket, device_id, 'write')) return;
      const safeStroke = whiteboardState.appendStroke(null, device_id, stroke);
      if (!safeStroke) return;
      deviceNs.to(device_id).emit('device:wb-stroke', { stroke: safeStroke });
    });

    socket.on('dashboard:wb-clear', (data) => {
      const { device_id } = data || {};
      if (!canActOnDevice(socket, device_id, 'write')) return;
      whiteboardState.clearSession(null, device_id);
      deviceNs.to(device_id).emit('device:wb-clear', {});
    });

    socket.on('dashboard:wb-undo', (data) => {
      const { device_id } = data || {};
      if (!canActOnDevice(socket, device_id, 'write')) return;
      whiteboardState.undoStroke(null, device_id);
      deviceNs.to(device_id).emit('device:wb-undo', {});
    });

    socket.on('dashboard:wb-stop', (data) => {
      const { device_id } = data || {};
      if (!canActOnDevice(socket, device_id, 'write')) return;
      deviceNs.to(device_id).emit('device:wb-stop', {});
      console.log(`Whiteboard stopped on device ${device_id}`);
    });

    socket.on('dashboard:device-command', (data, ack) => {
      const { device_id, type, payload } = data;
      if (!canActOnDevice(socket, device_id, 'write')) {
        if (typeof ack === 'function') ack({ delivered: false, reason: 'forbidden' });
        return;
      }
      const room = deviceNs.adapter.rooms.get(device_id);
      if (room && room.size > 0) {
        deviceNs.to(device_id).emit('device:command', { type, payload });
        console.log(`Command delivered to device ${device_id}: ${type}`);
        if (typeof ack === 'function') ack({ delivered: true });
        // Unified dashboard: record authoritative on/off ONLY when actually delivered
        // to a live display. Never write it for a merely-queued command — that would
        // make the dashboard lie about reality.
        if (type === 'screen_off' || type === 'screen_on') {
          try {
            db.prepare("UPDATE devices SET screen_on = ?, updated_at = strftime('%s','now') WHERE id = ?")
              .run(type === 'screen_on' ? 1 : 0, device_id);
          } catch (_) { /* non-fatal */ }
        }
        return;
      }
      // Device offline at emit time. Try to queue (lazy require so reverting
      // the queue commit doesn't break this commit - MODULE_NOT_FOUND on the
      // first try gets cached by Node's module loader, giving consistent
      // queued=false behavior on every subsequent call).
      let queued = false;
      try {
        const queue = require('../lib/command-queue');
        queued = queue.queueCommand(device_id, type, payload);
      } catch (e) { /* command-queue module absent; fall through to lost */ }
      console.log(`Command for offline device ${device_id}: ${type} (queued=${queued})`);
      if (typeof ack === 'function') ack({ delivered: false, queued, reason: 'offline' });
    });

    // Phase 3: trigger an Operational Activity ("Scene") — pushes the scene to
    // all its displays via the existing device-content-push path. Permission
    // gate mirrors the write tier used by dashboard:remote-* / device-command,
    // but checked against the SCENE's workspace (a scene targets many devices)
    // rather than a single device. Follows the same ack-callback shape as
    // dashboard:device-command.
    socket.on('dashboard:scene-trigger', (data, ack) => {
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
        const result = sceneEngine.triggerScene(io, activityId);
        console.log(`Scene triggered ${activityId}: pushed=${result.pushed}, failed=${result.failed}`);
        if (typeof ack === 'function') ack({ delivered: true, ...result });
      } catch (e) {
        console.error(`dashboard:scene-trigger failed for ${activityId}: ${e.message}`);
        if (typeof ack === 'function') ack({ delivered: false, reason: 'error' });
      }
    });

    socket.on('disconnect', () => {
      console.log(`Dashboard client disconnected: ${socket.id}`);
    });
  });

  return dashboardNs;
};

