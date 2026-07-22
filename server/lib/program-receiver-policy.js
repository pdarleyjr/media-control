'use strict';

const LIVE_STREAM_DEVICE_PREFIX = 'live-stream-program-';
const ALLOWED_EVENTS = new Set([
  'device:register',
  'device:heartbeat',
  'device:playlist-sync',
  'device:screenshot',
  'device:ack',
  'device:state-report',
  'device:playback-state',
  'device:play-event',
  'display:viewport',
  'device:room-snapshot',
]);

function isProgramReceiverId(deviceId) {
  return String(deviceId || '').startsWith(LIVE_STREAM_DEVICE_PREFIX);
}

function isAllowedProgramReceiverEvent(event) {
  return ALLOWED_EVENTS.has(String(event || ''));
}

function policyError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function programReceiverEventGuard(getDeviceId) {
  return function guard(packet, next) {
    const deviceId = typeof getDeviceId === 'function' ? getDeviceId() : null;
    const event = Array.isArray(packet) ? packet[0] : null;
    if (isProgramReceiverId(deviceId) && !isAllowedProgramReceiverEvent(event)) {
      return next(policyError(
        'PROGRAM_RECEIVER_EVENT_FORBIDDEN',
        `Program receiver cannot originate ${String(event || 'unknown')}`,
      ));
    }
    return next();
  };
}

function resolveProgramReceiverSnapshotTarget(options = {}) {
  const deviceId = String(options.deviceId || '');
  if (!isProgramReceiverId(deviceId)) {
    throw policyError('PROGRAM_RECEIVER_REQUIRED', 'A managed program receiver is required');
  }
  const receiver = options.db?.prepare('SELECT workspace_id FROM devices WHERE id = ?')?.get(deviceId);
  const workspaceId = String(receiver?.workspace_id || '').trim();
  if (!workspaceId) {
    throw policyError('PROGRAM_RECEIVER_UNASSIGNED', 'Program receiver is not assigned to a workspace');
  }
  const roomId = String(options.configuredRoomId || '').trim();
  if (!roomId) {
    throw policyError('PROGRAM_RECEIVER_ROOM_UNCONFIGURED', 'Program receiver classroom is not configured');
  }
  const requestedWorkspaceId = String(options.requestedWorkspaceId || '').trim();
  if (requestedWorkspaceId && requestedWorkspaceId !== workspaceId) {
    throw policyError('PROGRAM_RECEIVER_WORKSPACE_MISMATCH', 'Requested workspace does not match receiver tenancy');
  }
  const requestedRoomId = String(options.requestedRoomId || '').trim();
  if (requestedRoomId && requestedRoomId !== roomId) {
    throw policyError('PROGRAM_RECEIVER_ROOM_MISMATCH', 'Requested classroom does not match receiver configuration');
  }
  return { workspaceId, roomId };
}

module.exports = {
  ALLOWED_PROGRAM_RECEIVER_EVENTS: ALLOWED_EVENTS,
  isAllowedProgramReceiverEvent,
  isProgramReceiverId,
  programReceiverEventGuard,
  resolveProgramReceiverSnapshotTarget,
};
