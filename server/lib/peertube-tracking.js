'use strict';

const { db } = require('../db/database');

function createPeerTubeTracking(sessionId, { peertubeLiveUuid, peertubeChannelId, peertubePrivacy } = {}) {
  const now = Math.floor(Date.now() / 1000);
  db.prepare(`
    INSERT INTO live_session_peertube (session_id, peertube_live_uuid, peertube_channel_id, peertube_privacy, peertube_replay_status, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'pending', ?, ?)
  `).run(sessionId, peertubeLiveUuid || null, peertubeChannelId || null, peertubePrivacy || null, now, now);
  return getPeerTubeTracking(sessionId);
}

function getPeerTubeTracking(sessionId) {
  return db.prepare('SELECT * FROM live_session_peertube WHERE session_id = ?').get(sessionId);
}

function updatePeerTubeReplayStatus(sessionId, status, { replayUuid, watchUrl, errorCode } = {}) {
  const now = Math.floor(Date.now() / 1000);
  const fields = ['peertube_replay_status = ?', 'updated_at = ?'];
  const values = [status, now];

  if (replayUuid) {
    fields.push('peertube_replay_uuid = ?');
    values.push(replayUuid);
  }
  if (watchUrl) {
    fields.push('peertube_watch_url = ?');
    values.push(watchUrl);
  }
  if (errorCode) {
    fields.push('peertube_last_error_code = ?');
    values.push(errorCode);
  }

  if (status === 'processing') {
    fields.push('peertube_processing_started_at = ?');
    values.push(now);
  }
  if (status === 'available' || status === 'failed') {
    fields.push('peertube_processing_completed_at = ?');
    values.push(now);
  }

  values.push(sessionId);
  db.prepare(`UPDATE live_session_peertube SET ${fields.join(', ')} WHERE session_id = ?`).run(...values);
  return getPeerTubeTracking(sessionId);
}

function markReplayAvailable(sessionId, replayUuid, watchUrl) {
  return updatePeerTubeReplayStatus(sessionId, 'available', { replayUuid, watchUrl });
}

function markReplayProcessing(sessionId) {
  return updatePeerTubeReplayStatus(sessionId, 'processing');
}

function markReplayFailed(sessionId, errorCode) {
  return updatePeerTubeReplayStatus(sessionId, 'failed', { errorCode });
}

function markFallbackUploading(sessionId) {
  return updatePeerTubeReplayStatus(sessionId, 'fallback_uploading');
}

function markFallbackAvailable(sessionId, replayUuid, watchUrl) {
  return updatePeerTubeReplayStatus(sessionId, 'fallback_available', { replayUuid, watchUrl });
}

function markFallbackFailed(sessionId, errorCode) {
  return updatePeerTubeReplayStatus(sessionId, 'fallback_failed', { errorCode });
}

function getActivePeerTubeSessions() {
  return db.prepare(`
    SELECT * FROM live_session_peertube
    WHERE peertube_replay_status IN ('pending', 'processing', 'fallback_uploading')
    ORDER BY created_at DESC
  `).all();
}

module.exports = {
  createPeerTubeTracking,
  getPeerTubeTracking,
  updatePeerTubeReplayStatus,
  markReplayAvailable,
  markReplayProcessing,
  markReplayFailed,
  markFallbackUploading,
  markFallbackAvailable,
  markFallbackFailed,
  getActivePeerTubeSessions,
};
