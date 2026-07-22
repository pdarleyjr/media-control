'use strict';

const { randomUUID } = require('node:crypto');
const { db } = require('../db/database');
const config = require('../config');
const { audit } = require('../lib/audit');
const { VISIBILITY } = require('../lib/peertube-replay-permissions');

const STATE = Object.freeze({
  DISCOVERING: 'discovering',
  PROCESSING: 'processing',
  READY: 'ready',
  FAILED: 'failed',
  ADDED: 'added',
  DISCARDED: 'discarded',
  ARCHIVED: 'archived',
});

const TERMINAL_STATES = new Set([STATE.ADDED, STATE.DISCARDED, STATE.ARCHIVED]);
const WORKER_NAME = 'peertube-replay-discovery';
const WORKER_OWNER = `${process.pid}:${randomUUID()}`;

let _timer = null;
let _scheduled = false;
let _running = false;
let _abortController = null;
let _backoff = 0;
let _io = null;
let _tokenCache = null;
let _oauthClientCache = null;

function error(message, code) {
  return Object.assign(new Error(message), { code });
}

function _cfg() {
  return config.peerTubeReplay || {};
}

function _enabled() {
  const c = _cfg();
  return Boolean(c.enabled && (c.apiToken || (c.apiUsername && c.apiPassword)));
}

function _apiBase() {
  return String(_cfg().apiBase || 'http://127.0.0.1:8098').replace(/\/+$/, '');
}

function requireWorkspaceId(workspaceId) {
  const value = String(workspaceId || '').trim();
  if (!value) throw error('Workspace context required', 403);
  return value;
}

function getRevision(workspaceId) {
  const ws = requireWorkspaceId(workspaceId);
  const row = db.prepare('SELECT revision FROM peertube_replay_revisions WHERE workspace_id = ?').get(ws);
  return row ? Number(row.revision) : 0;
}

function _bumpRevision(workspaceId) {
  const ws = requireWorkspaceId(workspaceId);
  db.prepare(`
    INSERT INTO peertube_replay_revisions (workspace_id, revision)
    VALUES (?, 1)
    ON CONFLICT(workspace_id) DO UPDATE SET
      revision=peertube_replay_revisions.revision + 1,
      updated_at=strftime('%s','now')
  `).run(ws);
  return getRevision(ws);
}

function _emitWorkspaceRevision(workspaceId, reason, revision = getRevision(workspaceId)) {
  if (!_io) return;
  const dashboard = typeof _io.of === 'function' ? _io.of('/dashboard') : null;
  if (!dashboard) return;
  dashboard.to(`workspace:${workspaceId}`).emit('dashboard:peertube-replays-changed', {
    workspace_id: workspaceId,
    revision,
    reason,
  });
}

function registerRecordingSession({
  id = randomUUID(),
  workspaceId,
  instructorUserId = null,
  title,
  roomId = null,
  roomName = null,
  liveVideoUuid = null,
  streamSessionId = null,
  obsRecordingId = null,
  expectedReplayUuid = null,
  startedAt,
  endedAt = null,
  status = endedAt == null ? 'recording' : 'awaiting_replay',
  metadata = null,
} = {}) {
  const ws = requireWorkspaceId(workspaceId);
  if (!String(title || '').trim()) throw error('Recording title required', 400);
  const start = Number(startedAt);
  const end = endedAt == null ? null : Number(endedAt);
  if (!Number.isFinite(start)) throw error('Recording start time required', 400);
  if (end != null && (!Number.isFinite(end) || end < start)) throw error('Invalid recording end time', 400);

  const tx = db.transaction(() => {
    const existing = db.prepare('SELECT workspace_id FROM peertube_recording_sessions WHERE id = ?').get(id);
    if (existing && existing.workspace_id !== ws) throw error('Recording session workspace cannot change', 409);
    db.prepare(`
      INSERT INTO peertube_recording_sessions
        (id, workspace_id, instructor_user_id, title, room_id, room_name, live_video_uuid,
         stream_session_id, obs_recording_id, expected_replay_uuid, started_at, ended_at,
         status, metadata_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        instructor_user_id=excluded.instructor_user_id,
        title=excluded.title,
        room_id=excluded.room_id,
        room_name=excluded.room_name,
        live_video_uuid=COALESCE(excluded.live_video_uuid, peertube_recording_sessions.live_video_uuid),
        stream_session_id=COALESCE(excluded.stream_session_id, peertube_recording_sessions.stream_session_id),
        obs_recording_id=COALESCE(excluded.obs_recording_id, peertube_recording_sessions.obs_recording_id),
        expected_replay_uuid=COALESCE(excluded.expected_replay_uuid, peertube_recording_sessions.expected_replay_uuid),
        started_at=excluded.started_at,
        ended_at=excluded.ended_at,
        status=excluded.status,
        metadata_json=excluded.metadata_json,
        updated_at=strftime('%s','now')
    `).run(
      id, ws, instructorUserId, String(title).trim().slice(0, 255), roomId, roomName,
      liveVideoUuid, streamSessionId, obsRecordingId, expectedReplayUuid, start, end,
      status, metadata == null ? null : JSON.stringify(metadata)
    );
    return _bumpRevision(ws);
  });
  const revision = tx();
  _emitWorkspaceRevision(ws, 'recording-session', revision);
  return { id, workspace_id: ws, revision };
}

