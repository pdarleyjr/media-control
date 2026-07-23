'use strict';

const express = require('express');
const router = express.Router();
const config = require('../config');
const { db } = require('../db/database');
const {
  buildLiveStreamPlayerUrl,
  ensureLiveStreamDisplay,
  liveStreamProgramState,
  markLiveContentChanged,
} = require('../lib/live-stream-display');
const {
  updateLiveProductionState,
  getLiveProductionState,
  setLiveStreamLastError,
  clearLiveStreamLastError,
  getLiveStreamLastError,
} = require('../lib/live-production-state');
const { publishRoomSnapshot } = require('../lib/room-state-broadcaster');
const { logActivity, getClientIp } = require('../services/activity');
const { audit } = require('../lib/audit');
const { sceneIsSafeToStream, APPROVED_PROGRAM_SCENES } = require('../lib/live-stream-safety');
const {
  ERROR_CODES,
  buildLivestreamCapabilities,
  classifyDirectorFailure,
  createRequestId,
  errorEnvelope,
  redactDirectorResult,
  startGateFailure,
} = require('../lib/live-stream-capabilities');
const {
  putPlan,
  getPlan,
  consumePlanForStart,
  cameraScene,
} = require('../lib/production-plan');

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function waitForDirector(predicate, timeoutMs = 12000) {
  // Use the fast /director/state endpoint for scene confirmation — not the
  // heavy /status endpoint which does HLS/RTSP/ffprobe/Ollama probes and takes
  // 2-3 seconds per call. /director/state reads cached policy state + a single
  // OBS scene read, targeting <250ms. Fall back to /status when the fast
  // endpoint is unavailable (older director builds / test doubles).
  const deadline = Date.now() + timeoutMs;
  let latest = null;
  while (Date.now() < deadline) {
    latest = await callDirector('GET', '/director/state');
    if (!latest.ok) latest = await callDirector('GET', '/status');
    if (latest.ok && predicate(latest.data || {})) return latest;
    await sleep(300);
  }
  return latest;
}

function planAwareSafetyGate(data, plan, contentActive) {
  const failures = [];
  const scene = String(data && data.current_scene || data.actual_obs_scene || '');
  const configuredMode = String(data && data.configured_mode || data.mode || '').toLowerCase();
  const effectiveMode = String(data && data.effective_mode || data.mode || '').toLowerCase();
  const manualHold = !!(data && (data.manual_hold === true || data.manual_hold === undefined && configuredMode === 'manual'));
  const autoswitchRt = !!(data && (data.autoswitch_runtime_enabled === true || data.autoswitch_enabled === true));
  const obsConnected = !!(data && (data.obs_connected === true || data.obs === true));

  if (!obsConnected) failures.push('obs_not_connected');
  if (!APPROVED_PROGRAM_SCENES.has(scene)) failures.push('scene_not_approved');

  if (plan.production_mode === 'fixed_camera') {
    const expectedScene = plan.scene_name || cameraScene(plan.camera_id);
    if (scene !== expectedScene) failures.push('actual_scene_mismatch');
    if (configuredMode !== 'manual') failures.push('mode_not_manual');
    if (effectiveMode !== 'manual') failures.push('effective_mode_not_manual');
    if (data && data.manual_hold === false) failures.push('manual_hold_false');
    if (autoswitchRt) failures.push('autoswitch_still_enabled');
    // Camera health is not in the past endpoint; accept if scene matches.
  } else if (plan.production_mode === 'ai_director') {
    if (configuredMode !== 'auto') failures.push('mode_not_auto');
    if (effectiveMode !== 'auto') failures.push('effective_mode_not_auto');
    if (!autoswitchRt && data && data.autoswitch_runtime_enabled === false) failures.push('autoswitch_not_enabled');
    if (data && data.manual_hold === true) failures.push('manual_hold_still_true');
    // Content composition: check director.content_active vs contentActive
    const director = (data && data.director) || {};
    if (typeof director.content_active === 'boolean' && director.content_active !== !!contentActive) {
      failures.push('content_state_mismatch');
    }
  } else if (plan.production_mode === 'manual_multicamera') {
    if (!plan.scene_name) {
      failures.push('manual_multicamera_null_initial_scene');
    } else {
      if (scene !== plan.scene_name) failures.push('actual_scene_mismatch');
    }
    if (configuredMode !== 'manual') failures.push('mode_not_manual');
    if (effectiveMode !== 'manual') failures.push('effective_mode_not_manual');
    if (data && data.manual_hold === false) failures.push('manual_hold_false');
    if (autoswitchRt) failures.push('autoswitch_still_enabled');
  }
  // legacy_director_mode (and any other mode): OBS + approved scene only.

  return {
    safe: failures.length === 0,
    failed_predicates: failures,
    expected_scene: plan.scene_name || (plan.production_mode === 'fixed_camera' ? cameraScene(plan.camera_id) : null),
    actual_scene: scene,
    approved_scene: APPROVED_PROGRAM_SCENES.has(scene),
    configured_mode: configuredMode,
    effective_mode: effectiveMode,
    manual_hold: manualHold,
    autoswitch_runtime_enabled: autoswitchRt,
  };
}

