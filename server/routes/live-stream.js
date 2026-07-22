'use strict';

const express = require('express');
const router = express.Router();
const config = require('../config');
const { db } = require('../db/database');
const { buildLiveStreamPlayerUrl, ensureLiveStreamDisplay, liveStreamProgramState, markLiveContentChanged } = require('../lib/live-stream-display');
const { updateLiveProductionState, getLiveProductionState } = require('../lib/live-production-state');
const { publishRoomSnapshot } = require('../lib/room-state-broadcaster');
const { logActivity, getClientIp } = require('../services/activity');
const { audit } = require('../lib/audit');

const HOLDING_SCENE = 'HOLDING_SLIDE';
const DEAD_SCENES = new Set([HOLDING_SCENE, 'EMERGENCY_FALLBACK']);

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function waitForDirector(predicate, timeoutMs = 12000) {
  const deadline = Date.now() + timeoutMs;
  let latest = null;
  while (Date.now() < deadline) {
    latest = await callDirector('GET', '/status');
    if (latest.ok && predicate(latest.data || {})) return latest;
    await sleep(750);
  }
  return latest;
}

function sceneMatchesProgramState(data, contentActive) {
  const scene = String(data && data.current_scene || '');
  const director = data && data.director || {};
  const activeCamera = Number(director.active_camera) || null;
  if (data.mode !== 'auto' || DEAD_SCENES.has(scene)) return false;
  if (!!director.content_active !== !!contentActive) return false;
  if (!activeCamera) return contentActive && scene === 'MEDIA_CONTROL_FULL';
  if (!contentActive) return scene === `KAMRUI_CAMERA_${activeCamera}_FULL`;
  if (scene === 'MEDIA_CONTROL_FULL') return true;
  return scene.includes(`CAM${activeCamera}`) || scene.includes(`CAMERA_${activeCamera}`);
}

function requestBaseUrl(req) {
  // The live-stream player URL is loaded by OBS's browser source on the SAME
  // machine as the media-control server. Always use localhost (127.0.0.1:8096)
  // for the OBS browser source so the player's WebSocket + content URLs bypass
  // the Cloudflare tunnel entirely — the tunnel adds latency and can fail the
  // WebSocket upgrade, leaving the PIP stuck in "connecting". Direct localhost
  // is instant and reliable for same-machine OBS.
  const configured = config.liveStream.playerBaseUrl;
  if (configured) return configured;
  // Default to localhost for OBS (same machine). Fall back to the request URL
  // only if explicitly unset AND no localhost port is available.
  return 'http://127.0.0.1:8096';
}

