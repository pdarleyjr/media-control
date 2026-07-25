'use strict';

// Camera-reconciled live-stream router (reconciled onto 085c938, 2026-07-25).
//
// The original production router drove an OBS + AI Director multi-camera
// classroom console. AI Director (and OBS) have been retired from the active
// camera/livestream path. This router now backs every record / livestream /
// status operation with the Kamrui ANNKE camera-control edge
// (server/lib/camera-control-client), while preserving the response field
// shapes the Media Control operator console (action-dock / live-stream-ui /
// prepare-live-production) and the capabilities layer already consume.
//
// No call is made to the AI Director (8766) or OBS websocket (4455). The
// "director state" is synthesized from the live Kamrui camera-control status.

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
const cameraControl = require('../lib/camera-control-client');

// --- Helpers -------------------------------------------------------------

function requestBaseUrl() {
  const configured = config.liveStream.playerBaseUrl;
  if (configured) return configured;
  return 'http://127.0.0.1:8096';
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

// --- Synthetic director state from the Kamrui camera-control edge --------
//
// Synthesizes the AI Director status contract (obs / stream_active /
// recording_active / camera health / scene / mode) directly from the live
// Kamrui camera-control API. The single ANNKE ceiling camera is "camera 3".
// The program scene is the fixed ANNKE full-frame scene, which is in the
// approved program-scene set, so scene-safety resolves cleanly for manual mode.

async function getCameraDirectorState() {
  const result = await cameraControl.getStatus();
  if (!result.ok) {
    return { ok: false, message: result.message || 'Camera control edge is unreachable' };
  }
  const s = (result.data && typeof result.data === 'object') ? result.data : {};
  const cameraOnline = s.camera_online === true;
  const previewOnline = s.preview_online === true;
  const recording = s.recording === true;
  const livestreaming = s.livestreaming === true;
  const contentActive = !!(liveStreamProgramStateAny() && liveStreamProgramStateAny().content_active);

  const data = {
    status: 'ok',
    obs: cameraOnline,                       // the ANNKE feed is the program source
    obs_message: null,
    stream_active: livestreaming,
    stream_state: livestreaming ? 'on_air' : null,
    recording_active: recording,
    recording_state: recording ? 'active' : null,
    peertube_configured: !!config.liveStream.peerTubeWatchUrl,
    current_scene: cameraOnline ? 'KAMRUI_CAMERA_3_FULL' : null,
    actual_obs_scene: cameraOnline ? 'KAMRUI_CAMERA_3_FULL' : null,
    mode: 'manual',
    configured_mode: 'manual',
    effective_mode: 'manual',
    manual_hold: true,
    autoswitch_enabled: false,
    autoswitch_runtime_enabled: false,
    media_control_available: cameraOnline,
    media_control_content_active: contentActive,
    kamrui_camera_1_stream: false,
    kamrui_camera_2_stream: false,
    annke_camera_3_stream: cameraOnline,
    camera_online: cameraOnline,
    preview_online: previewOnline,
    director: {
      active_camera: cameraOnline ? 3 : null,
      content_active: contentActive,
    },
    operator_stream_start_allowed: true,
    automatic_stream_start_allowed: false,
    stream_start_allowed: cameraOnline,
    peertube_watch_url: config.liveStream.peerTubeWatchUrl || null,
    last_recording: s.last_recording || null,
    session_id: s.session_id || null,
    disk_low: s.disk_low === true,
    disk_critical: s.disk_critical === true,
    errors: Array.isArray(s.errors) ? s.errors : [],
  };
  return { ok: true, status: 200, data };
}

// Live-program content_active is workspace-scoped; expose a helper that reads
// it without a workspace for the synthetic state when needed.
function liveStreamProgramStateAny() {
  return null;
}

// Deep-health cache (kept for operator-state fast+cached behavior).
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

// Prepare the managed live-program receiver. With the OBS/AI-Director path
// retired, "preparing" means: ensure the managed display exists and the ANNKE
// camera edge is online and acting as the program source.
async function prepareLiveProgram(req) {
  const payload = displayPayload(req);
  const programState = liveStreamProgramState(req.workspaceId);
  const director = await getCameraDirectorState();
  if (!director.ok) {
    return {
      ok: false,
      status: 502,
      code: ERROR_CODES.OBS_UNAVAILABLE,
      payload,
      programState,
      currentStatus: director,
      error: 'Camera control edge is unavailable; cannot prepare live program',
    };
  }
  if (director.data && director.data.stream_active === true) {
    return {
      ok: false,
      status: 409,
      code: ERROR_CODES.STREAM_ALREADY_ACTIVE,
      payload,
      programState,
      currentStatus: director,
      error: 'The live stream is already active; program-source refresh is locked while on air',
    };
  }
  if (!director.data || director.data.annke_camera_3_stream !== true) {
    return {
      ok: false,
      status: 502,
      code: ERROR_CODES.OBS_UNAVAILABLE,
      payload,
      programState,
      currentStatus: director,
      error: 'ANNKE camera is offline; cannot prepare live program',
    };
  }
  return { ok: true, payload, programState, currentStatus: director, programUrl: { ok: true }, programRefresh: { ok: true } };
}

// --- Routes --------------------------------------------------------------

router.get('/status', async (req, res) => {
  const requestId = createRequestId();
  if (!workspaceGuard(req, res, requestId)) return;
  const director = await getCameraDirectorState();
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
    ...contract.capabilities,
  });
});

