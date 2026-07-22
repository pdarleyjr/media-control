'use strict';

const express = require('express');
const svc = require('../services/peertube-replay');
const { pipePlayback } = require('./peertube-playback');
const { audit } = require('../lib/audit');
const { issuePlaybackGrant } = require('../lib/peertube-playback-grant');
const { requireWorkspaceRead } = require('../lib/permissions');
const {
  VISIBILITY,
  canAddReplay,
  canDiscardReplay,
  canReadReplayMedia,
  canRequestVisibility,
  canApproveOrganizationPublication,
} = require('../lib/peertube-replay-permissions');

const router = express.Router();

router.use(requireWorkspaceRead);

function context(req, replay = null) {
  return {
    userRole: req.user && req.user.role,
    workspaceRole: req.workspaceRole,
    orgRole: req.orgRole,
    isPlatformAdmin: req.isPlatformAdmin,
    actingAs: req.actingAs,
    isRecordingInstructor: Boolean(replay && req.user && replay.instructor_user_id === req.user.id),
  };
}

function sourceIp(req) {
  return req.ip || req.socket && req.socket.remoteAddress || null;
}

function auditRequest(req, action, targetId = null, details = null) {
  audit({
    actorType: 'user',
    actorId: req.user && req.user.id,
    action,
    targetType: targetId ? 'peertube_replay' : 'workspace',
    targetId: targetId || req.workspaceId,
    workspaceId: req.workspaceId,
    sourceIp: sourceIp(req),
    details,
  });
}

function boundedInt(value, fallback, maximum) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return Math.min(parsed, maximum);
}

function parseVisibility(raw) {
  if (typeof raw !== 'string' || !Object.values(VISIBILITY).includes(raw)) {
    throw Object.assign(new Error('Invalid Media Control visibility'), { code: 400 });
  }
  return raw;
}

function scopedReplay(req, res) {
  const replay = svc.getById(req.params.id, req.workspaceId);
  if (!replay) {
    res.status(404).json({ error: 'Replay not found' });
    return null;
  }
  return replay;
}

router.get('/health', (req, res) => {
  auditRequest(req, 'peertube.replay.health.read');
  res.json(svc.getWorkerHealth());
});

router.get('/pending', (req, res) => {
  const replays = svc.listPending({
    workspaceId: req.workspaceId,
    limit: boundedInt(req.query.limit, 50, 200),
    offset: boundedInt(req.query.offset, 0, 100000),
  });
  auditRequest(req, 'peertube.replay.pending.read', null, { count: replays.length });
  res.json({ replays, revision: svc.getRevision(req.workspaceId) });
});

router.get('/', (req, res) => {
  const replays = svc.listAll({
    workspaceId: req.workspaceId,
    limit: boundedInt(req.query.limit, 100, 500),
    offset: boundedInt(req.query.offset, 0, 100000),
  });
  auditRequest(req, 'peertube.replay.list.read', null, { count: replays.length });
  res.json({ replays, revision: svc.getRevision(req.workspaceId) });
});

router.post('/sessions', (req, res) => {
  const ctx = context(req, { instructor_user_id: req.user && req.user.id });
  if (!canAddReplay(ctx, VISIBILITY.PRIVATE)) {
    return res.status(403).json({ error: 'Instructor, workspace admin, or higher role required' });
  }
  try {
    const session = svc.registerRecordingSession({
      id: req.body.id,
      workspaceId: req.workspaceId,
      instructorUserId: req.body.instructor_user_id || req.user.id,
      title: req.body.title,
      roomId: req.body.room_id,
      roomName: req.body.room_name,
      liveVideoUuid: req.body.live_video_uuid,
      streamSessionId: req.body.stream_session_id,
      obsRecordingId: req.body.obs_recording_id,
      expectedReplayUuid: req.body.expected_replay_uuid,
      startedAt: req.body.started_at,
      endedAt: req.body.ended_at,
      status: req.body.status,
      metadata: req.body.metadata,
    });
    auditRequest(req, 'peertube.recording_session.register', session.id);
    res.status(201).json(session);
  } catch (caught) {
    res.status(caught.code || 500).json({ error: caught.message });
  }
});

router.get('/:id', (req, res) => {
  const replay = scopedReplay(req, res);
  if (!replay) return;
  auditRequest(req, 'peertube.replay.read', replay.id);
  res.json(replay);
});

router.get('/:id/watch', (req, res, next) => {
  const replay = scopedReplay(req, res);
  if (!replay) return;
  if (!canReadReplayMedia(context(req, replay), replay)) {
    return res.status(403).json({ error: 'Replay media is private' });
  }
  auditRequest(req, 'peertube.replay.watch', replay.id);
  return pipePlayback(req, res, next);
});

router.get('/:id/download', (req, res, next) => {
  const replay = scopedReplay(req, res);
  if (!replay) return;
  if (!canReadReplayMedia(context(req, replay), replay)) {
    return res.status(403).json({ error: 'Replay media is private' });
  }
  auditRequest(req, 'peertube.replay.download', replay.id);
  return pipePlayback(req, res, next, { disposition: 'attachment' });
});

