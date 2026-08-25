const { db } = require('../db/database');
const config = require('../config');
const { deviceRoom, emitToWorkspace } = require('../lib/socket-rooms');
const { scheduleRoomSnapshot } = require('../lib/room-state-broadcaster');
const { isConnectionAuthoritativeForHeartbeat } = require('../lib/program-receiver-policy');

// Track connected device sockets: deviceId -> { socketId, lastHeartbeat }
const deviceConnections = new Map();

function startHeartbeatChecker(io) {
  setInterval(() => {
    const now = Date.now();
    const dashboardNs = io.of('/dashboard');

    // Check database for devices that should be offline
    const onlineDevices = db.prepare("SELECT id, workspace_id, last_heartbeat FROM devices WHERE status = 'online'").all();

    for (const device of onlineDevices) {
      const conn = deviceConnections.get(device.id);
      // The OBS BrowserSource is intentionally retained while its scene is
      // inactive. Chromium throttles its JavaScript timers, so its authenticated
      // Socket.IO transport is the authoritative liveness signal. A real
      // transport disconnect still flows through the existing offline debounce.
      if (isConnectionAuthoritativeForHeartbeat(device.id, !!conn)) continue;
      const lastBeat = conn ? conn.lastHeartbeat : (device.last_heartbeat ? device.last_heartbeat * 1000 : 0);

      if (now - lastBeat > config.heartbeatTimeout) {
        db.prepare("UPDATE devices SET status = 'offline', updated_at = strftime('%s','now') WHERE id = ?")
          .run(device.id);
        deviceConnections.delete(device.id);

        // Notify dashboard (workspace-scoped via the device's room).
        emitToWorkspace(dashboardNs, deviceRoom(device.id), 'dashboard:device-status', {
          device_id: device.id,
          status: 'offline',
          telemetry: null
        });
        if (device.workspace_id) {
          scheduleRoomSnapshot(io, {
            workspaceId: device.workspace_id,
            roomId: config.console.roomId,
            reason: 'device:heartbeat-timeout',
          }, 100);
        }

        console.log(`Device ${device.id} marked offline (heartbeat timeout)`);
        try {
          db.prepare('INSERT INTO device_status_log (device_id, status) VALUES (?, ?)').run(device.id, 'offline_timeout');
        } catch (_) {}
        try {
          const deviceSocket = require('../ws/deviceSocket');
          if (typeof deviceSocket.recoverLostAudioOwner === 'function') {
            void deviceSocket.recoverLostAudioOwner(io.of('/device'), device.id).catch((error) => {
              console.error(`Heartbeat audio owner recovery failed for ${device.id}: ${error.message}`);
            });
          }
        } catch (error) {
          console.error(`Heartbeat audio owner recovery unavailable for ${device.id}: ${error.message}`);
        }
      }
    }

    // Cleanup: delete unclaimed provisioning devices older than 24 hours
    // Keep imported devices (they have user_id set) so users can re-pair them
    db.prepare(`
      DELETE FROM devices WHERE status = 'provisioning'
      AND user_id IS NULL
      AND created_at < strftime('%s','now') - (365 * 86400)
    `).run();

    // Cleanup: prune play logs older than 90 days
    db.prepare(`
      DELETE FROM play_logs WHERE started_at < strftime('%s','now') - (90 * 86400)
    `).run();

    // Cleanup: expired team invites
    db.prepare(`
      DELETE FROM team_invites WHERE expires_at < strftime('%s','now')
    `).run();

    // Cleanup: expired workspace invites
    db.prepare(`
      DELETE FROM workspace_invites WHERE expires_at < strftime('%s','now')
    `).run();

  }, config.heartbeatInterval);
}

function registerConnection(deviceId, socketId) {
  deviceConnections.set(deviceId, { socketId, lastHeartbeat: Date.now() });
}

function updateHeartbeat(deviceId) {
  const conn = deviceConnections.get(deviceId);
  if (conn) conn.lastHeartbeat = Date.now();
}

function removeConnection(deviceId) {
  deviceConnections.delete(deviceId);
}

function getConnection(deviceId) {
  return deviceConnections.get(deviceId);
}

function getAllConnections() {
  return deviceConnections;
}

module.exports = {
  startHeartbeatChecker,
  registerConnection,
  updateHeartbeat,
  removeConnection,
  getConnection,
  getAllConnections
};