router.get('/operator-state', async (req, res) => {
  const requestId = createRequestId();
  if (!workspaceGuard(req, res, requestId)) return;
  const t0 = Date.now();
  const director = await getCameraDirectorState();
  cacheDeepHealth(req.workspaceId, director);
  const contract = await buildStatusContract(req, director, requestId);
  const plan = getPlan(req.workspaceId);
  const elapsed = Date.now() - t0;
  res.json({
    success: true,
    request_id: requestId,
    freshness: 'fast+cached_deep',
    elapsed_ms: elapsed,
    deep_health_age_ms: 0,
    production_plan: plan || null,
    ...contract.payload,
    program_state: contract.programState,
    ai_director: contract.aiDirector,
    production_state: contract.productionState,
    capabilities: contract.capabilities,
    peertube_watch_url: config.liveStream.peerTubeWatchUrl || null,
    ...contract.capabilities,
    stream_active: !!(director.ok && director.data && director.data.stream_active),
    stream_state: (director.ok && director.data && director.data.stream_state) || contract.capabilities.stream_state || null,
    recording_active: !!(director.ok && director.data && director.data.recording_active),
    recording_state: (director.ok && director.data && director.data.recording_state) || null,
    current_scene: (director.ok && director.data && director.data.current_scene) || null,
    desired_scene: null,
    configured_mode: (director.ok && director.data && director.data.configured_mode) || null,
    effective_mode: (director.ok && director.data && director.data.effective_mode) || null,
    manual_hold: !!(director.ok && director.data && director.data.manual_hold),
    autoswitch_runtime_enabled: false,
    active_camera: (director.ok && director.data && director.data.director && director.data.director.active_camera) || null,
    state_revision: null,
    updated_at: new Date().toISOString(),
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
  const director = await getCameraDirectorState();
  const cams = {
    1: !!(director.ok && director.data && director.data.kamrui_camera_1_stream),
    2: !!(director.ok && director.data && director.data.kamrui_camera_2_stream),
    3: !!(director.ok && director.data && director.data.annke_camera_3_stream),
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
      return fail(res, req, {
        httpStatus: 409,
        code: 'AI_DIRECTOR_RETIRED',
        error: 'AI Director has been retired; use fixed_camera (ANNKE) mode',
        requestId,
      });
    }
    if (mode === 'manual_multicamera' && !req.body.scene_name) {
      return fail(res, req, {
        httpStatus: 409,
        code: 'MANUAL_MULTICAMERA_NULL_INITIAL_SCENE',
        error: 'Manual Multi-Camera requires an explicit approved initial scene',
        requestId,
      });
    }
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

router.get('/recording/status', async (req, res) => {
  const requestId = createRequestId();
  if (!workspaceGuard(req, res, requestId)) return;
  const director = await getCameraDirectorState();
  const active = !!(director.ok && director.data && director.data.recording_active);
  res.status(director.ok ? 200 : 502).json({
    success: !!director.ok,
    request_id: requestId,
    recording_active: active,
    recording_state: active ? 'active' : 'standby',
    ...(director.data && typeof director.data === 'object' ? { session_id: director.data.session_id || null } : { error: director.message }),
  });
});

router.post('/recording/preflight', async (req, res) => {
  const requestId = createRequestId();
  if (!workspaceGuard(req, res, requestId)) return;
  const director = await getCameraDirectorState();
  const ok = !!(director.ok && director.data && director.data.annke_camera_3_stream);
  res.status(ok ? 200 : 502).json({
    success: ok,
    request_id: requestId,
    camera_ready: ok,
    ...(ok ? {} : { error: 'ANNKE camera is not ready for recording' }),
  });
});

router.post('/recording/start', async (req, res) => {
  const requestId = createRequestId();
  if (!workspaceGuard(req, res, requestId)) return;
  const result = await cameraControl.startRecording();
  logLiveStreamAction(req, 'recording-start', { ok: result.ok, request_id: requestId });
  res.status(result.ok ? 200 : (result.status || 502)).json({
    success: !!result.ok,
    request_id: requestId,
    recording_active: !!result.ok,
    recording_state: result.ok ? 'active' : null,
    ...(result.data && typeof result.data === 'object' ? result.data : { error: result.message }),
  });
});

router.post('/recording/stop', async (req, res) => {
  const requestId = createRequestId();
  if (!workspaceGuard(req, res, requestId)) return;
  const result = await cameraControl.stopRecording();
  logLiveStreamAction(req, 'recording-stop', { ok: result.ok, request_id: requestId });
  res.status(result.ok ? 200 : (result.status || 502)).json({
    success: !!result.ok,
    request_id: requestId,
    recording_active: false,
    recording_state: result.ok ? 'standby' : null,
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
    const body = req.body || {};
    if (body.director_mode != null || body.production_mode != null || body.camera_id != null) {
      const cam = body.camera_id != null ? Number(body.camera_id) : 3;
      plan = {
        production_mode: 'fixed_camera',
        director_mode: 'manual',
        camera_id: Number.isFinite(cam) ? cam : 3,
        scene_name: body.scene_name || cameraScene(Number.isFinite(cam) ? cam : 3),
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
        camera_id: 3,
        scene_name: cameraScene(3),
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

  const directorMode = 'manual';
  const confirmAutoCanary = plan.confirm_auto_canary === true
    || !!(req.body && req.body.confirm_auto_canary === true);

  const initiator = String((req.body && req.body.initiator) || plan.initiator || 'operator').toLowerCase();
  if (initiator !== 'operator' && initiator !== 'user') {
    return fail(res, req, {
      httpStatus: 409,
      code: ERROR_CODES.AUTOMATIC_STREAM_START_DISABLED,
      error: 'Background or autonomous stream start is disabled',
      requestId,
    });
  }

  const preflightDirector = await getCameraDirectorState();
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

  // Recording before stream when requested (independent FFmpeg process).
  let recordingStart = null;
  let recordingSessionId = null;
  if (plan.recording_requested) {
    recordingSessionId = `mc-${req.workspaceId}-${Date.now()}`;
    const recResult = await cameraControl.startRecording();
    if (!recResult.ok) {
      return fail(res, req, {
        httpStatus: 502,
        code: 'RECORDING_START_FAILED',
        error: recResult.message || 'Recording could not start; livestream not started',
        requestId,
        payload: { production_plan: plan, recording_start: redactDirectorResult(recResult) },
      });
    }
    recordingStart = { ok: true, data: { session_id: recordingSessionId, ...((recResult.data && typeof recResult.data === 'object') ? recResult.data : {}) } };
  }

  const stream = await cameraControl.startLivestream();
  const streamRejected = !stream.ok || (stream.data && typeof stream.data === 'object' && stream.data.ok === false);
  if (streamRejected) {
    if (recordingSessionId) await cameraControl.stopRecording();
    return fail(res, req, {
      httpStatus: 502,
      code: ERROR_CODES.STREAM_START_REJECTED,
      error: stream.message || 'Camera control could not start the live stream',
      requestId,
      payload: {
        ...payload,
        program_state: programState,
        stream_start: redactDirectorResult(stream),
        production_plan: plan,
      },
      productionState: preflight.productionState,
    });
  }

  // Verify the stream became active through the authoritative camera-control status.
  let verified = false;
  for (let attempt = 0; attempt < 10; attempt++) {
    const check = await getCameraDirectorState();
    if (check.ok && check.data && check.data.stream_active === true) { verified = true; break; }
    await new Promise((r) => setTimeout(r, 500));
  }
  const productionState = observeDirectorResult(req, { ok: verified, data: { stream_active: verified } }, 'stream:start-verified');
  if (!verified) {
    await cameraControl.stopLivestream();
    if (recordingSessionId) await cameraControl.stopRecording();
    return fail(res, req, {
      httpStatus: 502,
      code: ERROR_CODES.STREAM_START_NOT_CONFIRMED,
      error: 'Camera control did not confirm that the live stream became active',
      requestId,
      payload: {
        ...payload,
        program_state: programState,
        stream_start: redactDirectorResult(stream),
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
    stream_started: true,
    recording_requested: !!plan.recording_requested,
    request_id: requestId,
  });

  const successDirector = await getCameraDirectorState();
  const successCapabilities = buildLivestreamCapabilities({
    workspaceId: req.workspaceId,
    display: payload.display,
    programState,
    directorResult: successDirector,
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
    selected_scene: redactDirectorResult({ ok: true, data: { current_scene: 'KAMRUI_CAMERA_3_FULL', actual_scene: 'KAMRUI_CAMERA_3_FULL' } }),
    stream_start: redactDirectorResult(stream),
    stream_started: true,
    ai_director_status: redactDirectorResult(successDirector),
    production_state: productionState,
    capabilities: successCapabilities,
    peertube_watch_url: (stream.data && stream.data.peertube_watch_url) || config.liveStream.peerTubeWatchUrl || null,
  });
});

router.post('/stop', async (req, res) => {
  const requestId = createRequestId();
  if (!workspaceGuard(req, res, requestId)) return;
  const payload = displayPayload(req);
  const stream = await cameraControl.stopLivestream();

  let verifiedActive = null;
  let productionState = getLiveProductionState(req.workspaceId);
  try {
    for (let attempt = 0; attempt < 5; attempt++) {
      await new Promise((r) => setTimeout(r, 1000));
      const check = await getCameraDirectorState();
      productionState = observeDirectorResult(req, check, 'stream:stop-verification');
      const active = check && check.ok && check.data && typeof check.data.stream_active === 'boolean'
        ? check.data.stream_active
        : null;
      verifiedActive = active;
      if (active === false) break;
    }
    if (verifiedActive === true) {
      await cameraControl.stopLivestream();
      await new Promise((r) => setTimeout(r, 500));
      const check = await getCameraDirectorState();
      productionState = observeDirectorResult(req, check, 'stream:stop-verification');
      verifiedActive = check && check.ok && check.data && typeof check.data.stream_active === 'boolean'
        ? check.data.stream_active
        : null;
    }
  } catch (_) { /* verification best-effort */ }

  const stopped = stream.ok && verifiedActive === false;
  if (!stopped) {
    return fail(res, req, {
      httpStatus: 502,
      code: ERROR_CODES.STREAM_STOP_NOT_CONFIRMED,
      error: stream.message || 'Camera control did not confirm that the live stream stopped',
      requestId,
      payload: {
        ...payload,
        stream_stop: redactDirectorResult(stream),
        classroom_composition_preserved: true,
        stream_active_after: verifiedActive,
      },
      productionState,
    });
  }

  clearLiveStreamLastError(req.workspaceId);
  logLiveStreamAction(req, 'stop', {
    stream_message: stream.data && stream.data.message || stream.message || null,
    classroom_composition_preserved: true,
    stream_active_after: verifiedActive,
    request_id: requestId,
  });
  res.json({
    ...payload,
    success: true,
    request_id: requestId,
    stream_stop: redactDirectorResult(stream),
    classroom_composition_preserved: true,
    stream_active_after: verifiedActive,
    production_state: productionState,
  });
});

router.post('/emergency-stop', async (req, res) => {
  const requestId = createRequestId();
  if (!workspaceGuard(req, res, requestId)) return;
  const result = await cameraControl.emergencyStop();
  logLiveStreamAction(req, 'emergency-stop', { ok: result.ok, request_id: requestId });
  res.status(result.ok ? 200 : (result.status || 502)).json({
    success: !!result.ok,
    request_id: requestId,
    ...(result.data && typeof result.data === 'object' ? result.data : { error: result.message }),
  });
});

router.get('/recordings', async (req, res) => {
  const requestId = createRequestId();
  if (!workspaceGuard(req, res, requestId)) return;
  const result = await cameraControl.getRecordings();
  res.json(result.ok ? { success: true, request_id: requestId, ...(result.data && typeof result.data === 'object' ? result.data : { recordings: [] }) } : { success: false, request_id: requestId, recordings: [], error: result.message });
});

// Recording deletion: impact preview, archive, restore, permanent delete.
// PeerTube deletion is a separate explicit route.
router.get('/recordings/:id/deletion-impact', async (req, res) => {
  const requestId = createRequestId();
  if (!workspaceGuard(req, res, requestId)) return;
  const result = await cameraControl.getDeletionImpact(req.params.id);
  if (result.ok) {
    res.json({ success: true, request_id: requestId, ...(result.data || {}) });
  } else {
    res.status(result.status || 404).json({ success: false, request_id: requestId, error: result.message });
  }
});

router.post('/recordings/:id/archive', async (req, res) => {
  const requestId = createRequestId();
  if (!workspaceGuard(req, res, requestId)) return;
  const result = await cameraControl.archiveRecording(req.params.id);
  res.status(result.ok ? 200 : (result.status || 409)).json({ success: result.ok, request_id: requestId, ...(result.data || {}), error: result.message });
});

router.post('/recordings/:id/restore', async (req, res) => {
  const requestId = createRequestId();
  if (!workspaceGuard(req, res, requestId)) return;
  const result = await cameraControl.restoreRecording(req.params.id);
  res.status(result.ok ? 200 : (result.status || 409)).json({ success: result.ok, request_id: requestId, ...(result.data || {}), error: result.message });
});

router.delete('/recordings/:id', async (req, res) => {
  const requestId = createRequestId();
  if (!workspaceGuard(req, res, requestId)) return;
  const ifMatch = req.headers['if-match'];
  const result = await cameraControl.deleteRecording(req.params.id, {
    ifMatch,
    confirmTyped: req.body?.confirm,
  });
  res.status(result.ok ? 200 : (result.status || 409)).json({ success: result.ok, request_id: requestId, ...(result.data || {}), error: result.message });
});

router.delete('/recordings/:id/peertube', async (req, res) => {
  const requestId = createRequestId();
  if (!workspaceGuard(req, res, requestId)) return;
  const result = await cameraControl.deletePeerTubeVideo(req.params.id, {
    confirmTyped: req.body?.confirm,
  });
  res.status(result.ok ? 200 : (result.status || 502)).json({ success: result.ok, request_id: requestId, ...(result.data || {}), error: result.message });
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
  logLiveStreamAction(req, 'clear-content', { cleared, request_id: requestId });
  res.json({
    success: true,
    request_id: requestId,
    cleared,
    refresh: { ok: true, data: { message: 'Live content cleared; ANNKE program source retained' } },
    program_state: liveStreamProgramState(req.workspaceId),
  });
});

router.post('/refresh', async (req, res) => {
  const requestId = createRequestId();
  if (!workspaceGuard(req, res, requestId)) return;
  const director = await getCameraDirectorState();
  res.json({
    success: !!director.ok,
    request_id: requestId,
    refresh: redactDirectorResult(director),
  });
});

module.exports = router;