router.post('/:id/playback-grant', (req, res) => {
  const replay = scopedReplay(req, res);
  if (!replay) return;
  if (!canReadReplayMedia(context(req, replay), replay)) {
    return res.status(403).json({ error: 'Replay media is private' });
  }
  const grant = issuePlaybackGrant({
    replayId: replay.id,
    workspaceId: req.workspaceId,
    userId: req.user.id,
  });
  const download = req.body && req.body.download === true ? '&download=1' : '';
  auditRequest(req, 'peertube.replay.playback_grant', replay.id, { download: download !== '' });
  res.json({
    url: `/api/peertube-replays/${encodeURIComponent(replay.id)}/playback?grant=${encodeURIComponent(grant)}${download}`,
    expires_in: 300,
  });
});

router.post('/:id/add', (req, res) => {
  const replay = scopedReplay(req, res);
  if (!replay) return;
  let visibility;
  try { visibility = parseVisibility(req.body.visibility === undefined ? VISIBILITY.PRIVATE : req.body.visibility); }
  catch (caught) { return res.status(caught.code).json({ error: caught.message }); }
  if (!canAddReplay(context(req, replay), visibility)) {
    return res.status(403).json({ error: 'Role is not permitted to publish this replay with the requested visibility' });
  }
  try {
    const result = svc.addToMediaControl({
      replayId: replay.id,
      userId: req.user.id,
      workspaceId: req.workspaceId,
      visibility,
      title: req.body.title == null ? null : String(req.body.title).slice(0, 255),
    });
    res.status(result.created ? 201 : 200).json(result);
  } catch (caught) {
    res.status(caught.code || 500).json({ error: caught.message });
  }
});

router.post('/:id/discard', (req, res) => {
  const replay = scopedReplay(req, res);
  if (!replay) return;
  if (!canDiscardReplay(context(req, replay))) {
    return res.status(403).json({ error: 'Workspace administrator or higher role required' });
  }
  try {
    res.json(svc.discard({ replayId: replay.id, workspaceId: req.workspaceId, userId: req.user.id }));
  } catch (caught) {
    res.status(caught.code || 500).json({ error: caught.message });
  }
});

router.post('/:id/retry', (req, res) => {
  const replay = scopedReplay(req, res);
  if (!replay) return;
  if (!canDiscardReplay(context(req, replay))) {
    return res.status(403).json({ error: 'Workspace administrator or higher role required' });
  }
  try {
    res.json(svc.retry({ replayId: replay.id, workspaceId: req.workspaceId, userId: req.user.id }));
  } catch (caught) {
    res.status(caught.code || 500).json({ error: caught.message });
  }
});

router.post('/:id/archive', (req, res) => {
  const replay = scopedReplay(req, res);
  if (!replay) return;
  if (!canDiscardReplay(context(req, replay))) {
    return res.status(403).json({ error: 'Workspace administrator or higher role required' });
  }
  try {
    res.json(svc.archive({ replayId: replay.id, workspaceId: req.workspaceId, userId: req.user.id }));
  } catch (caught) {
    res.status(caught.code || 500).json({ error: caught.message });
  }
});

router.post('/:id/visibility-request', (req, res) => {
  const replay = scopedReplay(req, res);
  if (!replay) return;
  let visibility;
  try { visibility = parseVisibility(req.body.visibility); }
  catch (caught) { return res.status(caught.code).json({ error: caught.message }); }
  if (!canRequestVisibility(context(req, replay), visibility)) {
    return res.status(403).json({ error: 'Role is not permitted to request this visibility' });
  }
  try {
    res.json(svc.requestVisibility({
      replayId: replay.id,
      workspaceId: req.workspaceId,
      userId: req.user.id,
      visibility,
    }));
  } catch (caught) {
    res.status(caught.code || 500).json({ error: caught.message });
  }
});

router.patch('/:id/visibility', (req, res) => {
  const replay = scopedReplay(req, res);
  if (!replay) return;
  let visibility;
  try { visibility = parseVisibility(req.body.visibility); }
  catch (caught) { return res.status(caught.code).json({ error: caught.message }); }
  if (visibility === VISIBILITY.ORGANIZATION_SHARED) {
    return res.status(400).json({ error: 'Organization visibility requires the publication approval workflow' });
  }
  if (!canRequestVisibility(context(req, replay), visibility)) {
    return res.status(403).json({ error: 'Role is not permitted to change to this visibility' });
  }
  try {
    res.json(svc.setVisibility({
      replayId: replay.id,
      workspaceId: req.workspaceId,
      userId: req.user.id,
      visibility,
    }));
  } catch (caught) {
    res.status(caught.code || 500).json({ error: caught.message });
  }
});

router.post('/:id/organization-publication/approve', (req, res) => {
  const replay = scopedReplay(req, res);
  if (!replay) return;
  if (!canApproveOrganizationPublication(context(req, replay))) {
    return res.status(403).json({ error: 'Organization publisher or platform administrator required' });
  }
  try {
    res.json(svc.approveOrganizationPublication({
      replayId: replay.id,
      workspaceId: req.workspaceId,
      userId: req.user.id,
    }));
  } catch (caught) {
    res.status(caught.code || 500).json({ error: caught.message });
  }
});

module.exports = router;
