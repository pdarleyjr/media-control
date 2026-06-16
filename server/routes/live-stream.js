'use strict';

const express = require('express');
const router = express.Router();
const config = require('../config');
const { buildLiveStreamPlayerUrl, ensureLiveStreamDisplay, liveStreamProgramState } = require('../lib/live-stream-display');
const { logActivity, getClientIp } = require('../services/activity');
const { audit } = require('../lib/audit');

const HOLDING_SCENE = 'HOLDING_SLIDE';

function requestBaseUrl(req) {
  const configured = config.liveStream.playerBaseUrl;
  if (configured) return configured;
  return `${req.protocol}://${req.get('host')}`;
}

function displayPayload(req) {
  const display = ensureLiveStreamDisplay({ workspaceId: req.workspaceId, userId: req.user.id });
  return {
    display: {
      id: display.id,
      name: display.name,
      status: display.status,
      workspace_id: display.workspace_id,
    },
    player_url: buildLiveStreamPlayerUrl({ baseUrl: requestBaseUrl(req), display }),
  };
}

async function callDirector(method, path, body) {
  const base = String(config.liveStream.aiDirectorUrl || '').replace(/\/+$/, '');
  if (!base) return { ok: false, message: 'AI Director URL is not configured' };
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.liveStream.aiDirectorTimeoutMs);
  try {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
    const text = await response.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = text; }
    if (!response.ok) {
      const message = data && typeof data === 'object'
        ? (data.detail || data.error || response.statusText)
        : (text || response.statusText);
      return { ok: false, status: response.status, message, data };
    }
    return { ok: true, status: response.status, data };
  } catch (e) {
    const message = e && e.name === 'AbortError'
      ? 'AI Director request timed out'
      : (e && e.message) || 'AI Director request failed';
    return { ok: false, message };
  } finally {
    clearTimeout(timeout);
  }
}

function logLiveStreamAction(req, action, details) {
  try {
    logActivity(req.user.id, `POST /api/live-stream/${action}`, details, null, getClientIp(req), req.workspaceId);
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
  const director = await callDirector('GET', '/status');
  res.json({
    ...payload,
    ai_director: director,
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

  const programUrl = await callDirector('POST', '/media-control/program-url', { url: payload.player_url });
  if (!programUrl.ok || (programUrl.data && programUrl.data.ok === false)) {
    return res.status(502).json({
      ...payload,
      success: false,
      error: programUrl.data && programUrl.data.message || programUrl.message || 'AI Director could not update OBS Media Control source',
      program_url: programUrl,
    });
  }

  const mode = await callDirector('POST', '/mode/auto');
  if (!mode.ok) {
    return res.status(502).json({
      ...payload,
      success: false,
      error: mode.message || 'AI Director could not enter auto mode',
      mode,
    });
  }

  const statusAfterMode = await callDirector('GET', '/status');

  const stream = await callDirector('POST', '/stream/start');
  const status = await callDirector('GET', '/status');
  const streamStarted = !!(stream.ok && stream.data && stream.data.ok !== false);
  logLiveStreamAction(req, 'start', {
    mode: 'auto',
    selected_scene: statusAfterMode.data && statusAfterMode.data.current_scene || null,
    stream_started: streamStarted,
    stream_message: stream.data && stream.data.message || stream.message || null,
  });

  res.json({
    ...payload,
    success: true,
    program_url: programUrl,
    mode,
    selected_scene: statusAfterMode,
    stream_start: stream,
    stream_started: streamStarted,
    ai_director_status: status,
    peertube_watch_url: config.liveStream.peerTubeWatchUrl || null,
  });
});

router.post('/stop', async (req, res) => {
  if (!req.workspaceId) return res.status(400).json({ error: 'No active workspace' });
  const payload = displayPayload(req);
  const stream = await callDirector('POST', '/stream/stop');
  const scene = await callDirector('POST', `/scene/${encodeURIComponent(HOLDING_SCENE)}`);
  logLiveStreamAction(req, 'stop', {
    stream_message: stream.data && stream.data.message || stream.message || null,
    scene: HOLDING_SCENE,
  });
  res.json({
    ...payload,
    success: stream.ok,
    stream_stop: stream,
    scene,
  });
});

module.exports = router;
