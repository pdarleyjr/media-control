'use strict';

const crypto = require('crypto');
const sessionService = require('./live-session-service');
const cameraControl = require('./camera-control-client');
// AI Director retired - using camera-control-client
const { createFinalizer, defaultRunner, defaultClock } = require('./recording-finalizer');
const { emitOperatorState, emitFailureUpdate } = require('./live-operator-emitter');
const peertubeTracking = require('./peertube-tracking');
const peertubeClient = require('./peertube-client');

let _db = null;
let _io = null;
let _finalizer = null;
let _workerId = crypto.randomUUID();
const LOCK_LEASE_MS = 30000;

function lockKey(workspaceId, roomId) {
  return `${workspaceId}:${roomId}`;
}

function ensureLockTable() {
  if (!_db) return;
  _db.exec(`
    CREATE TABLE IF NOT EXISTS live_room_operations (
      lock_key TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      room_id TEXT NOT NULL,
      worker_id TEXT NOT NULL,
      operation TEXT NOT NULL,
      correlation_id TEXT,
      acquired_at INTEGER NOT NULL,
      lease_expires_at INTEGER NOT NULL
    )
  `);
}

function acquireRoomLock(workspaceId, roomId, operation, correlationId) {
  if (!_db) throw new Error('Database not configured for durable locking');
  ensureLockTable();
  const key = lockKey(workspaceId, roomId);
  const now = Date.now();
  const expiresAt = now + LOCK_LEASE_MS;

  _db.exec(`DELETE FROM live_room_operations WHERE lease_expires_at < ${now}`);

  const existing = _db.prepare('SELECT * FROM live_room_operations WHERE lock_key = ?').get(key);
  if (existing && existing.lease_expires_at > now) {
    throw new Error(`Operation already in progress for room ${roomId} in workspace ${workspaceId}`);
  }

  const insert = _db.prepare(`
    INSERT INTO live_room_operations (lock_key, workspace_id, room_id, worker_id, operation, correlation_id, acquired_at, lease_expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(lock_key) DO UPDATE SET
      worker_id = excluded.worker_id,
      operation = excluded.operation,
      correlation_id = excluded.correlation_id,
      acquired_at = excluded.acquired_at,
      lease_expires_at = excluded.lease_expires_at
    WHERE live_room_operations.lease_expires_at < excluded.acquired_at
  `);
  const result = insert.run(key, workspaceId, roomId, _workerId, operation || 'start', correlationId || null, now, expiresAt);
  if (result.changes === 0) {
    throw new Error(`Operation already in progress for room ${roomId} in workspace ${workspaceId}`);
  }
}

function releaseRoomLock(workspaceId, roomId) {
  if (!_db) return;
  const key = lockKey(workspaceId, roomId);
  _db.prepare('DELETE FROM live_room_operations WHERE lock_key = ? AND worker_id = ?').run(key, _workerId);
}

function configure({ io, db, approvedRoot }) {
  _io = io || null;
  _db = db || null;
  if (db && approvedRoot) {
    _finalizer = createFinalizer({ db, approvedRoot, runner: defaultRunner, clock: defaultClock });
  }
  if (_db) ensureLockTable();
}

function notifyState(workspaceId) {
  if (!_io) return;
  const state = getActiveSessionState(workspaceId);
  emitOperatorState(_io, workspaceId, state);
}

function notifyFailure(workspaceId, sessionId, reason) {
  if (!_io) return;
  emitFailureUpdate(_io, workspaceId, {
    session_id: sessionId,
    failure_code: classifyFailure(reason),
    safe_message: redactMessage(reason),
    timestamp: Math.floor(Date.now() / 1000),
  });
}

function classifyFailure(reason) {
  if (!reason) return 'UNKNOWN';
  if (reason.includes('Preflight')) return 'PREFLIGHT_FAILED';
  if (reason.includes('Recording')) return 'RECORDING_FAILED';
  if (reason.includes('Stream')) return 'STREAM_FAILED';
  if (reason.includes('OBS')) return 'OBS_UNREACHABLE';
  return 'ORCHESTRATION_ERROR';
}