function _metadataValues(v) {
  const tags = Array.isArray(v && v.tags) ? v.tags.filter((tag) => typeof tag === 'string') : [];
  const text = [v && v.support, v && v.description].filter(Boolean).join('\n');
  const findTag = (prefix) => {
    const tag = tags.find((candidate) => candidate.startsWith(prefix));
    return tag ? tag.slice(prefix.length).trim() : null;
  };
  const findText = (label) => {
    const match = new RegExp(`${label}:([a-zA-Z0-9_.-]+)`).exec(text);
    return match ? match[1] : null;
  };
  return {
    recordingSessionId: findTag('rec:') || findText('rec-session'),
    streamSessionId: findTag('stream:') || findText('stream-session'),
    liveVideoUuid: findTag('live:') || findText('live-uuid'),
    obsRecordingId: findTag('obs:') || findText('obs-recording'),
  };
}

function _correlateRecordingSession(v) {
  if (!v || !v.uuid) return null;
  const metadata = _metadataValues(v);
  if (metadata.recordingSessionId) {
    return db.prepare('SELECT * FROM peertube_recording_sessions WHERE id = ?').get(metadata.recordingSessionId) || null;
  }
  const expected = db.prepare('SELECT * FROM peertube_recording_sessions WHERE expected_replay_uuid = ?').get(v.uuid);
  if (expected) return expected;
  if (metadata.streamSessionId) {
    const row = db.prepare('SELECT * FROM peertube_recording_sessions WHERE stream_session_id = ?').get(metadata.streamSessionId);
    if (row) return row;
  }
  if (metadata.liveVideoUuid) {
    const row = db.prepare('SELECT * FROM peertube_recording_sessions WHERE live_video_uuid = ?').get(metadata.liveVideoUuid);
    if (row) return row;
  }
  if (metadata.obsRecordingId) {
    const row = db.prepare('SELECT * FROM peertube_recording_sessions WHERE obs_recording_id = ?').get(metadata.obsRecordingId);
    if (row) return row;
  }
  return null;
}

function _playbackUrl(v) {
  const direct = Array.isArray(v && v.files) ? v.files : [];
  const playlistFiles = Array.isArray(v && v.streamingPlaylists)
    ? v.streamingPlaylists.flatMap((playlist) => Array.isArray(playlist.files) ? playlist.files : [])
    : [];
  const file = [...direct, ...playlistFiles].find((candidate) => candidate && typeof candidate.fileUrl === 'string');
  return file ? file.fileUrl : null;
}

function _mapProcessingState(v) {
  if (!v || v.isLive) return STATE.PROCESSING;
  const stateId = v.state && Number.isFinite(Number(v.state.id)) ? Number(v.state.id) : null;
  const published = stateId === 5
    || (stateId === 1 && v.transcodingFinished === true)
    || /publish/i.test(String(v.state && v.state.label || ''));
  return published && _playbackUrl(v) ? STATE.READY : STATE.PROCESSING;
}