function freshProgramUrl(playerUrl) {
  const url = new URL(playerUrl);
  url.searchParams.set('_mc_live_session', `${Date.now()}`);
  return url.toString();
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

function observeDirectorResult(req, result, reason) {
  const observation = updateLiveProductionState(req.workspaceId, result);
  if (observation.changed) {
    try {
      const io = req.app && typeof req.app.get === 'function' ? req.app.get('io') : null;
      if (io) {
        publishRoomSnapshot(io, {
          workspaceId: req.workspaceId,
          roomId: config.console.roomId,
          reason,
          bump: true,
        });
      }
    } catch (error) {
      console.warn(`[live-production] room snapshot publish failed: ${error.message}`);
    }
  }
  return observation.state;
}

router.get('/status', async (req, res) => {
  if (!req.workspaceId) return res.status(400).json({ error: 'No active workspace' });
  const payload = displayPayload(req);
  const director = await callDirector('GET', '/status');
  const productionState = observeDirectorResult(req, director, 'status:checked');
  res.json({
    ...payload,
    ai_director: director,
    production_state: productionState,
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
  const programState = liveStreamProgramState(req.workspaceId);
  const playerUrl = freshProgramUrl(payload.player_url);

  const programUrl = await callDirector('POST', '/media-control/program-url', { url: playerUrl });
  if (!programUrl.ok || (programUrl.data && programUrl.data.ok === false)) {
    return res.status(502).json({
      ...payload,
      success: false,
      error: programUrl.data && programUrl.data.message || programUrl.message || 'AI Director could not update OBS Media Control source',
      program_url: programUrl,
    });
  }

  // A unique URL plus refreshnocache forces OBS's browser source to discard a
  // prior presentation frame before scene selection. Without this preflight,
  // an idle browser source can survive between broadcasts and reappear as PIP.
  const programRefresh = await callDirector('POST', '/media-control/refresh');
  if (!programRefresh.ok || (programRefresh.data && programRefresh.data.ok === false)) {
    return res.status(502).json({
      ...payload,
      success: false,
      error: programRefresh.data && programRefresh.data.message || programRefresh.message || 'AI Director could not refresh the OBS Media Control source',
      program_url: programUrl,
      program_refresh: programRefresh,
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

  const statusAfterMode = await waitForDirector(
    data => sceneMatchesProgramState(data, programState.content_active),
  );
  const preparedProductionState = observeDirectorResult(req, statusAfterMode, 'stream:prepared');
  if (!statusAfterMode || !statusAfterMode.ok
      || !sceneMatchesProgramState(statusAfterMode.data, programState.content_active)) {
    return res.status(503).json({
      ...payload,
      success: false,
      error: 'AI Director did not prepare a current camera scene; the stream was not started',
      program_state: programState,
      selected_scene: statusAfterMode,
      production_state: preparedProductionState,
    });
  }

  const stream = await callDirector('POST', '/stream/start');
  const streamStarted = !!(stream.ok && stream.data && stream.data.ok !== false);
  if (!streamStarted) {
    return res.status(502).json({
      ...payload,
      success: false,
      error: stream.data && stream.data.message || stream.message || 'OBS could not start the live stream',
      program_state: programState,
      selected_scene: statusAfterMode,
      stream_start: stream,
      production_state: preparedProductionState,
    });
  }
  const status = await waitForDirector(data => data.stream_active === true, 8000);
  const productionState = observeDirectorResult(req, status, 'stream:start-verified');
  const streamVerified = !!(status && status.ok && status.data && status.data.stream_active === true);
  if (!streamVerified) {
    await callDirector('POST', '/stream/stop');
    return res.status(502).json({
      ...payload,
      success: false,
      error: 'OBS did not confirm that the live stream became active',
      program_state: programState,
      selected_scene: statusAfterMode,
      stream_start: stream,
      ai_director_status: status,
      production_state: productionState,
    });
  }
  logLiveStreamAction(req, 'start', {
    mode: 'auto',
    selected_scene: statusAfterMode.data && statusAfterMode.data.current_scene || null,
    stream_started: streamStarted,
    stream_message: stream.data && stream.data.message || stream.message || null,
  });

  res.json({
    ...payload,
    success: true,
    program_state: programState,
    program_url: programUrl,
    program_refresh: programRefresh,
    mode,
    selected_scene: statusAfterMode,
    stream_start: stream,
    stream_started: streamStarted,
    ai_director_status: status,
    production_state: productionState,
    peertube_watch_url: config.liveStream.peerTubeWatchUrl || null,
  });
});

router.post('/stop', async (req, res) => {
  if (!req.workspaceId) return res.status(400).json({ error: 'No active workspace' });
  const payload = displayPayload(req);
  const stream = await callDirector('POST', '/stream/stop');
  const mode = await callDirector('POST', '/mode/manual');
  const scene = await callDirector('POST', `/scene/${encodeURIComponent(HOLDING_SCENE)}`);

  // Verify the stream actually stopped. The AI Director stop call can return
  // ok while OBS is still winding down (or silently fail to tear down the
  // PeerTube/OBS output). Poll /status every 2s for up to 10s; if
  // stream_active is still true, send a second stop command.
  let verifiedActive = null;
  let secondStop = null;
  let productionState = getLiveProductionState(req.workspaceId);
  try {
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 2000));
      const check = await callDirector('GET', '/status');
      productionState = observeDirectorResult(req, check, 'stream:stop-verification');
      const active = check && check.ok && check.data
        && typeof check.data.stream_active === 'boolean'
        ? check.data.stream_active
        : null;
      verifiedActive = active;
      if (active === false) break;
    }
    if (verifiedActive === true) {
      secondStop = await callDirector('POST', '/stream/stop');
      await new Promise((r) => setTimeout(r, 1000));
      const check = await callDirector('GET', '/status');
      productionState = observeDirectorResult(req, check, 'stream:stop-verification');
      verifiedActive = check && check.ok && check.data
        && typeof check.data.stream_active === 'boolean'
        ? check.data.stream_active
        : null;
    }
  } catch (_) { /* verification is best-effort; the primary stop already ran */ }

  logLiveStreamAction(req, 'stop', {
    stream_message: stream.data && stream.data.message || stream.message || null,
    scene: HOLDING_SCENE,
    stream_active_after: verifiedActive,
    second_stop_sent: !!secondStop,
  });
  res.json({
    ...payload,
    success: stream.ok && verifiedActive === false,
    stream_stop: stream,
    mode,
    scene,
    stream_active_after: verifiedActive,
    second_stop: secondStop,
    production_state: productionState,
  });
});

router.post('/clear-content', async (req, res) => {
  if (!req.workspaceId) return res.status(400).json({ error: 'No active workspace' });
  const display = ensureLiveStreamDisplay({ workspaceId: req.workspaceId, userId: req.user.id });
  let cleared = false;
  try {
    const device = db.prepare('SELECT playlist_id FROM devices WHERE id = ?').get(display.id);
    if (device && device.playlist_id) {
      db.prepare("UPDATE playlists SET status = 'published', published_snapshot = '[]', updated_at = strftime('%s','now') WHERE id = ?")
        .run(device.playlist_id);
      cleared = true;
    }
    try {
      const queue = require('../lib/command-queue');
      const { buildPlaylistPayload } = require('../ws/deviceSocket');
      const io = req.app.get('io');
      const deviceNs = io && io.of('/device');
      if (deviceNs && typeof queue.queueOrEmitPlaylistUpdate === 'function') {
        queue.queueOrEmitPlaylistUpdate(deviceNs, display.id, buildPlaylistPayload);
      }
    } catch (_) {}
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message || 'Failed to clear live content' });
  }
  markLiveContentChanged(display.id);
  const refresh = await callDirector('POST', '/media-control/refresh');
  logLiveStreamAction(req, 'clear-content', { cleared });
  res.json({ success: true, cleared, refresh, program_state: liveStreamProgramState(req.workspaceId) });
});

router.post('/refresh', async (req, res) => {
  if (!req.workspaceId) return res.status(400).json({ error: 'No active workspace' });
  const refresh = await callDirector('POST', '/media-control/refresh');
  res.json({ success: !!refresh.ok, refresh });
});

module.exports = router;
