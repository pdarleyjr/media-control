// Phase 2.3: helpers for resolving socket.io room names per workspace /
// device / wall. Extracted from ws/dashboardSocket.js to break a circular
// dependency: dashboardSocket already requires services/heartbeat, so
// heartbeat can't require dashboardSocket. Everything goes through this
// neutral module instead.
const { db } = require('../db/database');

const ROOM_PREFIX = 'workspace:';

function workspaceRoom(workspaceId) {
  return workspaceId ? ROOM_PREFIX + workspaceId : null;
}

function deviceRoom(deviceId) {
  if (!deviceId) return null;
  const d = db.prepare('SELECT workspace_id FROM devices WHERE id = ?').get(deviceId);
  return d?.workspace_id ? workspaceRoom(d.workspace_id) : null;
}

function wallRoom(wallId) {
  if (!wallId) return null;
  const w = db.prepare('SELECT workspace_id FROM video_walls WHERE id = ?').get(wallId);
  return w?.workspace_id ? workspaceRoom(w.workspace_id) : null;
}

// Emit to a workspace room with no-op on missing room. Centralized so callers
// don't have to remember the "skip if null room" guard - silent drop is safer
// than the pre-2.3 platform-wide broadcast.
function emitToWorkspace(ns, room, event, payload) {
  if (!room) return;
  ns.to(room).emit(event, payload);
}

// Phase 2 per-target room name helpers. Used by deviceSocket (on register,
// join the device's own display:<id> + its wall's wall:<id> + its group
// group:<id>) and dashboardSocket (on target-select, join the matching room
// and leave the previous). Synthesized targets like the live-program display
// use live-program:<workspaceId>.
const DISPLAY_ROOM_PREFIX = 'display:';
const WALL_ROOM_PREFIX = 'wall:';
const GROUP_ROOM_PREFIX = 'group:';
const NODE_ROOM_PREFIX = 'node:';
const LIVE_PROGRAM_PREFIX = 'live-program:';
const ROOM_STATE_PREFIX = 'room-state:';

function displayRoom(displayId) {
  return displayId ? DISPLAY_ROOM_PREFIX + displayId : null;
}

// NOTE: the legacy `wallRoom(wallId)` (defined above) resolves to the WALL's
// WORKSPACE room (workspace:<ws>), not a per-wall target room. The Phase 2
// per-target room is wall:<wallId>; this helper builds that string directly
// to avoid colliding with the legacy export (additive constraint).
function wallTargetRoom(wallId) {
  return wallId ? WALL_ROOM_PREFIX + wallId : null;
}

function groupRoom(groupId) {
  return groupId ? GROUP_ROOM_PREFIX + groupId : null;
}

function nodeRoom(nodeId) {
  return nodeId ? NODE_ROOM_PREFIX + nodeId : null;
}

function liveProgramRoom(workspaceId) {
  return workspaceId ? LIVE_PROGRAM_PREFIX + workspaceId : null;
}

function roomStateRoom(workspaceId, roomId) {
  if (!workspaceId || !roomId) return null;
  return `${ROOM_STATE_PREFIX}${encodeURIComponent(String(workspaceId))}:${encodeURIComponent(String(roomId))}`;
}

// Resolve EVERY per-target room a member device should join on register: its
// own display:<id>, plus its wall's wall:<wallId> and every group's
// group:<groupId> it belongs to. Returns a list of non-null room names. Used
// by ws/deviceSocket.js on device:register (additive to the existing workspace
// room join); never removes the legacy joins.
function targetRoomsForDevice(deviceId) {
  if (!deviceId) return [];
  const rooms = [displayRoom(deviceId)];

  // Wall memberships (a device is a member of at most one wall via
  // devices.wall_id, but video_wall_devices can also reference it).
  try {
    const ownWall = db.prepare('SELECT wall_id FROM devices WHERE id = ?').get(deviceId);
    if (ownWall && ownWall.wall_id) rooms.push(wallTargetRoom(ownWall.wall_id));
    const wallRows = db.prepare('SELECT DISTINCT wall_id FROM video_wall_devices WHERE device_id = ?').all(deviceId);
    for (const r of wallRows) if (r.wall_id) rooms.push(wallTargetRoom(r.wall_id));
  } catch (e) { /* tables not present yet */ }

  // Group memberships backfilled by scripts/backfill-classroom-groups.js (and
  // curated by users via routes/device-groups.js).
  try {
    const groupRows = db.prepare('SELECT DISTINCT group_id FROM device_group_members WHERE device_id = ?').all(deviceId);
    for (const r of groupRows) if (r.group_id) rooms.push(groupRoom(r.group_id));
  } catch (e) { /* table not present yet */ }

  // De-dup while preserving order.
  return Array.from(new Set(rooms.filter(Boolean)));
}

module.exports = {
  workspaceRoom, deviceRoom, wallRoom, emitToWorkspace,
  displayRoom, wallTargetRoom, groupRoom, nodeRoom, liveProgramRoom, roomStateRoom, targetRoomsForDevice,
};
