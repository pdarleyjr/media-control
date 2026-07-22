'use strict';

const config = require('../config');
const { db } = require('../db/database');
const { roomStateRoom } = require('./socket-rooms');
const {
  bumpRoomRevision,
  buildRoomSnapshot,
} = require('./room-snapshot');
const { getLiveProductionState } = require('./live-production-state');

function normalizedRoomId(roomId) {
  return String(roomId || config.console.roomId || 'classroom-1').trim();
}

function resolveSnapshotState(workspaceId, state = {}) {
  const cachedProduction = getLiveProductionState(workspaceId);
  const allowedState = {};
  for (const key of [
    'confirmedState', 'pendingCommands', 'lastCommandId', 'deviceStates',
    'layoutState', 'classroomProgram', 'livestreamProgram', 'recordingState', 'streamState',
  ]) {
    if (Object.prototype.hasOwnProperty.call(state || {}, key) && state[key] !== undefined) {
      allowedState[key] = state[key];
    }
  }
  if (allowedState.recordingState === undefined) {
    allowedState.recordingState = cachedProduction.recordingState;
  }
  if (allowedState.streamState === undefined) {
    allowedState.streamState = cachedProduction.streamState;
  }
  return allowedState;
}

function createRoomSnapshot({ workspaceId, roomId, reason, bump = false, state = {} }) {
  const resolvedRoomId = normalizedRoomId(roomId);
  if (bump) bumpRoomRevision(db, workspaceId, resolvedRoomId, reason || 'state:changed');
  return buildRoomSnapshot({
    ...resolveSnapshotState(workspaceId, state),
    db,
    workspaceId,
    roomId: resolvedRoomId,
  });
}

function publishRoomSnapshot(io, options = {}) {
  const snapshot = createRoomSnapshot(options);
  const dashboardNs = io?.of?.('/dashboard');
  if (!dashboardNs) throw new Error('dashboard namespace is unavailable');
  dashboardNs.to(roomStateRoom(snapshot.workspaceId, snapshot.roomId)).emit('room:snapshot', snapshot);
  return snapshot;
}

const scheduled = new Map();

// Coalesce chatty device reports into one authoritative revision/broadcast per
// room burst. Command and topology mutations continue to call publish directly.
function scheduleRoomSnapshot(io, options = {}, delayMs = 100) {
  const workspaceId = String(options.workspaceId || '').trim();
  const roomId = normalizedRoomId(options.roomId);
  if (!workspaceId) return null;
  const key = `${workspaceId}\u0000${roomId}`;
  const prior = scheduled.get(key);
  if (prior) {
    prior.options = { ...prior.options, ...options, workspaceId, roomId, bump: true };
    return prior.timer;
  }
  const entry = {
    options: { ...options, workspaceId, roomId, bump: true },
    timer: null,
  };
  entry.timer = setTimeout(() => {
    scheduled.delete(key);
    try {
      publishRoomSnapshot(io, entry.options);
    } catch (error) {
      console.warn(`[room-state] scheduled snapshot failed for ${workspaceId}/${roomId}: ${error.message}`);
    }
  }, Math.max(0, Number(delayMs) || 0));
  if (entry.timer.unref) entry.timer.unref();
  scheduled.set(key, entry);
  return entry.timer;
}

module.exports = {
  resolveSnapshotState,
  createRoomSnapshot,
  publishRoomSnapshot,
  scheduleRoomSnapshot,
};