function redactMessage(reason) {
  if (!reason) return 'An error occurred';
  return reason.replace(/\/[\w./\\-]+/g, '[path]');
}

async function startLive({ workspaceId, roomId, operatorId, recordingRequired = true }) {
  const correlationId = crypto.randomUUID();
  acquireRoomLock(workspaceId, roomId, 'start', correlationId);
  let session = null;

  try {
    session = sessionService.startSession({ workspaceId, roomId, operatorId });
    session = sessionService.transitionState(session.id, 0, 'starting', operatorId);
    notifyState(workspaceId);

    const preflightResult = await cameraControl.getStatus();

    if (!preflightResult.ok) {
      sessionService.recordSessionFailure(session.id, `Preflight failed: ${preflightResult.message}`, operatorId, 'PREFLIGHT_FAILED', correlationId, 'start');
      notifyFailure(workspaceId, session.id, `Preflight failed: ${preflightResult.message}`);
      releaseRoomLock(workspaceId, roomId);
      notifyState(workspaceId);
      return { ok: false, error: 'PREFLIGHT_FAILED', session, correlationId, detail: preflightResult };
    }

    if (recordingRequired) {
      const startResult = await cameraControl.startRecording();

      if (!startResult.ok) {
        sessionService.recordSessionFailure(session.id, `Recording start failed: ${startResult.message}`, operatorId, 'RECORDING_FAILED', correlationId, 'start');
        notifyFailure(workspaceId, session.id, `Recording start failed: ${startResult.message}`);
        releaseRoomLock(workspaceId, roomId);
        notifyState(workspaceId);
        return { ok: false, error: 'RECORDING_START_FAILED', session, correlationId, detail: startResult };
      }

      sessionService.startRecording(session.id);
      session = sessionService.getSession.get(session.id);
    }

    const streamResult = await cameraControl.startLivestream();
    if (streamResult.ok) {
      session = sessionService.transitionState(session.id, session.state_revision, 'live', operatorId);
    } else {
      if (recordingRequired) {
        await cameraControl.stopRecording();
      }
      sessionService.recordSessionFailure(session.id, `Stream start failed: ${streamResult.message}`, operatorId, 'STREAM_FAILED', correlationId, 'start');
      notifyFailure(workspaceId, session.id, `Stream start failed: ${streamResult.message}`);
      releaseRoomLock(workspaceId, roomId);
      notifyState(workspaceId);
      return { ok: false, error: 'STREAM_START_FAILED', session, correlationId, detail: streamResult };
    }

    releaseRoomLock(workspaceId, roomId);
    notifyState(workspaceId);
    return { ok: true, session: sessionService.getSession.get(session.id), correlationId };
  } catch (err) {
    if (session) {
      try { sessionService.recordSessionFailure(session.id, err.message, operatorId, classifyFailure(err.message), correlationId, 'start'); } catch {}
      notifyFailure(workspaceId, session.id, err.message);
    }
    releaseRoomLock(workspaceId, roomId);
    notifyState(workspaceId);
    return { ok: false, error: 'ORCHESTRATION_ERROR', session, correlationId, message: err.message };
  }
}