function _toReplay(v, session) {
  const publicBase = String(_cfg().publicWatchBase || _apiBase()).replace(/\/+$/, '');
  const watchPath = v.path || `/w/${v.uuid}`;
  const url = _playbackUrl(v);
  const state = _mapProcessingState(v);
  return {
    recording_session_id: session.id,
    workspace_id: session.workspace_id,
    peertube_video_uuid: v.uuid,
    peertube_video_id: v.id == null ? null : v.id,
    title: String(v.name || session.title || '').slice(0, 255),
    description: String(v.description || ''),
    duration_sec: Number.isFinite(Number(v.duration)) ? Number(v.duration) : null,
    thumbnail_url: v.thumbnailPath
      ? (/^https?:\/\//i.test(v.thumbnailPath) ? v.thumbnailPath : `${publicBase}${v.thumbnailPath}`)
      : null,
    watch_url: /^https?:\/\//i.test(watchPath) ? watchPath : `${publicBase}${watchPath}`,
    embed_url: `${publicBase}/videos/embed/${v.uuid}`,
    playback_url: url,
    processing_state: state,
    media_validation: state === STATE.READY ? (url ? 'valid' : 'invalid') : 'unknown',
    peertube_privacy: [1, 2, 3, 4].includes(Number(v.privacy)) ? Number(v.privacy) : 1,
  };
}

function _quarantine(v, reasonCode) {
  if (!v || !v.uuid) throw error('PeerTube video UUID required', 400);
  const id = randomUUID();
  db.prepare(`
    INSERT INTO peertube_replay_quarantine
      (id, peertube_video_uuid, peertube_video_id, title, reason_code, metadata_json)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(peertube_video_uuid) DO UPDATE SET
      peertube_video_id=excluded.peertube_video_id,
      title=excluded.title,
      reason_code=excluded.reason_code,
      metadata_json=excluded.metadata_json,
      last_seen_at=strftime('%s','now')
  `).run(
    id, v.uuid, v.id == null ? null : v.id, String(v.name || '').slice(0, 255), reasonCode,
    JSON.stringify({ state_id: v.state && v.state.id, is_live: Boolean(v.isLive) })
  );
  return { matched: false, quarantined: true, reason_code: reasonCode };
}

function upsertReplay(v) {
  if (!v || !v.uuid) throw error('PeerTube video UUID required', 400);
  if (v.isLive) return { matched: false, quarantined: false, skipped: 'live' };
  const session = _correlateRecordingSession(v);
  if (!session) return _quarantine(v, 'no_known_recording_session');
  const replay = _toReplay(v, session);

  const tx = db.transaction(() => {
    const existing = db.prepare('SELECT * FROM peertube_replays WHERE peertube_video_uuid = ?').get(v.uuid);
    if (existing && (existing.recording_session_id !== session.id || existing.workspace_id !== session.workspace_id)) {
      _quarantine(v, 'correlation_conflict');
      return { conflict: true, replay_id: existing.id, workspace_id: existing.workspace_id };
    }
    if (existing) {
      const nextState = TERMINAL_STATES.has(existing.processing_state)
        ? existing.processing_state
        : replay.processing_state;
      db.prepare(`
        UPDATE peertube_replays
           SET peertube_video_id=?, title=?, description=?, duration_sec=?, thumbnail_url=?,
               watch_url=?, embed_url=?, playback_url=COALESCE(?, playback_url),
               processing_state=?, peertube_privacy=?, media_validation=?,
               ready_at=CASE WHEN ?='ready' THEN COALESCE(ready_at, strftime('%s','now')) ELSE ready_at END,
               updated_at=strftime('%s','now')
         WHERE id=?
      `).run(
        replay.peertube_video_id, replay.title, replay.description, replay.duration_sec,
        replay.thumbnail_url, replay.watch_url, replay.embed_url, replay.playback_url,
        nextState, replay.peertube_privacy, replay.media_validation, nextState, existing.id
      );
      const revision = _bumpRevision(session.workspace_id);
      return { replayId: existing.id, revision };
    }

    const replayId = randomUUID();
    db.prepare(`
      INSERT INTO peertube_replays
        (id, recording_session_id, workspace_id, peertube_video_uuid, peertube_video_id,
         title, description, duration_sec, thumbnail_url, watch_url, embed_url, playback_url,
         processing_state, peertube_privacy, media_validation, ready_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
              CASE WHEN ?='ready' THEN strftime('%s','now') ELSE NULL END)
    `).run(
      replayId, replay.recording_session_id, replay.workspace_id, replay.peertube_video_uuid,
      replay.peertube_video_id, replay.title, replay.description, replay.duration_sec,
      replay.thumbnail_url, replay.watch_url, replay.embed_url, replay.playback_url,
      replay.processing_state, replay.peertube_privacy, replay.media_validation, replay.processing_state
    );
    db.prepare("UPDATE peertube_recording_sessions SET status='linked', updated_at=strftime('%s','now') WHERE id=?")
      .run(session.id);
    const revision = _bumpRevision(session.workspace_id);
    return { replayId, revision };
  });

  const result = tx();
  if (result.conflict) return { matched: false, quarantined: true, ...result };
  _emitWorkspaceRevision(session.workspace_id, 'replay-upsert', result.revision);
  return {
    matched: true,
    quarantined: false,
    replay_id: result.replayId,
    workspace_id: session.workspace_id,
    revision: result.revision,
  };
}

function listPending({ workspaceId, limit = 50, offset = 0 } = {}) {
  const ws = requireWorkspaceId(workspaceId);
  return db.prepare(`
    SELECT r.*, s.title AS recording_title, s.room_id, s.room_name,
           s.instructor_user_id,
           COALESCE(NULLIF(u.name, ''), u.email, s.instructor_user_id) AS instructor_name,
           s.started_at, s.ended_at
      FROM peertube_replays r
      JOIN peertube_recording_sessions s ON s.id=r.recording_session_id AND s.workspace_id=r.workspace_id
      LEFT JOIN users u ON u.id=s.instructor_user_id
     WHERE r.workspace_id=? AND r.processing_state='ready' AND r.content_id IS NULL
     ORDER BY r.discovered_at DESC, r.id DESC LIMIT ? OFFSET ?
  `).all(ws, Math.min(Math.max(Number(limit) || 50, 1), 200), Math.max(Number(offset) || 0, 0));
}

function listAll({ workspaceId, limit = 100, offset = 0 } = {}) {
  const ws = requireWorkspaceId(workspaceId);
  return db.prepare(`
    SELECT r.*, s.title AS recording_title, s.room_id, s.room_name,
           s.instructor_user_id,
           COALESCE(NULLIF(u.name, ''), u.email, s.instructor_user_id) AS instructor_name,
           s.started_at, s.ended_at
      FROM peertube_replays r
      JOIN peertube_recording_sessions s ON s.id=r.recording_session_id AND s.workspace_id=r.workspace_id
      LEFT JOIN users u ON u.id=s.instructor_user_id
     WHERE r.workspace_id=?
     ORDER BY r.discovered_at DESC, r.id DESC LIMIT ? OFFSET ?
  `).all(ws, Math.min(Math.max(Number(limit) || 100, 1), 500), Math.max(Number(offset) || 0, 0));
}

function getById(id, workspaceId) {
  const ws = requireWorkspaceId(workspaceId);
  return db.prepare(`
    SELECT r.*, s.title AS recording_title, s.room_id, s.room_name,
           s.instructor_user_id,
           COALESCE(NULLIF(u.name, ''), u.email, s.instructor_user_id) AS instructor_name,
           s.started_at, s.ended_at
      FROM peertube_replays r
      JOIN peertube_recording_sessions s ON s.id=r.recording_session_id AND s.workspace_id=r.workspace_id
      LEFT JOIN users u ON u.id=s.instructor_user_id
     WHERE r.id=? AND r.workspace_id=?
  `).get(id, ws);
}

function _contentAccessLevel(visibility) {
  return {
    [VISIBILITY.PRIVATE]: 'private',
    [VISIBILITY.WORKSPACE_SHARED]: 'workspace',
    [VISIBILITY.ORGANIZATION_SHARED]: 'organization',
    [VISIBILITY.PLATFORM_TEMPLATE]: 'platform_template',
  }[visibility] || 'private';
}

function addToMediaControl({ replayId, userId, workspaceId, visibility = VISIBILITY.PRIVATE, title } = {}) {
  const ws = requireWorkspaceId(workspaceId);
  if (!Object.values(VISIBILITY).includes(visibility)) throw error('Invalid library visibility', 400);
  const tx = db.transaction(() => {
    const replay = getById(replayId, ws);
    if (!replay) throw error('Replay not found', 404);
    if (replay.content_id) return { content_id: replay.content_id, replay, created: false, revision: getRevision(ws) };
    if (replay.processing_state !== STATE.READY || !replay.playback_url) {
      throw error(`Replay not ready (state=${replay.processing_state})`, 409);
    }

    const contentId = randomUUID();
    const safeTitle = String(title || replay.recording_title || replay.title || `Replay ${replay.peertube_video_uuid}`).slice(0, 255);
    const contentWorkspaceId = visibility === VISIBILITY.PLATFORM_TEMPLATE ? null : ws;
    db.prepare(`
      INSERT INTO content
        (id, user_id, workspace_id, filename, filepath, mime_type, file_size, remote_url,
         access_level, content_type, processing_status, original_sha256, duration_sec, thumbnail_path)
      VALUES (?, ?, ?, ?, '', 'video/mp4', 0, ?, ?, 'peertube-replay', 'remote', ?, ?, ?)
    `).run(
      contentId, userId, contentWorkspaceId, safeTitle,
      `/api/peertube-replays/${replay.id}/playback`, _contentAccessLevel(visibility),
      replay.peertube_video_uuid, replay.duration_sec, replay.thumbnail_url
    );
    const updated = db.prepare(`
      UPDATE peertube_replays
         SET content_id=?, processing_state='added', library_visibility=?,
             publication_status=CASE WHEN ?='ORGANIZATION_SHARED' THEN 'approved' ELSE publication_status END,
             added_at=strftime('%s','now'), added_by=?, updated_at=strftime('%s','now')
       WHERE id=? AND workspace_id=? AND content_id IS NULL AND processing_state='ready'
    `).run(contentId, visibility, visibility, userId, replayId, ws);
    if (updated.changes !== 1) throw error('Replay changed while it was being added; retry', 409);
    const revision = _bumpRevision(ws);
    return { content_id: contentId, replay: getById(replayId, ws), created: true, revision };
  });
  const result = tx();
  if (result.created) {
    audit({
      actorType: 'user', actorId: userId, action: 'peertube.replay.add',
      targetType: 'content', targetId: result.content_id, workspaceId: ws,
      details: { replayId, visibility },
    });
    _emitWorkspaceRevision(ws, 'replay-added', result.revision);
  }
  return result;
}

function discard({ replayId, userId, workspaceId } = {}) {
  const ws = requireWorkspaceId(workspaceId);
  const tx = db.transaction(() => {
    const replay = getById(replayId, ws);
    if (!replay) throw error('Replay not found', 404);
    if (replay.content_id || replay.processing_state === STATE.ADDED) throw error('Replay already linked to content', 409);
    if (replay.processing_state === STATE.ARCHIVED) throw error('Replay already archived', 409);
    db.prepare(`
      UPDATE peertube_replays
         SET processing_state='discarded', error_message='discarded_by_operator', updated_at=strftime('%s','now')
       WHERE id=? AND workspace_id=? AND content_id IS NULL
    `).run(replayId, ws);
    return _bumpRevision(ws);
  });
  const revision = tx();
  audit({
    actorType: 'user', actorId: userId, action: 'peertube.replay.discard',
    targetType: 'peertube_replay', targetId: replayId, workspaceId: ws,
  });
  _emitWorkspaceRevision(ws, 'replay-discarded', revision);
  return { ok: true, revision };
}

function retry({ replayId, userId, workspaceId } = {}) {
  const ws = requireWorkspaceId(workspaceId);
  const tx = db.transaction(() => {
    const replay = getById(replayId, ws);
    if (!replay) throw error('Replay not found', 404);
    if (replay.content_id || replay.processing_state === STATE.ADDED) throw error('Replay already linked to content', 409);
    if (![STATE.FAILED, STATE.DISCARDED].includes(replay.processing_state)) {
      throw error(`Replay cannot be retried from state=${replay.processing_state}`, 409);
    }
    const updated = db.prepare(`
      UPDATE peertube_replays
         SET processing_state='processing', error_message=NULL, retry_count=retry_count + 1,
             updated_at=strftime('%s','now')
       WHERE id=? AND workspace_id=? AND content_id IS NULL
         AND processing_state IN ('failed','discarded')
    `).run(replayId, ws);
    if (updated.changes !== 1) throw error('Replay changed while retry was requested', 409);
    const revision = _bumpRevision(ws);
    return { replay: getById(replayId, ws), revision };
  });
  const result = tx();
  audit({
    actorType: 'user', actorId: userId, action: 'peertube.replay.retry',
    targetType: 'peertube_replay', targetId: replayId, workspaceId: ws,
    details: { retryCount: result.replay.retry_count },
  });
  _emitWorkspaceRevision(ws, 'replay-retry-requested', result.revision);
  return result;
}

function archive({ replayId, userId, workspaceId } = {}) {
  const ws = requireWorkspaceId(workspaceId);
  const tx = db.transaction(() => {
    const replay = getById(replayId, ws);
    if (!replay) throw error('Replay not found', 404);
    if (replay.content_id || replay.processing_state === STATE.ADDED) throw error('Replay already linked to content', 409);
    if (replay.processing_state === STATE.ARCHIVED) {
      return { replay, revision: getRevision(ws), changed: false };
    }
    const updated = db.prepare(`
      UPDATE peertube_replays
         SET processing_state='archived', error_message=NULL, updated_at=strftime('%s','now')
       WHERE id=? AND workspace_id=? AND content_id IS NULL AND processing_state!='added'
    `).run(replayId, ws);
    if (updated.changes !== 1) throw error('Replay changed while archive was requested', 409);
    const revision = _bumpRevision(ws);
    return { replay: getById(replayId, ws), revision, changed: true };
  });
  const result = tx();
  if (result.changed) {
    audit({
      actorType: 'user', actorId: userId, action: 'peertube.replay.archive',
      targetType: 'peertube_replay', targetId: replayId, workspaceId: ws,
    });
    _emitWorkspaceRevision(ws, 'replay-archived', result.revision);
  }
  return { replay: result.replay, revision: result.revision };
}

function requestVisibility({ replayId, workspaceId, userId, visibility } = {}) {
  const ws = requireWorkspaceId(workspaceId);
  if (visibility !== VISIBILITY.ORGANIZATION_SHARED) throw error('Only organization sharing uses publication requests', 400);
  const replay = getById(replayId, ws);
  if (!replay) throw error('Replay not found', 404);
  db.prepare(`
    UPDATE peertube_replays
       SET publication_status='pending', updated_at=strftime('%s','now')
     WHERE id=? AND workspace_id=?
  `).run(replayId, ws);
  const revision = _bumpRevision(ws);
  audit({
    actorType: 'user', actorId: userId, action: 'peertube.replay.visibility.request',
    targetType: 'peertube_replay', targetId: replayId, workspaceId: ws,
    details: { visibility },
  });
  _emitWorkspaceRevision(ws, 'visibility-requested', revision);
  return { ok: true, revision };
}

function setVisibility({ replayId, workspaceId, userId, visibility } = {}) {
  const ws = requireWorkspaceId(workspaceId);
  if (![VISIBILITY.PRIVATE, VISIBILITY.WORKSPACE_SHARED, VISIBILITY.PLATFORM_TEMPLATE].includes(visibility)) {
    throw error('Organization visibility requires the publication approval workflow', 400);
  }
  const tx = db.transaction(() => {
    const replay = getById(replayId, ws);
    if (!replay) throw error('Replay not found', 404);
    db.prepare(`
      UPDATE peertube_replays
         SET library_visibility=?, publication_status='not_requested', updated_at=strftime('%s','now')
       WHERE id=? AND workspace_id=?
    `).run(visibility, replayId, ws);
    if (replay.content_id) {
      const contentWorkspaceId = visibility === VISIBILITY.PLATFORM_TEMPLATE ? null : ws;
      db.prepare('UPDATE content SET workspace_id=?, access_level=? WHERE id=?')
        .run(contentWorkspaceId, _contentAccessLevel(visibility), replay.content_id);
    }
    const revision = _bumpRevision(ws);
    return { replay: getById(replayId, ws), revision };
  });
  const result = tx();
  audit({
    actorType: 'user', actorId: userId, action: 'peertube.replay.visibility.change',
    targetType: 'peertube_replay', targetId: replayId, workspaceId: ws,
    details: { visibility },
  });
  _emitWorkspaceRevision(ws, 'visibility-changed', result.revision);
  return result;
}

function approveOrganizationPublication({ replayId, workspaceId, userId } = {}) {
  const ws = requireWorkspaceId(workspaceId);
  const tx = db.transaction(() => {
    const replay = getById(replayId, ws);
    if (!replay) throw error('Replay not found', 404);
    if (replay.publication_status !== 'pending') throw error('Organization publication was not requested', 409);
    db.prepare(`
      UPDATE peertube_replays
         SET library_visibility='ORGANIZATION_SHARED', publication_status='approved', updated_at=strftime('%s','now')
       WHERE id=? AND workspace_id=? AND publication_status='pending'
    `).run(replayId, ws);
    if (replay.content_id) db.prepare("UPDATE content SET access_level='organization' WHERE id=?").run(replay.content_id);
    return _bumpRevision(ws);
  });
  const revision = tx();
  audit({
    actorType: 'user', actorId: userId, action: 'peertube.replay.visibility.approve',
    targetType: 'peertube_replay', targetId: replayId, workspaceId: ws,
    details: { visibility: VISIBILITY.ORGANIZATION_SHARED },
  });
  _emitWorkspaceRevision(ws, 'visibility-approved', revision);
  return { ok: true, revision };
}

function _fetchWithTimeout(url, options = {}) {
  const timeoutMs = Math.max(Number(_cfg().requestTimeoutMs) || 10000, 250);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error('PeerTube request timed out')), timeoutMs);
  const parentSignal = options.signal;
  const abortFromParent = () => controller.abort(parentSignal.reason);
  if (parentSignal) {
    if (parentSignal.aborted) abortFromParent();
    else parentSignal.addEventListener('abort', abortFromParent, { once: true });
  }
  return fetch(url, { ...options, signal: controller.signal }).finally(() => {
    clearTimeout(timeout);
    if (parentSignal) parentSignal.removeEventListener('abort', abortFromParent);
  });
}

