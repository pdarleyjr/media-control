/**
 * Shared workspace permission gate for Socket.IO event handlers.
 *
 * Extracted from ws/dashboardSocket.js so multiple socket modules
 * (dashboard remote-control, screen-share signaling, future features) all
 * enforce the SAME isolation rules with no drift. Defense in depth: server
 * verifies every command against the target device's workspace, regardless
 * of which room the socket happens to be in.
 *
 * Read tier  = workspace_viewer or above (read-only operations)
 * Write tier = workspace_editor or workspace_admin (mutations / device control)
 *
 * Platform_admin and organization owner/admin always pass via accessContext's
 * actingAs flag.
 */
const { db } = require('../db/database');
const { accessContext } = require('./tenancy');

function canActOnDevice(socket, deviceId, tier /* 'read' | 'write' */) {
  const device = db.prepare('SELECT workspace_id FROM devices WHERE id = ?').get(deviceId);
  if (!device || !device.workspace_id) return false;
  const ws = db.prepare('SELECT * FROM workspaces WHERE id = ?').get(device.workspace_id);
  if (!ws) return false;
  const ctx = accessContext(socket.userId, socket.userRole, ws);
  if (!ctx) return false;
  if (ctx.actingAs) return true; // platform_admin or org admin
  if (tier === 'read') return !!ctx.workspaceRole; // viewer/editor/admin all OK
  return ctx.workspaceRole === 'workspace_editor' || ctx.workspaceRole === 'workspace_admin';
}

/**
 * Resolve the authenticated device_id for a /device-namespace socket.
 *
 * The device socket auth flow in ws/deviceSocket.js calls socket.join(deviceId)
 * once authentication completes. We derive the id from socket.rooms (which is
 * a Set containing the default socket.id plus any joined rooms). This avoids
 * needing to plumb a separate registry through.
 *
 * Returns null if the socket hasn't authenticated yet.
 */
function getDeviceIdForSocket(socket) {
  if (!socket || !socket.rooms) return null;
  for (const room of socket.rooms) {
    if (room !== socket.id) return room;
  }
  return null;
}

module.exports = { canActOnDevice, getDeviceIdForSocket };