async function stopLive({ sessionId, workspaceId, operatorId }) {
  const session = sessionService.getSession.get(sessionId);
  if (!session) throw new Error(`Session ${sessionId} not found`);
  if (workspaceId && session.workspace_id !== workspaceId) {
    throw new Error(`Session ${sessionId} not found`);
  }

  acquireRoomLock(session.workspace_id, session.room_id, 'stop');
  const correlationId = crypto.randomUUID();

  try {
    sessionService.transitionState(sessionId, session.state_revision, 'stopping', operatorId);
    notifyState(session.workspace_id);

    await cameraControl.stopLivestream();

    let outputPath = null;
    const stopResult = await cameraControl.stopRecording();

    if (stopResult.ok && stopResult.data) {
      outputPath = stopResult.data.output_path || null;
    }

    const recordings = sessionService.getSessionRecordings.all(sessionId);
    if (recordings.length > 0) {
      const latestRecording = recordings[0];
      sessionService.stopRecording(latestRecording.id, {
        obsOutputPath: outputPath,
      });

      if (_finalizer && outputPath) {
        try {
          _finalizer.enqueueRecording(latestRecording.id, outputPath, sessionId);
          _finalizer.processPendingJobs();
        } catch {}
      }
    }

    const stopped = sessionService.stopSession(sessionId, operatorId);

    // Initiate PeerTube replay discovery if configured
    if (peertubeClient.credentialIsConfigured()) {
      try {
        const tracking = peertubeTracking.createPeerTubeTracking(sessionId);
        peertubeTracking.markReplayProcessing(sessionId);
        
        // Schedule async replay discovery (non-blocking)
        setImmediate(async () => {
          try {
            await discoverPeerTubeReplay(sessionId, tracking.peertube_live_uuid);
          } catch (err) {
            console.error('[peertube] Replay discovery failed:', err.message);
            peertubeTracking.markReplayFailed(sessionId, 'DISCOVERY_ERROR');
          }
        });
      } catch (err) {
        console.warn('[peertube] Could not initiate replay tracking:', err.message);
      }
    }

    releaseRoomLock(session.workspace_id, session.room_id);
    notifyState(session.workspace_id);
    return { ok: true, session: stopped, correlationId, outputPath };
  } catch (err) {
    try { sessionService.recordSessionFailure(sessionId, err.message, operatorId, classifyFailure(err.message), correlationId, 'stop'); } catch {}
    try { sessionService.stopSession(sessionId, operatorId); } catch {}
    notifyFailure(session.workspace_id, sessionId, err.message);
    releaseRoomLock(session.workspace_id, session.room_id);
    notifyState(session.workspace_id);
    return { ok: false, error: 'ORCHESTRATION_ERROR', correlationId, message: err.message };
  }
}

function getActiveSessionState(workspaceId) {
  const sessions = sessionService.getActiveSessionsForWorkspace.all(workspaceId);
  if (sessions.length === 0) return null;

  const session = sessions[0];
  const recordings = sessionService.getSessionRecordings.all(session.id);
  const peertube = peertubeTracking.getPeerTubeTracking(session.id);
  return {
    session,
    recordings,
    peertube,
    roomLocked: _db ? !!_db.prepare('SELECT 1 FROM live_room_operations WHERE lock_key = ? AND lease_expires_at > ?').get(lockKey(workspaceId, session.room_id), Date.now()) : false,
  };
}

async function discoverPeerTubeReplay(sessionId, liveVideoUuid, maxAttempts = 30, intervalMs = 10000) {
  if (!liveVideoUuid) {
    peertubeTracking.markReplayFailed(sessionId, 'NO_LIVE_UUID');
    return;
  }

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      const result = await peertubeClient.searchReplayForLive(liveVideoUuid);
      
      if (!result.ok) {
        console.warn(`[peertube] Replay discovery attempt ${attempt + 1} failed:`, result.message);
        await new Promise(resolve => setTimeout(resolve, intervalMs));
        continue;
      }

      if (result.replayFound) {
        peertubeTracking.markReplayAvailable(sessionId, result.replayUuid, result.replayUrl);
        console.log(`[peertube] Replay discovered: ${result.replayUuid}`);
        return;
      }

      console.log(`[peertube] Replay not ready (attempt ${attempt + 1}/${maxAttempts})`);
      await new Promise(resolve => setTimeout(resolve, intervalMs));
    } catch (err) {
      console.error(`[peertube] Replay discovery error (attempt ${attempt + 1}):`, err.message);
      await new Promise(resolve => setTimeout(resolve, intervalMs));
    }
  }

  peertubeTracking.markReplayFailed(sessionId, 'REPLAY_TIMEOUT');
  console.warn(`[peertube] Replay discovery timed out after ${maxAttempts} attempts`);
}

module.exports = {
  startLive,
  stopLive,
  getActiveSessionState,
  configure,
  discoverPeerTubeReplay,
};