async function _oauthClient(c, signal) {
  if (_oauthClientCache) return _oauthClientCache;
  if (c.oauthClientId && c.oauthClientSecret) {
    _oauthClientCache = { client_id: c.oauthClientId, client_secret: c.oauthClientSecret };
    return _oauthClientCache;
  }
  const response = await _fetchWithTimeout(`${_apiBase()}/api/v1/oauth-clients/local`, { signal });
  if (!response.ok) throw Object.assign(new Error(`PeerTube OAuth client discovery failed (${response.status})`), { status: response.status });
  const data = await response.json();
  if (!data.client_id || !data.client_secret) throw new Error('PeerTube OAuth client discovery returned an invalid response');
  _oauthClientCache = { client_id: data.client_id, client_secret: data.client_secret };
  return _oauthClientCache;
}

async function _resolveToken(c = _cfg(), signal) {
  if (c.apiToken) return { accessToken: c.apiToken, refreshable: false, expiresAt: Infinity };
  if (_tokenCache && _tokenCache.expiresAt > Date.now() + 30000) return _tokenCache;
  const client = await _oauthClient(c, signal);
  const body = new URLSearchParams({
    client_id: client.client_id,
    client_secret: client.client_secret,
    grant_type: 'password',
    username: c.apiUsername,
    password: c.apiPassword,
  });
  const response = await _fetchWithTimeout(`${_apiBase()}/api/v1/users/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
    signal,
  });
  if (!response.ok) throw Object.assign(new Error(`PeerTube token request failed (${response.status})`), { status: response.status });
  const data = await response.json();
  if (!data.access_token) throw new Error('PeerTube token response missing access token');
  const expiresIn = Math.max(Number(data.expires_in) || 300, 60);
  _tokenCache = {
    accessToken: data.access_token,
    refreshable: true,
    expiresAt: Date.now() + expiresIn * 1000,
  };
  return _tokenCache;
}

async function _authenticatedFetch(url, options = {}, retry401 = true) {
  const token = await _resolveToken(_cfg(), options.signal);
  const headers = new Headers(options.headers || {});
  headers.set('Authorization', `Bearer ${token.accessToken}`);
  const response = await _fetchWithTimeout(url, { ...options, headers });
  if (response.status === 401 && retry401 && token.refreshable) {
    _tokenCache = null;
    return _authenticatedFetch(url, options, false);
  }
  return response;
}

async function _ptFetch(pathname, { method = 'GET', body, signal } = {}) {
  const headers = body == null ? {} : { 'Content-Type': 'application/json' };
  const response = await _authenticatedFetch(`${_apiBase()}${pathname}`, {
    method, headers, body: body == null ? undefined : JSON.stringify(body), signal,
  });
  if (!response.ok) {
    throw Object.assign(new Error(`PeerTube API request failed (${response.status})`), { status: response.status });
  }
  return response.json();
}

async function discoverReplays({ limit = 20, signal } = {}) {
  const count = Math.min(Math.max(Number(limit) || 20, 1), 100);
  const data = await _ptFetch(`/api/v1/videos?start=0&count=${count}&sort=-createdAt&filter=local&skipCount=false`, { signal });
  return Array.isArray(data.data) ? data.data : [];
}

function _allowedPlaybackOrigins() {
  const configured = Array.isArray(_cfg().playbackAllowedOrigins) ? _cfg().playbackAllowedOrigins : [];
  const candidates = [...configured, _apiBase(), _cfg().publicWatchBase].filter(Boolean);
  const origins = new Set();
  for (const value of candidates) {
    try {
      const parsed = new URL(String(value));
      if (parsed.protocol === 'http:' || parsed.protocol === 'https:') origins.add(parsed.origin);
    } catch (_) { /* invalid configuration is ignored and cannot widen access */ }
  }
  return origins;
}

function _assertAllowedPlaybackUrl(value) {
  let parsed;
  try { parsed = new URL(String(value || '')); }
  catch (_) { throw error('PeerTube playback URL is invalid', 502); }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
    throw error('PeerTube playback URL is not allowed', 502);
  }
  if (!_allowedPlaybackOrigins().has(parsed.origin)) {
    throw error('PeerTube playback URL origin is not allowed', 502);
  }
  return parsed.toString();
}

async function fetchPlaybackResponse(replayId, { range = null, signal } = {}) {
  const replay = getPlaybackBinding(replayId);
  if (!replay) throw error('Replay playback not found', 404);
  const url = _assertAllowedPlaybackUrl(replay.playback_url);
  const headers = {};
  if (range != null) {
    const normalized = String(range).trim();
    if (!/^bytes=\d*-\d*$/.test(normalized) || normalized === 'bytes=-') {
      throw error('Invalid byte range', 416);
    }
    headers.Range = normalized;
  }
  const response = await _authenticatedFetch(url, { headers, signal });
  if (!response.ok && response.status !== 206) {
    throw Object.assign(new Error(`PeerTube playback request failed (${response.status})`), { status: response.status, code: 502 });
  }
  return response;
}

function getPlaybackBinding(replayId) {
  return db.prepare(`
    SELECT r.id, r.workspace_id, r.playback_url, r.content_id,
           c.filename, c.mime_type, c.access_level
      FROM peertube_replays r
      JOIN content c ON c.id=r.content_id
     WHERE r.id=? AND r.processing_state='added' AND r.content_id IS NOT NULL
  `).get(replayId);
}

function _computeBackoff(previous, base, maximum) {
  const initial = Math.max(Number(base) || 1000, 250);
  const cap = Math.max(Number(maximum) || initial, initial);
  return Math.min(previous > 0 ? previous * 2 : initial, cap);
}

function _acquireLease(ownerId = WORKER_OWNER, now = Date.now(), leaseMs = Number(_cfg().leaseMs) || 120000) {
  const expiresAt = now + Math.max(Number(leaseMs) || 120000, 1000);
  const result = db.prepare(`
    INSERT INTO peertube_replay_worker_leases (lease_name, owner_id, expires_at, heartbeat_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(lease_name) DO UPDATE SET
      owner_id=excluded.owner_id, expires_at=excluded.expires_at, heartbeat_at=excluded.heartbeat_at
    WHERE peertube_replay_worker_leases.expires_at <= ?
       OR peertube_replay_worker_leases.owner_id = excluded.owner_id
  `).run(WORKER_NAME, ownerId, expiresAt, now, now);
  return result.changes === 1;
}

function _writeWorkerStatus(fields = {}) {
  const current = db.prepare('SELECT * FROM peertube_replay_worker_status WHERE worker_name=?').get(WORKER_NAME) || {};
  db.prepare(`
    INSERT INTO peertube_replay_worker_status
      (worker_name, owner_id, running, last_poll_at, last_success_at, last_error_code,
       backoff_ms, discovered_count, quarantined_count, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, strftime('%s','now'))
    ON CONFLICT(worker_name) DO UPDATE SET
      owner_id=excluded.owner_id, running=excluded.running, last_poll_at=excluded.last_poll_at,
      last_success_at=excluded.last_success_at, last_error_code=excluded.last_error_code,
      backoff_ms=excluded.backoff_ms, discovered_count=excluded.discovered_count,
      quarantined_count=excluded.quarantined_count, updated_at=strftime('%s','now')
  `).run(
    WORKER_NAME,
    fields.owner_id === undefined ? (current.owner_id || WORKER_OWNER) : fields.owner_id,
    fields.running === undefined ? (current.running || 0) : Number(Boolean(fields.running)),
    fields.last_poll_at === undefined ? (current.last_poll_at || null) : fields.last_poll_at,
    fields.last_success_at === undefined ? (current.last_success_at || null) : fields.last_success_at,
    fields.last_error_code === undefined ? (current.last_error_code || null) : fields.last_error_code,
    fields.backoff_ms === undefined ? (current.backoff_ms || 0) : fields.backoff_ms,
    fields.discovered_count === undefined ? (current.discovered_count || 0) : fields.discovered_count,
    fields.quarantined_count === undefined ? (current.quarantined_count || 0) : fields.quarantined_count
  );
}

async function _tick() {
  if (_running || !_enabled()) return { skipped: _running ? 'overlap' : 'disabled' };
  if (!_acquireLease()) return { skipped: 'lease-held' };
  _running = true;
  _abortController = new AbortController();
  const pollAt = Date.now();
  _writeWorkerStatus({ running: true, last_poll_at: pollAt, last_error_code: null });
  let discoveredCount = 0;
  let quarantinedCount = 0;
  try {
    const videos = await discoverReplays({ signal: _abortController.signal });
    for (const summary of videos) {
      if (summary.isLive) continue;
      const session = _correlateRecordingSession(summary);
      if (!session) {
        _quarantine(summary, 'no_known_recording_session');
        quarantinedCount += 1;
        continue;
      }
      const detail = await _ptFetch(`/api/v1/videos/${encodeURIComponent(summary.uuid)}`, { signal: _abortController.signal });
      const result = upsertReplay(detail);
      if (result.matched) discoveredCount += 1;
      else if (result.quarantined) quarantinedCount += 1;
      _acquireLease();
    }
    const processing = db.prepare(`
      SELECT peertube_video_uuid FROM peertube_replays
       WHERE processing_state IN ('discovering','processing')
       ORDER BY updated_at ASC LIMIT 100
    `).all();
    for (const row of processing) {
      const detail = await _ptFetch(`/api/v1/videos/${encodeURIComponent(row.peertube_video_uuid)}`, { signal: _abortController.signal });
      upsertReplay(detail);
      _acquireLease();
    }
    _backoff = 0;
    _writeWorkerStatus({
      running: false, last_success_at: Date.now(), last_error_code: null, backoff_ms: 0,
      discovered_count: discoveredCount, quarantined_count: quarantinedCount,
    });
    return { ok: true, discoveredCount, quarantinedCount };
  } catch (caught) {
    if (_abortController && _abortController.signal.aborted && !_scheduled) {
      _writeWorkerStatus({ running: false, last_error_code: null });
      return { skipped: 'cancelled' };
    }
    _backoff = _computeBackoff(_backoff, _cfg().pollIntervalMs, _cfg().pollBackoffMaxMs);
    const safeCode = caught && caught.status ? `http_${caught.status}` : (caught && caught.name === 'AbortError' ? 'timeout' : 'request_failed');
    _writeWorkerStatus({ running: false, last_error_code: safeCode, backoff_ms: _backoff });
    return { ok: false, error_code: safeCode };
  } finally {
    _running = false;
    _abortController = null;
  }
}

function _schedule(delay) {
  if (!_scheduled) return;
  if (_timer) clearTimeout(_timer);
  _timer = setTimeout(async () => {
    _timer = null;
    await _tick();
    if (_scheduled) _schedule(_backoff || Math.max(Number(_cfg().pollIntervalMs) || 60000, 1000));
  }, Math.max(Number(delay) || 0, 0));
  _timer.unref?.();
}

function start({ io } = {}) {
  if (io) _io = io;
  if (!_enabled() || _scheduled) return false;
  _scheduled = true;
  _schedule(Math.max(Number(_cfg().initialDelayMs) || 5000, 0));
  return true;
}

function stop() {
  _scheduled = false;
  if (_timer) {
    clearTimeout(_timer);
    _timer = null;
  }
  if (_abortController) _abortController.abort(new Error('PeerTube replay worker stopped'));
  try {
    db.prepare('DELETE FROM peertube_replay_worker_leases WHERE lease_name=? AND owner_id=?').run(WORKER_NAME, WORKER_OWNER);
    _writeWorkerStatus({ owner_id: null, running: false });
  } catch (_) { /* shutdown after DB close */ }
}

function getWorkerHealth() {
  const persisted = db.prepare('SELECT * FROM peertube_replay_worker_status WHERE worker_name=?').get(WORKER_NAME) || null;
  const lease = db.prepare('SELECT owner_id, expires_at, heartbeat_at FROM peertube_replay_worker_leases WHERE lease_name=?').get(WORKER_NAME) || null;
  return {
    enabled: _enabled(),
    scheduled: _scheduled,
    running: _running,
    lease_active: Boolean(lease && lease.expires_at > Date.now()),
    lease_expires_at: lease ? lease.expires_at : null,
    status: persisted ? {
      running: Boolean(persisted.running),
      last_poll_at: persisted.last_poll_at,
      last_success_at: persisted.last_success_at,
      last_error_code: persisted.last_error_code,
      backoff_ms: persisted.backoff_ms,
      discovered_count: persisted.discovered_count,
      quarantined_count: persisted.quarantined_count,
    } : null,
  };
}

function _resetForTests() {
  stop();
  _tokenCache = null;
  _oauthClientCache = null;
  _backoff = 0;
  _io = null;
}

module.exports = {
  STATE,
  start,
  stop,
  getWorkerHealth,
  discoverReplays,
  fetchPlaybackResponse,
  getPlaybackBinding,
  registerRecordingSession,
  upsertReplay,
  listPending,
  listAll,
  getById,
  addToMediaControl,
  discard,
  retry,
  archive,
  requestVisibility,
  setVisibility,
  approveOrganizationPublication,
  getRevision,
  _toReplay,
  _mapProcessingState,
  _correlateRecordingSession,
  _playbackUrl,
  _ptFetch,
  _resolveToken,
  _assertAllowedPlaybackUrl,
  _computeBackoff,
  _acquireLease,
  _tick,
  _resetForTests,
};
