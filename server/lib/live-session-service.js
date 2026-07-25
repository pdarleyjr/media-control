'use strict';

const crypto = require('crypto');
const { db } = require('../db/database');

const VALID_STATES = ['idle', 'starting', 'live', 'stopping', 'stopped', 'failed'];
const VALID_TRANSITIONS = {
  idle: ['starting'],
  starting: ['live', 'failed', 'stopping'],
  live: ['stopping', 'failed'],
  stopping: ['stopped', 'failed'],
  stopped: ['idle'],
  failed: ['idle', 'starting'],
};

function generateId() {
  return crypto.randomUUID();
}

function canonicalStringify(obj) {
  if (obj === null || obj === undefined) return 'null';
  if (typeof obj !== 'object') return JSON.stringify(obj);
  if (Array.isArray(obj)) return '[' + obj.map(canonicalStringify).join(',') + ']';
  const keys = Object.keys(obj).sort();
  return '{' + keys.map(k => JSON.stringify(k) + ':' + canonicalStringify(obj[k])).join(',') + '}';
}

class IdempotencyConflictError extends Error {
  constructor(idempotencyKey, message) {
    super(message || `Idempotency key conflict: key '${idempotencyKey}' already used with different request`);
    this.name = 'IdempotencyConflictError';
    this.code = 'IDEMPOTENCY_KEY_CONFLICT';
    this.statusCode = 409;
    this.idempotencyKey = idempotencyKey;
  }
}

function now() {
  return Math.floor(Date.now() / 1000);
}

function assertValidTransition(from, to) {
  const allowed = VALID_TRANSITIONS[from];
  if (!allowed || !allowed.includes(to)) {
    throw new Error(`Invalid state transition: ${from} -> ${to}`);
  }
}

const createSession = db.prepare(`
  INSERT INTO live_sessions (id, workspace_id, room_id, operator_id, state, created_at, updated_at)
  VALUES (?, ?, ?, ?, 'idle', ?, ?)
`);

const getSession = db.prepare(`
  SELECT * FROM live_sessions WHERE id = ?
`);

const getActiveSessionForRoom = db.prepare(`
  SELECT * FROM live_sessions
  WHERE room_id = ? AND workspace_id = ? AND state NOT IN ('stopped', 'failed')
  ORDER BY created_at DESC LIMIT 1
`);

const getActiveSessionsForWorkspace = db.prepare(`
  SELECT * FROM live_sessions
  WHERE workspace_id = ? AND state NOT IN ('stopped', 'failed')
  ORDER BY created_at DESC
`);

const updateSessionState = db.prepare(`
  UPDATE live_sessions
  SET state = ?, requested_state = ?, confirmed_state = ?,
      state_revision = state_revision + 1, updated_at = ?
  WHERE id = ? AND state_revision = ?
`);

const updateStreamState = db.prepare(`
  UPDATE live_sessions
  SET stream_active = ?, current_scene = ?, updated_at = ?
  WHERE id = ?
`);

const updateRecordingState = db.prepare(`
  UPDATE live_sessions
  SET recording_active = ?, updated_at = ?
  WHERE id = ?
`);

const recordFailure = db.prepare(`
  UPDATE live_sessions
  SET failure_count = failure_count + 1, last_failure_at = ?,
      last_failure_reason = ?, state = 'failed', updated_at = ?
  WHERE id = ?
`);

const insertFailureObservation = db.prepare(`
  INSERT INTO live_session_failure_observations (session_id, failure_code, correlation_id, operation, reason, actor_id, created_at)
  VALUES (?, ?, ?, ?, ?, ?, ?)
`);

const getFailureObservation = db.prepare(`
  SELECT id FROM live_session_failure_observations
  WHERE session_id = ? AND failure_code = ?
    AND (correlation_id = ? OR (correlation_id IS NULL AND ? IS NULL))
    AND (operation = ? OR (operation IS NULL AND ? IS NULL))
  LIMIT 1
`);

const endSession = db.prepare(`
  UPDATE live_sessions
  SET state = 'stopped', ended_at = ?, updated_at = ?
  WHERE id = ?
`);

const insertCommand = db.prepare(`
  INSERT INTO live_session_commands (id, session_id, idempotency_key, command_type, payload_json, state, revision, requested_at)
  VALUES (?, ?, ?, ?, ?, 'pending', 0, ?)
`);

const getCommand = db.prepare(`
  SELECT * FROM live_session_commands WHERE idempotency_key = ?
`);

const updateCommandState = db.prepare(`
  UPDATE live_session_commands
  SET state = ?, revision = revision + 1, acknowledged_at = ?, completed_at = ?, failure_reason = ?
  WHERE id = ?
`);

const insertRecording = db.prepare(`
  INSERT INTO live_session_recordings (id, session_id, state, started_at, created_at, updated_at)
  VALUES (?, ?, 'pending', ?, ?, ?)
`);

const updateRecording = db.prepare(`
  UPDATE live_session_recordings
  SET state = ?, obs_output_path = ?, stopped_at = ?, finalized_at = ?,
      file_size_bytes = ?, duration_seconds = ?, metadata_json = ?, updated_at = ?
  WHERE id = ?
`);

const getSessionRecordings = db.prepare(`
  SELECT * FROM live_session_recordings WHERE session_id = ? ORDER BY created_at DESC
`);

