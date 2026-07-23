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
const { sceneIsSafeToStream } = require('../lib/live-stream-safety');
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
  const deadline = Date.now() + timeoutMs;
  let latest = null;
  while (Date.now() < deadline) {
    latest = await callDirector('GET', '/status');
    if (latest.ok && predicate(latest.data || {})) return latest;
    await sleep(750);
  }
  return latest;
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
  const contract = await buildStatusContract(req, director, requestId);
  res.json({
    success: true,
    request_id: requestId,
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
  const director = await callDirector('GET', '/status');
  const data = director && director.ok ? (director.data || {}) : {};
  const cams = {
    1: !!data.kamrui_camera_1_stream,
    2: !!data.kamrui_camera_2_stream,
    3: !!data.annke_camera_3_stream,
  };
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
    const plan = putPlan(req.workspaceId, req.body || {}, { camera_health: cams });
    await prepareLiveProgram(req);
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
      director_status: redactDirectorResult(director),
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
  const body = {
    session_id: (req.body && req.body.session_id) || `mc-${req.workspaceId}-${Date.now()}`,
    ...(req.body || {}),
  };
  const result = await proxyRecording('POST', '/v1/recording/start', body);
  logLiveStreamAction(req, 'recording-start', { session_id: body.session_id, request_id: requestId });
  res.status(result.ok ? 200 : (result.status || 502)).json({
    success: !!result.ok,
    request_id: requestId,
    ...(result.data && typeof result.data === 'object' ? result.data : { error: result.message }),
  });
});

router.post('/recording/stop', async (req, res) => {
  const requestId = createRequestId();
  if (!workspaceGuard(req, res, requestId)) return;
  const result = await proxyRecording('POST', '/v1/recording/stop', req.body || {});
  logLiveStreamAction(req, 'recording-stop', { request_id: requestId });
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
    // Backward-compat: allow explicit director_mode body without a plan when
    // production_plan_id was never used (legacy desks), but never invent auto.
    if ((req.body && req.body.director_mode) || (req.body && req.body.production_mode)) {
      return fail(res, req, {
        httpStatus: 409,
        code: e.code || 'PRODUCTION_PLAN_REQUIRED',
        error: e.message,
        requestId,
      });
    }
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
  let fixedCameraResult = null;
  if (plan.production_mode === 'fixed_camera' && plan.camera_id) {
    fixedCameraResult = await callDirector('POST', '/fixed-camera', {
      camera_id: plan.camera_id,
      scene_name: plan.scene_name || cameraScene(plan.camera_id),
    });
    if (!fixedCameraResult.ok) {
      // Fall back to mode/manual + scene
      await callDirector('POST', '/mode/manual');
      if (plan.scene_name) await callDirector('POST', `/scene/${encodeURIComponent(plan.scene_name)}`);
    }
  } else if (plan.production_mode === 'manual_multicamera') {
    await callDirector('POST', '/mode/manual');
    if (plan.scene_name) await callDirector('POST', `/scene/${encodeURIComponent(plan.scene_name)}`);
  }

  // Recording before stream when requested.
  let recordingStart = null;
  if (plan.recording_requested) {
    const sessionId = `mc-${req.workspaceId}-${Date.now()}`;
    const pre = await callDirector('POST', '/v1/recording/preflight', { session_id: sessionId });
    if (!pre.ok || (pre.data && pre.data.ok === false)) {
      return fail(res, req, {
        httpStatus: 409,
        code: 'RECORDING_PREFLIGHT_FAILED',
        error: (pre.data && (pre.data.message || pre.data.error)) || pre.message || 'Recording preflight failed; livestream not started',
        requestId,
        payload: { production_plan: plan, recording_preflight: redactDirectorResult(pre) },
      });
    }
    recordingStart = await callDirector('POST', '/v1/recording/start', { session_id: sessionId });
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

  const mode = directorMode === 'auto'
    ? await callDirector('POST', '/mode/auto')
    : (fixedCameraResult && fixedCameraResult.ok
      ? fixedCameraResult
      : await callDirector('POST', `/mode/${directorMode}`));
  if (!mode.ok) {
    if (plan.recording_requested) await callDirector('POST', '/v1/recording/stop', {});
    const classified = classifyDirectorFailure(mode, ERROR_CODES.STREAM_START_REJECTED);
    return fail(res, req, {
      httpStatus: 502,
      code: classified.code,
      error: classified.error || `AI Director could not enter ${directorMode} mode`,
      requestId,
      payload: { ...payload, mode: redactDirectorResult(mode), program_state: programState },
    });
  }

  const statusAfterMode = await waitForDirector(
    data => sceneIsSafeToStream(data, directorMode, programState.content_active),
  );
  const preparedProductionState = observeDirectorResult(req, statusAfterMode, 'stream:prepared');
  if (!statusAfterMode || !statusAfterMode.ok
      || !sceneIsSafeToStream(statusAfterMode.data, directorMode, programState.content_active)) {
    return fail(res, req, {
      httpStatus: 503,
      code: ERROR_CODES.PROGRAM_SCENE_UNSAFE,
      error: 'OBS program scene is not safe to stream; select an approved program scene and retry',
      requestId,
      payload: {
        ...payload,
        program_state: programState,
        selected_scene: redactDirectorResult(statusAfterMode || { ok: false }),
      },
      productionState: preparedProductionState,
    });
  }

  const stream = await callDirector('POST', '/stream/start');
  const streamRejected = !stream.ok
    || (stream.data && typeof stream.data === 'object' && stream.data.ok === false);
  if (streamRejected) {
    if (plan.recording_requested) await callDirector('POST', '/v1/recording/stop', {});
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
    if (plan.recording_requested) await callDirector('POST', '/v1/recording/stop', {});
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