function requestBaseUrl() {
  const configured = config.liveStream.playerBaseUrl;
  if (configured) return configured;
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
    let parseError = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch (err) {
      parseError = err;
      data = text;
    }
    if (parseError && text && text.trim() && !text.trim().startsWith('{') && !text.trim().startsWith('[')) {
      return {
        ok: false,
        status: response.status,
        message: 'AI Director returned a non-JSON response',
        data: text.slice(0, 200),
        nonJson: true,
      };
    }
    if (!response.ok) {
      const message = data && typeof data === 'object'
        ? (data.detail || data.error || data.message || response.statusText)
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

function rememberFailure(req, classified, requestId) {
  setLiveStreamLastError(req.workspaceId, {
    code: classified.code,
    message: classified.error,
    requestId,
  });
}

function fail(res, req, {
  httpStatus = 400,
  code,
  error,
  requestId,
  payload = {},
  details,
  capabilities,
  productionState,
}) {
  const classified = { code, error };
  if (req && req.workspaceId && code) rememberFailure(req, classified, requestId);
  const envelope = errorEnvelope({ code, error, requestId, details, httpStatus });
  return res.status(httpStatus).json({
    ...payload,
    ...envelope.body,
    capabilities: capabilities || undefined,
    production_state: productionState || undefined,
  });
}

function workspaceGuard(req, res, requestId) {
  if (!req.workspaceId) {
    fail(res, null, {
      httpStatus: 400,
      code: ERROR_CODES.WORKSPACE_REQUIRED,
      error: 'No active workspace',
      requestId,
    });
    return false;
  }
  return true;
}

async function buildStatusContract(req, directorResult, requestId) {
  const payload = displayPayload(req);
  const programState = liveStreamProgramState(req.workspaceId);
  const productionState = observeDirectorResult(req, directorResult, 'status:checked');
  const lastError = getLiveStreamLastError(req.workspaceId);
  const capabilities = buildLivestreamCapabilities({
    workspaceId: req.workspaceId,
    display: payload.display,
    programState,
    directorResult,
    productionState,
    peerTubeWatchUrl: config.liveStream.peerTubeWatchUrl,
    lastError,
    requestId,
  });
  if (lastError && lastError.code === ERROR_CODES.OPERATOR_STREAM_START_DISABLED) {
    capabilities.operator_start_allowed = false;
  }
  return {
    payload,
    programState,
    productionState,
    capabilities,
    aiDirector: redactDirectorResult(directorResult),
  };
}

async function prepareLiveProgram(req) {
  const payload = displayPayload(req);
  const programState = liveStreamProgramState(req.workspaceId);
  const currentStatus = await callDirector('GET', '/status');
  if (currentStatus.ok && currentStatus.data && currentStatus.data.stream_active === true) {
    return {
      ok: false,
      status: 409,
      code: ERROR_CODES.STREAM_ALREADY_ACTIVE,
      payload,
      programState,
      currentStatus,
      error: 'The live stream is already active; program-source refresh is locked while on air',
    };
  }
  if (!currentStatus.ok) {
    const classified = classifyDirectorFailure(currentStatus, ERROR_CODES.AI_DIRECTOR_UNREACHABLE);
    return {
      ok: false,
      status: classified.code === ERROR_CODES.AI_DIRECTOR_TIMEOUT ? 504 : 502,
      code: classified.code,
      payload,
      programState,
      currentStatus,
      error: classified.error,
    };
  }
  const playerUrl = freshProgramUrl(payload.player_url);
  const programUrl = await callDirector('POST', '/media-control/program-url', { url: playerUrl });
  if (!programUrl.ok || (programUrl.data && programUrl.data.ok === false)) {
    const classified = classifyDirectorFailure(programUrl, ERROR_CODES.OBS_UNAVAILABLE);
    return {
      ok: false,
      status: 502,
      code: classified.code,
      payload,
      programState,
      programUrl,
      error: classified.error || 'AI Director could not update OBS Media Control source',
    };
  }

  const programRefresh = await callDirector('POST', '/media-control/refresh');
  if (!programRefresh.ok || (programRefresh.data && programRefresh.data.ok === false)) {
    const classified = classifyDirectorFailure(programRefresh, ERROR_CODES.OBS_UNAVAILABLE);
    return {
      ok: false,
      status: 502,
      code: classified.code,
      payload,
      programState,
      programUrl,
      programRefresh,
      error: classified.error || 'AI Director could not refresh the OBS Media Control source',
    };
  }
  return { ok: true, payload, programState, programUrl, programRefresh, currentStatus };
}

router.get('/status', async (req, res) => {
  const requestId = createRequestId();
  if (!workspaceGuard(req, res, requestId)) return;
  const director = await callDirector('GET', '/status');
  cacheDeepHealth(req.workspaceId, director);
  const contract = await buildStatusContract(req, director, requestId);
  res.json({
    success: true,
    request_id: requestId,
    freshness: 'deep',
    ...contract.payload,
    program_state: contract.programState,
    ai_director: contract.aiDirector,
    production_state: contract.productionState,
    capabilities: contract.capabilities,
    peertube_watch_url: config.liveStream.peerTubeWatchUrl || null,
    // Flat capability fields for Agent 4 consumers
    ...contract.capabilities,
  });
});

// Fast operator state: uses AI Director /director/state (<250ms) + cached deep probes.
// UI polls this endpoint; /status remains available for deep health / diagnostics.
const deepHealthCache = new Map(); // workspaceId -> { at, director }
const DEEP_HEALTH_TTL_MS = 30000;

function cacheDeepHealth(workspaceId, directorResult) {
  if (!workspaceId || !directorResult) return;
  deepHealthCache.set(workspaceId, { at: Date.now(), director: directorResult });
}

function getCachedDeepHealth(workspaceId) {
  const hit = deepHealthCache.get(workspaceId);
  if (!hit) return null;
  if (Date.now() - hit.at > DEEP_HEALTH_TTL_MS * 4) return null;
  return hit;
}

router.get('/operator-state', async (req, res) => {
  const requestId = createRequestId();
  if (!workspaceGuard(req, res, requestId)) return;
  const t0 = Date.now();
  const director = await callDirector('GET', '/director/state');
  const cached = getCachedDeepHealth(req.workspaceId);
  // Merge camera/health summary from cache when fast endpoint lacks streams.
  let directorForCaps = director;
  if (director.ok && cached && cached.director && cached.director.ok) {
    const fast = director.data || {};
    const deep = cached.director.data || {};
    directorForCaps = {
      ...director,
      data: {
        ...deep,
        ...fast,
        // Prefer fast stream/recording/mode flags; keep deep probe flags only if missing.
        stream_active: fast.stream_active ?? deep.stream_active,
        stream_state: fast.stream_state || deep.stream_state,
        recording_active: fast.recording_active ?? deep.recording_active,
        recording_state: fast.recording_state || deep.recording_state,
        current_scene: fast.current_scene || deep.current_scene,
        desired_scene: fast.desired_scene || deep.desired_scene,
        configured_mode: fast.configured_mode || deep.configured_mode || deep.mode,
        effective_mode: fast.effective_mode || deep.effective_mode || deep.mode,
        manual_hold: fast.manual_hold ?? deep.manual_hold,
        autoswitch_runtime_enabled: fast.autoswitch_runtime_enabled ?? deep.autoswitch_runtime_enabled,
        obs: fast.obs_connected ?? deep.obs,
        kamrui_camera_1_stream: deep.kamrui_camera_1_stream,
        kamrui_camera_2_stream: deep.kamrui_camera_2_stream,
        annke_camera_3_stream: deep.annke_camera_3_stream,
      },
    };
  } else if (director.ok) {
    const fast = director.data || {};
    directorForCaps = {
      ...director,
      data: {
        ...fast,
        obs: fast.obs_connected ?? fast.obs,
        mode: fast.effective_mode || fast.configured_mode || fast.mode,
      },
    };
  }
  const contract = await buildStatusContract(req, directorForCaps, requestId);
  const plan = getPlan(req.workspaceId);
  const elapsed = Date.now() - t0;
  res.json({
    success: true,
    request_id: requestId,
    freshness: cached ? 'fast+cached_deep' : 'fast',
    elapsed_ms: elapsed,
    deep_health_age_ms: cached ? Date.now() - cached.at : null,
    production_plan: plan || null,
    ...contract.payload,
    program_state: contract.programState,
    ai_director: contract.aiDirector,
    production_state: contract.productionState,
    capabilities: contract.capabilities,
    peertube_watch_url: config.liveStream.peerTubeWatchUrl || null,
    ...contract.capabilities,
    // Explicit operator fields for the action dock.
    stream_active: !!(director.ok && director.data && director.data.stream_active),
    stream_state: (director.ok && director.data && director.data.stream_state) || contract.capabilities.stream_state || null,
    recording_active: !!(director.ok && director.data && director.data.recording_active),
    recording_state: (director.ok && director.data && director.data.recording_state) || null,
    current_scene: (director.ok && director.data && director.data.current_scene) || null,
    desired_scene: (director.ok && director.data && director.data.desired_scene) || null,
    configured_mode: (director.ok && director.data && director.data.configured_mode) || null,
    effective_mode: (director.ok && director.data && director.data.effective_mode) || null,
    manual_hold: !!(director.ok && director.data && director.data.manual_hold),
    autoswitch_runtime_enabled: !!(director.ok && director.data && director.data.autoswitch_runtime_enabled),
    active_camera: (director.ok && director.data && director.data.active_camera) || null,
    state_revision: (director.ok && director.data && director.data.state_revision) || null,
    updated_at: (director.ok && director.data && director.data.updated_at) || null,
  });
});

router.get('/display', (req, res) => {
  const requestId = createRequestId();
  if (!workspaceGuard(req, res, requestId)) return;
  res.json({ success: true, request_id: requestId, ...displayPayload(req) });
});

router.get('/program-state', (req, res) => {
  const requestId = createRequestId();
  if (!workspaceGuard(req, res, requestId)) return;
  res.json({ success: true, request_id: requestId, ...liveStreamProgramState(req.workspaceId) });
});

router.post('/prepare', async (req, res) => {
  const requestId = createRequestId();
  if (!workspaceGuard(req, res, requestId)) return;
  const prepared = await prepareLiveProgram(req);
  if (!prepared.ok) {
    return fail(res, req, {
      httpStatus: prepared.status,
      code: prepared.code || ERROR_CODES.STREAM_START_REJECTED,
      error: prepared.error,
      requestId,
      payload: {
        ...prepared.payload,
        prepared: false,
        program_state: prepared.programState,
        program_url: redactDirectorResult(prepared.programUrl || { ok: false }),
        program_refresh: redactDirectorResult(prepared.programRefresh || { ok: false }),
      },
    });
  }
  logLiveStreamAction(req, 'prepare', { display_id: prepared.payload.display.id, request_id: requestId });
  res.json({
    ...prepared.payload,
    success: true,
    prepared: true,
    request_id: requestId,
    program_state: prepared.programState,
    program_url: redactDirectorResult(prepared.programUrl),
    program_refresh: redactDirectorResult(prepared.programRefresh),
  });
});

router.post('/production-plan', async (req, res) => {
  const requestId = createRequestId();
  if (!workspaceGuard(req, res, requestId)) return;
  const director = await callDirector('GET', '/director/state');
  const data = director && director.ok ? (director.data || {}) : {};
  const cams = {
    1: !!data.camera_streams && data.camera_streams["1"] || false,
    2: !!data.camera_streams && data.camera_streams["2"] || false,
    3: !!data.camera_streams && data.camera_streams["3"] || false,
  };
  // If fast endpoint doesn't have camera health, probe via /status once.
  if (!data.camera_streams) {
    const full = await callDirector('GET', '/status');
    const fd = full && full.ok ? (full.data || {}) : {};
    cams[1] = !!fd.kamrui_camera_1_stream;
    cams[2] = !!fd.kamrui_camera_2_stream;
    cams[3] = !!fd.annke_camera_3_stream;
  }
  try {
    const mode = String(req.body && req.body.production_mode || '').toLowerCase();
    if (mode === 'fixed_camera') {
      const cam = Number(req.body.camera_id);
      if (!cams[cam]) {
        return fail(res, req, {
          httpStatus: 409,
          code: 'CAMERA_UNHEALTHY',
          error: `Camera ${cam} does not have a fresh stream and cannot be selected`,
          requestId,
        });
      }
    }
    if (mode === 'ai_director') {
      const healthy = Object.values(cams).filter(Boolean).length;
      if (healthy < 2) {
        return fail(res, req, {
          httpStatus: 409,
          code: 'AI_DIRECTOR_PREREQ',
          error: 'AI Director requires at least two cameras with fresh decoded frames',
          requestId,
        });
      }
    }
    if (mode === 'manual_multicamera' && !req.body.scene_name) {
      return fail(res, req, {
        httpStatus: 409,
        code: 'MANUAL_MULTICAMERA_NULL_INITIAL_SCENE',
        error: 'Manual Multi-Camera requires an explicit approved initial scene',
        requestId,
      });
    }
    // Prepare the managed receiver BEFORE persisting the plan.
    const prepared = await prepareLiveProgram(req);
    if (!prepared.ok) {
      return fail(res, req, {
        httpStatus: prepared.status || 500,
        code: prepared.code || 'PREPARE_FAILED',
        error: prepared.error || 'Could not prepare managed receiver; plan not saved',
        requestId,
        payload: {
          program_url: redactDirectorResult(prepared.programUrl || { ok: false }),
          program_refresh: redactDirectorResult(prepared.programRefresh || { ok: false }),
        },
      });
    }
    // For fixed camera, actually set the scene and confirm before persisting.
    if (mode === 'fixed_camera') {
      const fcResult = await callDirector('POST', '/fixed-camera', {
        camera_id: Number(req.body.camera_id),
        scene_name: req.body.scene_name || cameraScene(Number(req.body.camera_id)),
      });
      if (!fcResult.ok || (fcResult.data && fcResult.data.ok === false)) {
        return fail(res, req, {
          httpStatus: 502,
          code: (fcResult.data && fcResult.data.code) || 'FIXED_CAMERA_FAILED',
          error: (fcResult.data && fcResult.data.error) || fcResult.message || 'Fixed Camera command failed; plan not saved',
          requestId,
          payload: { fixed_camera_result: redactDirectorResult(fcResult) },
        });
      }
    }
    const plan = putPlan(req.workspaceId, req.body || {}, { camera_health: cams });
    plan.prepared_at = Date.now();
    plan.expected_scene = plan.scene_name || (plan.production_mode === 'fixed_camera' ? cameraScene(plan.camera_id) : null);
    logLiveStreamAction(req, 'production-plan', {
      production_plan_id: plan.production_plan_id,
      production_mode: plan.production_mode,
      request_id: requestId,
    });
    res.json({
      success: true,
      request_id: requestId,
      production_plan: plan,
      camera_health: cams,
      director_state: redactDirectorResult(director),
    });
  } catch (e) {
    return fail(res, req, {
      httpStatus: 400,
      code: e.code || 'INVALID_PRODUCTION_PLAN',
      error: e.message || 'Invalid production plan',
      requestId,
    });
  }
});

router.get('/production-plan', (req, res) => {
  const requestId = createRequestId();
  if (!workspaceGuard(req, res, requestId)) return;
  const plan = getPlan(req.workspaceId);
  res.json({
    success: true,
    request_id: requestId,
    production_plan: plan,
  });
});

async function proxyRecording(method, path, body) {
  return callDirector(method, path, body);
}

router.get('/recording/status', async (req, res) => {
  const requestId = createRequestId();
  if (!workspaceGuard(req, res, requestId)) return;
  const result = await proxyRecording('GET', '/v1/recording/status');
  res.status(result.ok ? 200 : (result.status || 502)).json({
    success: !!result.ok,
    request_id: requestId,
    ...(result.data && typeof result.data === 'object' ? result.data : { error: result.message }),
  });
});

router.post('/recording/preflight', async (req, res) => {
  const requestId = createRequestId();
  if (!workspaceGuard(req, res, requestId)) return;
  const result = await proxyRecording('POST', '/v1/recording/preflight', req.body || {});
  res.status(result.ok ? 200 : (result.status || 502)).json({
    success: !!result.ok,
    request_id: requestId,
    ...(result.data && typeof result.data === 'object' ? result.data : { error: result.message }),
  });
});

router.post('/recording/start', async (req, res) => {
  const requestId = createRequestId();
  if (!workspaceGuard(req, res, requestId)) return;
  const roomId = config.console && config.console.roomId ? config.console.roomId : null;
  const body = {
    session_id: (req.body && req.body.session_id) || `mc-${req.workspaceId}-${Date.now()}`,
    room_id: (req.body && req.body.room_id) || roomId,
    ...(req.body || {}),
  };
  const result = await proxyRecording('POST', '/v1/recording/start', body);
  logLiveStreamAction(req, 'recording-start', { session_id: body.session_id, room_id: body.room_id, request_id: requestId });
  res.status(result.ok ? 200 : (result.status || 502)).json({
    success: !!result.ok,
    request_id: requestId,
    session_id: body.session_id,
    ...(result.data && typeof result.data === 'object' ? result.data : { error: result.message }),
  });
});

router.post('/recording/stop', async (req, res) => {
  const requestId = createRequestId();
  if (!workspaceGuard(req, res, requestId)) return;
  // Send the active session_id — either from the request body or from the
  // last known recording session for this workspace.
  const body = {
    session_id: (req.body && req.body.session_id) || null,
    ...(req.body || {}),
  };
  const result = await proxyRecording('POST', '/v1/recording/stop', body);
  logLiveStreamAction(req, 'recording-stop', { session_id: body.session_id, request_id: requestId });
  res.status(result.ok ? 200 : (result.status || 502)).json({
    success: !!result.ok,
    request_id: requestId,
    ...(result.data && typeof result.data === 'object' ? result.data : { error: result.message }),
  });
});

router.post('/start', async (req, res) => {
  const requestId = createRequestId();
  if (!workspaceGuard(req, res, requestId)) return;

  let plan;
  try {
    plan = consumePlanForStart(req.workspaceId, req.body || {});
  } catch (e) {
    // Backward-compat: legacy desks may start with only director_mode/body flags
    // and no prepare-table production plan. Map that body into a transient plan.
    // Never invent auto — director_mode must be explicit for AI.
    const body = req.body || {};
    if (body.director_mode != null || body.production_mode != null) {
      const dm = String(body.director_mode || '').toLowerCase() === 'auto' ? 'auto' : 'manual';
      // Only force fixed_camera when production_mode or camera_id is explicit.
      // Pure director_mode starts are the legacy desk API and skipscene apply.
      let productionMode;
      if (body.production_mode) {
        productionMode = String(body.production_mode).toLowerCase();
      } else if (dm === 'auto') {
        productionMode = 'ai_director';
      } else if (body.camera_id != null) {
        productionMode = 'fixed_camera';
      } else {
        productionMode = 'legacy_director_mode';
      }
      const cam = body.camera_id != null ? Number(body.camera_id) : null;
      plan = {
        production_mode: productionMode,
        director_mode: dm,
        camera_id: Number.isFinite(cam) ? cam : null,
        scene_name: body.scene_name
          || (productionMode === 'fixed_camera' ? cameraScene(cam || 1) : null),
        audio_mode: body.audio_mode || 'speech',
        recording_requested: body.recording_requested === true,
        confirm_auto_canary: body.confirm_auto_canary === true,
        production_plan_id: null,
        initiator: 'operator',
      };
    } else if (e.code === 'PRODUCTION_PLAN_REQUIRED' || e.code === 'PRODUCTION_PLAN_EXPIRED') {
      plan = {
        production_mode: 'fixed_camera',
        director_mode: 'manual',
        camera_id: 1,
        scene_name: cameraScene(1),
        audio_mode: 'speech',
        recording_requested: false,
        confirm_auto_canary: false,
        production_plan_id: null,
      };
    } else {
      return fail(res, req, {
        httpStatus: 409,
        code: e.code || 'PRODUCTION_PLAN_REQUIRED',
        error: e.message,
        requestId,
      });
    }
  }

  const directorMode = plan.director_mode === 'auto' ? 'auto' : 'manual';
  const confirmAutoCanary = plan.confirm_auto_canary === true
    || !!(req.body && req.body.confirm_auto_canary === true);

  // Background/autonomous callers must mark initiator explicitly.
  const initiator = String((req.body && req.body.initiator) || plan.initiator || 'operator').toLowerCase();
  if (initiator !== 'operator' && initiator !== 'user') {
    return fail(res, req, {
      httpStatus: 409,
      code: ERROR_CODES.AUTOMATIC_STREAM_START_DISABLED,
      error: 'Background or autonomous stream start is disabled',
      requestId,
    });
  }

  const preflightDirector = await callDirector('GET', '/status');
  const preflight = await buildStatusContract(req, preflightDirector, requestId);
  const gate = startGateFailure(preflight.capabilities, { directorMode, confirmAutoCanary });
  if (gate) {
    return fail(res, req, {
      httpStatus: gate.httpStatus,
      code: gate.code,
      error: gate.error,
      requestId,
      payload: {
        ...preflight.payload,
        program_state: preflight.programState,
        production_plan: plan,
      },
      capabilities: preflight.capabilities,
      productionState: preflight.productionState,
    });
  }

  if (directorMode === 'auto' && !confirmAutoCanary) {
    return fail(res, req, {
      httpStatus: 409,
      code: ERROR_CODES.AUTO_CANARY_CONFIRMATION_REQUIRED,
      error: 'Automatic direction requires an explicit completed-canary confirmation',
      requestId,
      capabilities: preflight.capabilities,
    });
  }

  const prepared = await prepareLiveProgram(req);
  const payload = prepared.payload || preflight.payload;
  const programState = prepared.programState || preflight.programState;
  if (!prepared.ok) {
    return fail(res, req, {
      httpStatus: prepared.status,
      code: prepared.code || ERROR_CODES.STREAM_START_REJECTED,
      error: prepared.error,
      requestId,
      payload: {
        ...payload,
        program_state: programState,
        program_url: redactDirectorResult(prepared.programUrl || { ok: false }),
        program_refresh: redactDirectorResult(prepared.programRefresh || { ok: false }),
        production_plan: plan,
      },
      capabilities: preflight.capabilities,
    });
  }

  // Apply audio mode from plan (best-effort).
  if (plan.audio_mode) {
    await callDirector('POST', `/audio-mode/${encodeURIComponent(plan.audio_mode)}`);
  }

  // Fixed camera / manual multicamera: set scene + disable autoswitch.
  // NO silent fallback — return the exact failure to the operator.
  let fixedCameraResult = null;
  let sceneSetResult = null;
  if (plan.production_mode === 'fixed_camera' && plan.camera_id) {
    fixedCameraResult = await callDirector('POST', '/fixed-camera', {
      camera_id: plan.camera_id,
      scene_name: plan.scene_name || cameraScene(plan.camera_id),
    });
    // Inspect nested result: HTTP success is NOT proof the scene changed.
    const fcOk = fixedCameraResult.ok
      && fixedCameraResult.data
      && fixedCameraResult.data.ok === true
      && fixedCameraResult.data.actual_scene === (plan.scene_name || cameraScene(plan.camera_id));
    if (!fcOk) {
      const fcData = fixedCameraResult.data || {};
      return fail(res, req, {
        httpStatus: 502,
        code: fcData.code || 'FIXED_CAMERA_FAILED',
        error: fcData.error || fixedCameraResult.message || 'Fixed Camera command failed; cannot start livestream',
        requestId,
        payload: {
          ...payload,
          production_plan: plan,
          fixed_camera_result: redactDirectorResult(fixedCameraResult),
          requested_scene: plan.scene_name || cameraScene(plan.camera_id),
          actual_scene: fcData.actual_scene || null,
          camera_healthy: fcData.camera_healthy,
        },
        productionState: getLiveProductionState(req.workspaceId),
      });
    }
    sceneSetResult = fixedCameraResult;
  } else if (plan.production_mode === 'manual_multicamera') {
    if (!plan.scene_name) {
      return fail(res, req, {
        httpStatus: 409,
        code: 'MANUAL_MULTICAMERA_NULL_INITIAL_SCENE',
        error: 'Manual Multi-Camera requires an explicit approved initial scene',
        requestId,
        payload: { production_plan: plan },
      });
    }
    sceneSetResult = await callDirector('POST', '/scene/' + encodeURIComponent(plan.scene_name));
    const scOk = sceneSetResult.ok
      && sceneSetResult.data
      && sceneSetResult.data.ok === true
      && sceneSetResult.data.actual_scene === plan.scene_name;
    if (!scOk) {
      const scData = sceneSetResult.data || {};
      return fail(res, req, {
        httpStatus: 502,
        code: scData.code || 'SCENE_SET_FAILED',
        error: scData.error || sceneSetResult.message || 'Scene command failed; cannot start livestream',
        requestId,
        payload: {
          ...payload,
          production_plan: plan,
          scene_result: redactDirectorResult(sceneSetResult),
          requested_scene: plan.scene_name,
          actual_scene: scData.actual_scene || null,
        },
        productionState: getLiveProductionState(req.workspaceId),
      });
    }
  }

  // Recording before stream when requested.
  let recordingStart = null;
  let recordingSessionId = null;
  if (plan.recording_requested) {
    recordingSessionId = `mc-${req.workspaceId}-${Date.now()}`;
    const roomId = config.console && config.console.roomId ? config.console.roomId : null;
    const pre = await callDirector('POST', '/v1/recording/preflight', {
      session_id: recordingSessionId,
      room_id: roomId,
    });
    if (!pre.ok || (pre.data && pre.data.ok === false)) {
      return fail(res, req, {
        httpStatus: 409,
        code: 'RECORDING_PREFLIGHT_FAILED',
        error: (pre.data && (pre.data.message || pre.data.error)) || pre.message || 'Recording preflight failed; livestream not started',
        requestId,
        payload: { production_plan: plan, recording_preflight: redactDirectorResult(pre) },
      });
    }
    recordingStart = await callDirector('POST', '/v1/recording/start', {
      session_id: recordingSessionId,
      room_id: roomId,
    });
    if (!recordingStart.ok || (recordingStart.data && recordingStart.data.ok === false)) {
      return fail(res, req, {
        httpStatus: 502,
        code: 'RECORDING_START_FAILED',
        error: (recordingStart.data && (recordingStart.data.message || recordingStart.data.error))
          || recordingStart.message || 'Recording could not start; livestream not started',
        requestId,
        payload: { production_plan: plan, recording_start: redactDirectorResult(recordingStart) },
      });
    }
  }

  // For AI mode, call /mode/auto to enable autoswitch.
  // For fixed/manual with scene apply, the scene is already set by /fixed-camera or /scene.
  // For legacy_director_mode desks, explicitly enter manual without inventing a scene cut.
  let mode = null;
  if (directorMode === 'auto') {
    mode = await callDirector('POST', '/mode/auto');
  } else if (sceneSetResult) {
    mode = sceneSetResult;
  } else {
    mode = await callDirector('POST', `/mode/${directorMode}`);
  }
  if (!mode.ok) {
    if (recordingSessionId) await callDirector('POST', '/v1/recording/stop', { session_id: recordingSessionId });
    const classified = classifyDirectorFailure(mode, ERROR_CODES.STREAM_START_REJECTED);
    return fail(res, req, {
      httpStatus: 502,
      code: classified.code,
      error: classified.error || `AI Director could not enter ${directorMode} mode`,
      requestId,
      payload: { ...payload, mode: redactDirectorResult(mode), program_state: programState, production_plan: plan },
    });
  }

  // Plan-aware safety gate: poll the fast /director/state endpoint.
  const safetyCheck = (data) => {
    const result = planAwareSafetyGate(data, plan, programState.content_active);
    return result.safe;
  };
  const statusAfterMode = await waitForDirector(safetyCheck);
  const preparedProductionState = observeDirectorResult(req, statusAfterMode, 'stream:prepared');
  const safetyResult = statusAfterMode && statusAfterMode.ok
    ? planAwareSafetyGate(statusAfterMode.data, plan, programState.content_active)
    : { safe: false, failed_predicates: ['director_state_unavailable'] };
  if (!safetyResult.safe) {
    if (recordingSessionId) await callDirector('POST', '/v1/recording/stop', { session_id: recordingSessionId });
    return fail(res, req, {
      httpStatus: 503,
      code: ERROR_CODES.PROGRAM_SCENE_UNSAFE,
      error: `OBS program scene is not safe to stream: ${safetyResult.failed_predicates.join(', ')}`,
      requestId,
      payload: {
        ...payload,
        program_state: programState,
        production_plan: plan,
        safety_check: safetyResult,
        director_state: redactDirectorResult(statusAfterMode || { ok: false }),
      },
      productionState: preparedProductionState,
    });
  }

  const stream = await callDirector('POST', '/stream/start');
  const streamRejected = !stream.ok
    || (stream.data && typeof stream.data === 'object' && stream.data.ok === false);
  if (streamRejected) {
    if (recordingSessionId) await callDirector('POST', '/v1/recording/stop', { session_id: recordingSessionId });
    const classified = classifyDirectorFailure(stream, ERROR_CODES.STREAM_START_REJECTED);
    return fail(res, req, {
      httpStatus: 502,
      code: classified.code,
      error: classified.error || 'OBS could not start the live stream',
      requestId,
      payload: {
        ...payload,
        program_state: programState,
        selected_scene: redactDirectorResult(statusAfterMode),
        stream_start: redactDirectorResult(stream),
        production_plan: plan,
      },
      productionState: preparedProductionState,
    });
  }

  const status = await waitForDirector(data => data.stream_active === true, 8000);
  const productionState = observeDirectorResult(req, status, 'stream:start-verified');
  const streamVerified = !!(status && status.ok && status.data && status.data.stream_active === true);
    if (!streamVerified) {
    await callDirector('POST', '/stream/stop');
    if (recordingSessionId) await callDirector('POST', '/v1/recording/stop', { session_id: recordingSessionId });
    return fail(res, req, {
      httpStatus: 502,
      code: ERROR_CODES.STREAM_START_NOT_CONFIRMED,
      error: 'OBS did not confirm that the live stream became active',
      requestId,
      payload: {
        ...payload,
        program_state: programState,
        selected_scene: redactDirectorResult(statusAfterMode),
        stream_start: redactDirectorResult(stream),
        ai_director_status: redactDirectorResult(status || { ok: false }),
        production_plan: plan,
      },
      productionState,
    });
  }

  clearLiveStreamLastError(req.workspaceId);
  logLiveStreamAction(req, 'start', {
    mode: directorMode,
    production_mode: plan.production_mode,
    production_plan_id: plan.production_plan_id,
    selected_scene: statusAfterMode.data && statusAfterMode.data.current_scene || null,
    stream_started: true,
    recording_requested: !!plan.recording_requested,
    request_id: requestId,
  });

  const successCapabilities = buildLivestreamCapabilities({
    workspaceId: req.workspaceId,
    display: payload.display,
    programState,
    directorResult: status,
    productionState,
    peerTubeWatchUrl: config.liveStream.peerTubeWatchUrl,
    requestId,
  });

  res.json({
    ...payload,
    success: true,
    request_id: requestId,
    production_plan: plan,
    recording_start: recordingStart ? redactDirectorResult(recordingStart) : null,
    program_state: programState,
    program_url: redactDirectorResult(prepared.programUrl),
    program_refresh: redactDirectorResult(prepared.programRefresh),
    mode: redactDirectorResult(mode),
    selected_scene: redactDirectorResult(statusAfterMode),
    stream_start: redactDirectorResult(stream),
    stream_started: true,
    ai_director_status: redactDirectorResult(status),
    production_state: productionState,
    capabilities: successCapabilities,
    peertube_watch_url: config.liveStream.peerTubeWatchUrl || null,
  });
});

router.post('/stop', async (req, res) => {
  const requestId = createRequestId();
  if (!workspaceGuard(req, res, requestId)) return;
  const payload = displayPayload(req);
  const stream = await callDirector('POST', '/stream/stop');

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

  const stopped = stream.ok && verifiedActive === false;
  if (!stopped) {
    const classified = !stream.ok
      ? classifyDirectorFailure(stream, ERROR_CODES.STREAM_STOP_NOT_CONFIRMED)
      : {
        code: ERROR_CODES.STREAM_STOP_NOT_CONFIRMED,
        error: 'OBS did not confirm that the live stream stopped',
      };
    return fail(res, req, {
      httpStatus: 502,
      code: classified.code,
      error: classified.error,
      requestId,
      payload: {
        ...payload,
        stream_stop: redactDirectorResult(stream),
        classroom_composition_preserved: true,
        stream_active_after: verifiedActive,
        second_stop: secondStop ? redactDirectorResult(secondStop) : null,
      },
      productionState,
    });
  }

  clearLiveStreamLastError(req.workspaceId);
  logLiveStreamAction(req, 'stop', {
    stream_message: stream.data && stream.data.message || stream.message || null,
    classroom_composition_preserved: true,
    stream_active_after: verifiedActive,
    second_stop_sent: !!secondStop,
    request_id: requestId,
  });
  res.json({
    ...payload,
    success: true,
    request_id: requestId,
    stream_stop: redactDirectorResult(stream),
    classroom_composition_preserved: true,
    stream_active_after: verifiedActive,
    second_stop: secondStop ? redactDirectorResult(secondStop) : null,
    production_state: productionState,
  });
});

router.post('/clear-content', async (req, res) => {
  const requestId = createRequestId();
  if (!workspaceGuard(req, res, requestId)) return;
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
    return fail(res, req, {
      httpStatus: 500,
      code: ERROR_CODES.STREAM_START_REJECTED,
      error: e.message || 'Failed to clear live content',
      requestId,
    });
  }
  markLiveContentChanged(display.id);
  const refresh = await callDirector('POST', '/media-control/refresh');
  logLiveStreamAction(req, 'clear-content', { cleared, request_id: requestId });
  res.json({
    success: true,
    request_id: requestId,
    cleared,
    refresh: redactDirectorResult(refresh),
    program_state: liveStreamProgramState(req.workspaceId),
  });
});

router.post('/refresh', async (req, res) => {
  const requestId = createRequestId();
  if (!workspaceGuard(req, res, requestId)) return;
  const refresh = await callDirector('POST', '/media-control/refresh');
  res.json({
    success: !!refresh.ok,
    request_id: requestId,
    refresh: redactDirectorResult(refresh),
  });
});

module.exports = router;