const insertAudit = db.prepare(`
  INSERT INTO live_session_audit (session_id, actor_id, action, details_json, created_at)
  VALUES (?, ?, ?, ?, ?)
`);

function startSession({ workspaceId, roomId, operatorId }) {
  const existing = getActiveSessionForRoom.get(roomId, workspaceId);
  if (existing) {
    throw new Error(`Active session ${existing.id} already exists for room ${roomId}`);
  }
  const id = generateId();
  const ts = now();
  createSession.run(id, workspaceId, roomId, operatorId, ts, ts);
  insertAudit.run(id, operatorId, 'session.created', null, ts);
  return getSession.get(id);
}

function transitionState(sessionId, expectedRevision, newState, operatorId) {
  const session = getSession.get(sessionId);
  if (!session) throw new Error(`Session ${sessionId} not found`);
  assertValidTransition(session.state, newState);
  if (session.state_revision !== expectedRevision) {
    throw new Error(`Revision conflict: expected ${expectedRevision}, got ${session.state_revision}`);
  }
  const ts = now();
  const result = updateSessionState.run(newState, newState, null, ts, sessionId, expectedRevision);
  if (result.changes === 0) {
    throw new Error('State transition failed: revision mismatch');
  }
  insertAudit.run(sessionId, operatorId, `state.${newState}`, JSON.stringify({ from: session.state }), ts);
  return getSession.get(sessionId);
}

function recordSessionFailure(sessionId, reason, operatorId, failureCode, correlationId, operation) {
  const session = getSession.get(sessionId);
  if (!session) throw new Error(`Session ${sessionId} not found`);
  if (!['starting', 'live', 'stopping', 'failed'].includes(session.state)) {
    throw new Error(`Cannot record failure from state: ${session.state}`);
  }
  const code = failureCode || 'ORCHESTRATION_ERROR';
  const corrId = correlationId || null;
  const op = operation || null;

  try {
    const existing = getFailureObservation.get(sessionId, code, corrId, corrId, op, op);
    if (existing) return session;
  } catch { /* table may not exist in older test schemas */ }

  const ts = now();
  recordFailure.run(ts, code, ts, sessionId);
  try {
    insertFailureObservation.run(sessionId, code, corrId, op, reason, operatorId || 'system', ts);
  } catch { /* table may not exist in older test schemas */ }
  insertAudit.run(sessionId, operatorId || 'system', 'session.failed', JSON.stringify({ reason, failure_code: code, correlation_id: corrId, operation: op, from: session.state }), ts);
  return getSession.get(sessionId);
}

function stopSession(sessionId, operatorId) {
  const session = getSession.get(sessionId);
  if (!session) throw new Error(`Session ${sessionId} not found`);
  if (!['starting', 'live', 'stopping', 'failed'].includes(session.state)) {
    throw new Error(`Cannot stop session from state: ${session.state}`);
  }
  const ts = now();
  endSession.run(ts, ts, sessionId);
  insertAudit.run(sessionId, operatorId, 'session.stopped', JSON.stringify({ from: session.state }), ts);
  return getSession.get(sessionId);
}

function createCommand({ sessionId, idempotencyKey, commandType, payload }) {
  const existing = getCommand.get(idempotencyKey);
  if (existing) {
    const existingPayload = existing.payload_json ? JSON.parse(existing.payload_json) : null;
    const existingFingerprint = canonicalStringify({ payload: existingPayload, type: existing.command_type });
    const newFingerprint = canonicalStringify({ payload: payload || null, type: commandType });
    if (existingFingerprint !== newFingerprint) {
      throw new IdempotencyConflictError(idempotencyKey);
    }
    return existing;
  }
  const id = generateId();
  const ts = now();
  insertCommand.run(id, sessionId, idempotencyKey, commandType, payload ? JSON.stringify(payload) : null, ts);
  return getCommand.get(idempotencyKey);
}

function completeCommand(commandId, failureReason) {
  const ts = now();
  updateCommandState.run(failureReason ? 'failed' : 'completed', ts, failureReason ? null : ts, failureReason || null, commandId);
}

function startRecording(sessionId) {
  const id = generateId();
  const ts = now();
  insertRecording.run(id, sessionId, ts, ts, ts);
  updateRecordingState.run(1, ts, sessionId);
  return { id, session_id: sessionId, state: 'pending', started_at: ts };
}

function stopRecording(recordingId, { obsOutputPath, fileSizeBytes, durationSeconds, metadata }) {
  const ts = now();
  updateRecording.run(
    'stopped', obsOutputPath || null, ts, null,
    fileSizeBytes || null, durationSeconds || null,
    metadata ? JSON.stringify(metadata) : null, ts, recordingId
  );
  const rec = db.prepare('SELECT * FROM live_session_recordings WHERE id = ?').get(recordingId);
  if (rec) {
    updateRecordingState.run(0, ts, rec.session_id);
  }
  return rec;
}

module.exports = {
  VALID_STATES,
  VALID_TRANSITIONS,
  IdempotencyConflictError,
  startSession,
  transitionState,
  recordSessionFailure,
  stopSession,
  getSession,
  getActiveSessionForRoom,
  getActiveSessionsForWorkspace,
  createCommand,
  completeCommand,
  startRecording,
  stopRecording,
  getSessionRecordings,
  insertAudit,
};
