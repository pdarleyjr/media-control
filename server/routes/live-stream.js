'use strict';

const express = require('express');
const router = express.Router();
const config = require('../config');
const cameraControl = require('../lib/camera-control-client');
const { buildLiveStreamPlayerUrl, ensureLiveStreamDisplay, liveStreamProgramState } = require('../lib/live-stream-display');
const { logActivity, getClientIp } = require('../services/activity');
const { audit } = require('../lib/audit');

function displayPayload(req) {
  const display = ensureLiveStreamDisplay({ workspaceId: req.workspaceId, userId: req.user.id });
  return {
    display: {
      id: display.id,
      name: display.name,
      status: display.status,
      workspace_id: display.workspace_id,
    },
    player_url: buildLiveStreamPlayerUrl({ baseUrl: config.liveStream.playerBaseUrl || req.app.get('app_url') || '', display }),
  };
}

function logLiveStreamAction(req, action, details) {
  try {
    const detailsText = details == null ? null : (typeof details === 'string' ? details : JSON.stringify(details));
    logActivity(req.user.id, `POST /api/live-stream/${action}`, detailsText, null, getClientIp(req), req.workspaceId);
  } catch (_) {}
  try {
    audit({
      actorType: 'user',
      actorId: req.user.id,
      action: `live_stream.${action}`,
      targetType: 'workspace',
      targetId: req.workspaceId,
      workspaceId: req.workspaceId,
      sourceIp: getClientIp(req),
      details,
    });
  } catch (_) {}
}

router.get('/status', async (req, res) => {
  if (!req.workspaceId) return res.status(400).json({ error: 'No active workspace' });
  const payload = displayPayload(req);
  const camera = await cameraControl.getStatus();
  res.json({
    ...payload,
    camera_control: camera,
    peertube_watch_url: config.liveStream.peerTubeWatchUrl || null,
  });
});

router.get('/display', (req, res) => {
  if (!req.workspaceId) return res.status(400).json({ error: 'No active workspace' });
  res.json(displayPayload(req));
});

router.get('/program-state', (req, res) => {
  if (!req.workspaceId) return res.status(400).json({ error: 'No active workspace' });
  res.json(liveStreamProgramState(req.workspaceId));
});

router.post('/start', async (req, res) => {
  if (!req.workspaceId) return res.status(400).json({ error: 'No active workspace' });
  const payload = displayPayload(req);

  const result = await cameraControl.startLivestream();
  logLiveStreamAction(req, 'start', result);

  if (!result.ok) {
    return res.status(502).json({
      ...payload,
      success: false,
      error: result.message || 'Camera control could not start livestream',
      camera_control: result,
    });
  }

  res.json({
    ...payload,
    success: true,
    camera_control: result,
    peertube_watch_url: result.data?.peertube_watch_url || config.liveStream.peerTubeWatchUrl || null,
  });
});

router.post('/stop', async (req, res) => {
  if (!req.workspaceId) return res.status(400).json({ error: 'No active workspace' });
  const payload = displayPayload(req);

  const result = await cameraControl.stopLivestream();
  logLiveStreamAction(req, 'stop', result);

  if (!result.ok) {
    return res.status(502).json({
      ...payload,
      success: false,
      error: result.message || 'Camera control could not stop livestream',
      camera_control: result,
    });
  }

  res.json({
    ...payload,
    success: true,
    camera_control: result,
  });
});

router.post('/record/start', async (req, res) => {
  if (!req.workspaceId) return res.status(400).json({ error: 'No active workspace' });

  const result = await cameraControl.startRecording();
  logLiveStreamAction(req, 'record-start', result);

  if (!result.ok) {
    return res.status(502).json({ success: false, error: result.message, camera_control: result });
  }

  res.json({ success: true, camera_control: result });
});

router.post('/record/stop', async (req, res) => {
  if (!req.workspaceId) return res.status(400).json({ error: 'No active workspace' });

  const result = await cameraControl.stopRecording();
  logLiveStreamAction(req, 'record-stop', result);

  if (!result.ok) {
    return res.status(502).json({ success: false, error: result.message, camera_control: result });
  }

  res.json({ success: true, camera_control: result });
});

router.post('/emergency-stop', async (req, res) => {
  if (!req.workspaceId) return res.status(400).json({ error: 'No active workspace' });

  const result = await cameraControl.emergencyStop();
  logLiveStreamAction(req, 'emergency-stop', result);

  res.json({ success: result.ok, camera_control: result });
});

router.get('/recordings', async (req, res) => {
  if (!req.workspaceId) return res.status(400).json({ error: 'No active workspace' });
  const result = await cameraControl.getRecordings();
  res.json(result.ok ? result.data : { recordings: [], error: result.message });
});

module.exports = router;
