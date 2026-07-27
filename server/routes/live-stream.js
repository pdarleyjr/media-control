'use strict';

// Deterministic livestream orchestration. AI Director remains retired.
// Runtime mode is selected only at process start:
//   direct_camera     ANNKE edge publishes directly to PeerTube (rollback mode)
//   fixed_compositor  OBS owns the single publisher and the three fixed scenes
// The two publishers are never started together.

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
const {
  ERROR_CODES,
  buildLivestreamCapabilities,
  createRequestId,
  errorEnvelope,
  redactDirectorResult,
} = require('../lib/live-stream-capabilities');
const {
  putPlan,
  getPlan,
  cameraScene,
} = require('../lib/production-plan');
const {
  AUDIO_POLICIES,
  FIXED_SCENES,
  LAYOUTS,
  PUBLISHER_MODES,
  getFixedCompositorController,
} = require('../lib/fixed-compositor-controller');
const { contentUseDecision, contextFromRequest } = require('../lib/content-visibility');
const { deckPlayerUrl } = require('../lib/deck-player-url');
const { assertRemoteUrlSafe } = require('../lib/ssrf-policy');
const { createPeerTubeIngestVerifier } = require('../lib/peertube-ingest-health');
const {
  isPlatformAdminUser,
  requirePlatformAdmin,
} = require('../lib/permissions');
const { markLegacyLiveCompatibility } = require('../lib/live-stream-compatibility');
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

function logLiveStreamAction(req, action, details, method = 'POST') {
  try {
    const detailsText = details == null ? null : (typeof details === 'string' ? details : JSON.stringify(details));
    logActivity(req.user.id, `${method} /api/live-stream/${action}`, detailsText, null, getClientIp(req), req.workspaceId);
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

// Compatibility envelope for rolling clients. `publisher`, `compositor`, and
// `program` below are authoritative; `ai_director` remains only a response alias.
async function getCameraDirectorState(workspaceId) {
  const result = await cameraControl.getStatus();
  if (!result.ok) {
    return { ok: false, message: result.message || 'Camera control edge is unreachable' };
  }
  const s = (result.data && typeof result.data === 'object') ? result.data : {};
  const cameraOnline = s.camera_online === true;
  const previewOnline = s.preview_online === true;
  const recording = s.recording === true;
  const programState = liveStreamProgramState(workspaceId);
  const contentActive = programState.content_active === true;
  const publisherMode = config.liveStream.publisherMode;
  let compositorHealth = null;
  let compositorState = null;
  let livestreaming = s.livestreaming === true;
  if (publisherMode === PUBLISHER_MODES.FIXED_COMPOSITOR) {
    const controller = getFixedCompositorController();
    const health = await controller.health(workspaceId);
    compositorHealth = health.obs;
    compositorState = health.composition;
    livestreaming = health.obs?.stream?.active === true;
  }

  const data = {
    status: 'ok',
    obs: publisherMode === PUBLISHER_MODES.FIXED_COMPOSITOR
      ? compositorHealth?.available === true
      : cameraOnline,
    obs_message: compositorHealth?.available === false
      ? compositorHealth.message
      : null,
    stream_active: livestreaming,
    stream_state: livestreaming ? 'on_air' : null,
    recording_active: recording,
    recording_state: recording ? 'active' : null,
    peertube_configured: !!config.liveStream.peerTubeWatchUrl,
    current_scene: publisherMode === PUBLISHER_MODES.FIXED_COMPOSITOR
      ? (compositorState?.compositor_state?.scene || compositorHealth?.currentProgramSceneName || null)
      : (cameraOnline ? FIXED_SCENES.CAMERA_ONLY : null),
    actual_obs_scene: publisherMode === PUBLISHER_MODES.FIXED_COMPOSITOR
      ? (compositorHealth?.currentProgramSceneName || null)
      : null,
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
    publisher: {
      mode: publisherMode,
      active: livestreaming,
      configured: !!config.liveStream.peerTubeWatchUrl,
      camera_edge_livestreaming: s.livestreaming === true,
    },
    camera_edge: {
      available: true,
      camera_online: cameraOnline,
      preview_online: previewOnline,
      recording_active: recording,
      recording_state: recording ? 'active' : 'standby',
      livestreaming: s.livestreaming === true,
      annke_camera_3_stream: cameraOnline,
      active_camera: cameraOnline ? 3 : null,
      publisher_mode: publisherMode,
      errors: Array.isArray(s.errors) ? s.errors : [],
    },
    compositor: publisherMode === PUBLISHER_MODES.FIXED_COMPOSITOR
      ? {
          available: compositorHealth?.available === true,
          scene: compositorState?.compositor_state?.scene
            || compositorHealth?.currentProgramSceneName
            || null,
          revision: Number(compositorState?.revision) || 0,
          confirmed: compositorState?.compositor_state?.confirmed === true,
          audio_policy: compositorState?.compositor_state?.audio_policy || AUDIO_POLICIES.CAMERA,
        }
      : {
          available: false,
          rollback_mode: true,
          scene: FIXED_SCENES.CAMERA_ONLY,
          revision: 0,
          confirmed: cameraOnline,
          audio_policy: AUDIO_POLICIES.CAMERA,
        },
    program: {
      ...programState,
      workspace_id: workspaceId,
    },
  };
  return { ok: true, status: 200, data };
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
  const publisher = directorResult?.data?.publisher || {};
  const compositor = directorResult?.data?.compositor || {};
  const cameraReady = directorResult?.data?.annke_camera_3_stream === true;
  const fixedMode = publisher.mode === PUBLISHER_MODES.FIXED_COMPOSITOR;
  // Camera Only is a complete program. Live content is optional and must not
  // make Start depend on the managed receiver being online or pre-populated.
  capabilities.publisher_mode = publisher.mode || config.liveStream.publisherMode;
  capabilities.publisher_ready = cameraReady
    && !!config.liveStream.peerTubeWatchUrl
    && (!fixedMode || compositor.available === true);
  capabilities.program_prepared = capabilities.publisher_ready;
  capabilities.program_scene_safe = fixedMode
    ? compositor.scene === FIXED_SCENES.CAMERA_ONLY
      || Object.values(FIXED_SCENES).includes(compositor.scene)
    : cameraReady;
  capabilities.obs_available = fixedMode ? compositor.available === true : cameraReady;
  capabilities.operator_start_allowed = capabilities.publisher_ready;
  capabilities.managed_receiver_required_for_start = false;
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
  const director = await getCameraDirectorState(req.workspaceId);
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
  if (
    config.liveStream.publisherMode === PUBLISHER_MODES.FIXED_COMPOSITOR
    && director.data.compositor?.available !== true
  ) {
    return {
      ok: false,
      status: 502,
      code: ERROR_CODES.OBS_UNAVAILABLE,
      payload,
      programState,
      currentStatus: director,
      error: director.data.obs_message || 'Fixed compositor is unavailable',
    };
  }
  return { ok: true, payload, programState, currentStatus: director, programUrl: { ok: true }, programRefresh: { ok: true } };
}

function requireCompositionWrite(req, res, requestId) {
  if (!req.actingAs && req.workspaceRole === 'workspace_viewer') {
    fail(res, req, {
      httpStatus: 403,
      code: 'READ_ONLY_WORKSPACE',
      error: 'Read-only workspace access cannot change the live composition',
      requestId,
    });
    return false;
  }
  return true;
}

function compositionFailure(res, req, requestId, error) {
  let current = null;
  try {
    current = getFixedCompositorController().getComposition(req.workspaceId);
  } catch (_) {}
  return fail(res, req, {
    httpStatus: Number(error && error.status) || 502,
    code: error && error.code || 'COMPOSITOR_REQUEST_FAILED',
    error: error && error.message || 'Fixed compositor request failed',
    requestId,
    payload: {
      accepted: false,
      requested_layout: req.body && req.body.layout || null,
      confirmed_layout: current && current.confirmed_layout || LAYOUTS.CAMERA_ONLY,
      content_instance_id: current && current.content_instance_id || null,
      receiver_state: current && current.receiver_state || null,
      compositor_state: current && current.compositor_state || null,
      failure_code: error && error.code || 'COMPOSITOR_REQUEST_FAILED',
      failure_message: error && error.message || 'Fixed compositor request failed',
      revision: Number(current && current.revision) || 0,
    },
  });
}

async function compositionSourceFromRequest(req) {
  const body = req.body || {};
  if (body.content_id) {
    const decision = contentUseDecision(
      db,
      String(body.content_id),
      req.workspaceId,
      contextFromRequest(req),
    );
    if (!decision.content) {
      const error = new Error('Content not found');
      error.code = 'CONTENT_NOT_FOUND';
      error.status = 404;
      throw error;
    }
    if (!decision.allowed) {
      const error = new Error(decision.reason || 'Content is not permitted');
      error.code = 'CONTENT_NOT_PERMITTED';
      error.status = 403;
      throw error;
    }
    if (String(decision.content.processing_status || '').toLowerCase() !== 'ready') {
      const error = new Error('Content is still preparing and cannot be routed to the livestream');
      error.code = 'CONTENT_NOT_READY';
      error.status = 409;
      throw error;
    }
    return { type: 'content', contentId: String(body.content_id) };
  }
  if (body.presentation_id) {
    const presentationId = String(body.presentation_id);
    const presentation = db.prepare(
      'SELECT id, workspace_id FROM presentations WHERE id = ?',
    ).get(presentationId);
    if (!presentation) {
      const error = new Error('Presentation not found');
      error.code = 'PRESENTATION_NOT_FOUND';
      error.status = 404;
      throw error;
    }
    if (presentation.workspace_id !== req.workspaceId) {
      const error = new Error('Presentation is not in the active workspace');
      error.code = 'PRESENTATION_NOT_PERMITTED';
      error.status = 403;
      throw error;
    }
    const publicBase = process.env.APP_URL || `${req.protocol}://${req.get('host')}`;
    return {
      type: 'presentation',
      presentationId,
      remoteUrl: deckPlayerUrl(publicBase, presentationId),
    };
  }
  if (body.remote_url) {
    const safe = await assertRemoteUrlSafe(body.remote_url);
    if (!safe.ok) {
      const error = new Error(safe.error || 'Remote page is not permitted');
      error.code = 'REMOTE_URL_NOT_PERMITTED';
      error.status = 400;
      throw error;
    }
    return { type: 'remote_url', remoteUrl: String(body.remote_url) };
  }
  const error = new Error('content_id, presentation_id, or approved remote_url is required');
  error.code = 'CONTENT_SOURCE_REQUIRED';
  error.status = 400;
  throw error;
}

function compositionRequestFields(req) {
  return {
    workspaceId: req.workspaceId,
    userId: req.user.id,
    io: req.app && typeof req.app.get === 'function' ? req.app.get('io') : null,
    idempotencyKey: String(
      req.get('X-Idempotency-Key') || req.body?.idempotency_key || '',
    ).trim(),
    expectedRevision: req.body?.expected_compositor_revision,
  };
}

// --- Routes --------------------------------------------------------------

router.get('/status', async (req, res) => {
  const requestId = createRequestId();
  if (!workspaceGuard(req, res, requestId)) return;
  const director = await getCameraDirectorState(req.workspaceId);
  cacheDeepHealth(req.workspaceId, director);
  const contract = await buildStatusContract(req, director, requestId);
  res.json({
    success: true,
    request_id: requestId,
    freshness: 'deep',
    ...contract.payload,
    program_state: contract.programState,
    ai_director: contract.aiDirector,
    publisher: director.data?.publisher || null,
    camera_edge: director.data?.camera_edge || null,
    compositor: director.data?.compositor || null,
    program: director.data?.program || null,
    composition: getFixedCompositorController().getComposition(req.workspaceId),
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
  const director = await getCameraDirectorState(req.workspaceId);
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
    publisher: director.data?.publisher || null,
    camera_edge: director.data?.camera_edge || null,
    compositor: director.data?.compositor || null,
    program: director.data?.program || null,
    composition: getFixedCompositorController().getComposition(req.workspaceId),
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

router.get('/composition', (req, res) => {
  const requestId = createRequestId();
  if (!workspaceGuard(req, res, requestId)) return;
  res.set('Cache-Control', 'no-store');
  const composition = getFixedCompositorController().getComposition(req.workspaceId);
  res.json({
    success: true,
    request_id: requestId,
    publisher_mode: config.liveStream.publisherMode,
    ...composition,
  });
});

router.post('/composition/content', async (req, res) => {
  const requestId = createRequestId();
  if (!workspaceGuard(req, res, requestId)) return;
  if (!requireCompositionWrite(req, res, requestId)) return;
  if (config.liveStream.publisherMode !== PUBLISHER_MODES.FIXED_COMPOSITOR) {
    return compositionFailure(res, req, requestId, Object.assign(
      new Error('Livestream content composition requires fixed_compositor publisher mode'),
      { code: 'FIXED_COMPOSITOR_DISABLED', status: 409 },
    ));
  }
  try {
    const source = await compositionSourceFromRequest(req);
    const audioPolicy = String(req.body?.audio_policy || AUDIO_POLICIES.CAMERA);
    if (
      audioPolicy === AUDIO_POLICIES.CONTENT_REPLACE
      && req.body?.confirm_content_audio !== true
    ) {
      throw Object.assign(
        new Error('Content audio replaces classroom camera audio and requires explicit confirmation'),
        { code: 'CONTENT_AUDIO_CONFIRMATION_REQUIRED', status: 409 },
      );
    }
    const result = await getFixedCompositorController().addContent({
      ...compositionRequestFields(req),
      source,
      contentInstanceId: req.body?.content_instance_id,
      layout: req.body?.layout,
      audioPolicy,
      contentContext: contextFromRequest(req),
    });
    logLiveStreamAction(req, 'composition-content', {
      request_id: requestId,
      content_instance_id: result.content_instance_id,
      confirmed_layout: result.confirmed_layout,
      revision: result.revision,
    });
    res.status(result.idempotent_replay ? 200 : 202).json({
      success: true,
      request_id: requestId,
      ...result,
    });
  } catch (error) {
    return compositionFailure(res, req, requestId, error);
  }
});

router.put('/composition/layout', async (req, res) => {
  const requestId = createRequestId();
  if (!workspaceGuard(req, res, requestId)) return;
  if (!requireCompositionWrite(req, res, requestId)) return;
  if (config.liveStream.publisherMode !== PUBLISHER_MODES.FIXED_COMPOSITOR) {
    return compositionFailure(res, req, requestId, Object.assign(
      new Error('Livestream composition controls require fixed_compositor publisher mode'),
      { code: 'FIXED_COMPOSITOR_DISABLED', status: 409 },
    ));
  }
  try {
    const audioPolicy = String(req.body?.audio_policy || AUDIO_POLICIES.CAMERA);
    if (
      audioPolicy === AUDIO_POLICIES.CONTENT_REPLACE
      && req.body?.confirm_content_audio !== true
    ) {
      throw Object.assign(
        new Error('Content audio replaces classroom camera audio and requires explicit confirmation'),
        { code: 'CONTENT_AUDIO_CONFIRMATION_REQUIRED', status: 409 },
      );
    }
    const result = await getFixedCompositorController().setLayout({
      ...compositionRequestFields(req),
      layout: req.body?.layout,
      audioPolicy,
    });
    logLiveStreamAction(req, 'composition-layout', {
      request_id: requestId,
      confirmed_layout: result.confirmed_layout,
      revision: result.revision,
    });
    res.json({ success: true, request_id: requestId, ...result });
  } catch (error) {
    return compositionFailure(res, req, requestId, error);
  }
});

router.delete('/composition/content', async (req, res) => {
  const requestId = createRequestId();
  if (!workspaceGuard(req, res, requestId)) return;
  if (!requireCompositionWrite(req, res, requestId)) return;
  if (config.liveStream.publisherMode !== PUBLISHER_MODES.FIXED_COMPOSITOR) {
    return compositionFailure(res, req, requestId, Object.assign(
      new Error('Livestream composition controls require fixed_compositor publisher mode'),
      { code: 'FIXED_COMPOSITOR_DISABLED', status: 409 },
    ));
  }
  try {
    const result = await getFixedCompositorController().removeContent({
      ...compositionRequestFields(req),
      contentInstanceId: req.body?.content_instance_id,
    });
    logLiveStreamAction(req, 'composition-content-remove', {
      request_id: requestId,
      revision: result.revision,
    });
    res.json({ success: true, request_id: requestId, ...result });
  } catch (error) {
    return compositionFailure(res, req, requestId, error);
  }
});

// Legacy livestream compatibility removal target: version 2.0.0 on
// September 30, 2026. Active instructor UI uses one-click Start and the
// authoritative composition routes above. Publisher mode is process-start
// configuration, so these routes cannot start an alternative publisher.
router.post('/prepare', async (req, res) => {
  markLegacyLiveCompatibility(res);
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
  markLegacyLiveCompatibility(res);
  const requestId = createRequestId();
  if (!workspaceGuard(req, res, requestId)) return;
  const director = await getCameraDirectorState(req.workspaceId);
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
  markLegacyLiveCompatibility(res);
  const requestId = createRequestId();
  if (!workspaceGuard(req, res, requestId)) return;
  const plan = getPlan(req.workspaceId);
  logLiveStreamAction(req, 'production-plan', {
    production_plan_id: plan?.production_plan_id || null,
    request_id: requestId,
    compatibility_read: true,
  }, 'GET');
  res.json({
    success: true,
    request_id: requestId,
    production_plan: plan,
  });
});

router.get('/recording/status', requirePlatformAdmin, async (req, res) => {
  const requestId = createRequestId();
  if (!workspaceGuard(req, res, requestId)) return;
  const director = await getCameraDirectorState(req.workspaceId);
  const active = !!(director.ok && director.data && director.data.recording_active);
  res.status(director.ok ? 200 : 502).json({
    success: !!director.ok,
    request_id: requestId,
    recording_active: active,
    recording_state: active ? 'active' : 'standby',
    ...(director.data && typeof director.data === 'object' ? { session_id: director.data.session_id || null } : { error: director.message }),
  });
});

router.post('/recording/preflight', requirePlatformAdmin, async (req, res) => {
  const requestId = createRequestId();
  if (!workspaceGuard(req, res, requestId)) return;
  const director = await getCameraDirectorState(req.workspaceId);
  const ok = !!(director.ok && director.data && director.data.annke_camera_3_stream);
  res.status(ok ? 200 : 502).json({
    success: ok,
    request_id: requestId,
    camera_ready: ok,
    ...(ok ? {} : { error: 'ANNKE camera is not ready for recording' }),
  });
});

router.post('/recording/start', requirePlatformAdmin, async (req, res) => {
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

router.post('/recording/stop', requirePlatformAdmin, async (req, res) => {
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

async function publisherStatus(workspaceId, publisherMode) {
  if (publisherMode === PUBLISHER_MODES.FIXED_COMPOSITOR) {
    const controller = getFixedCompositorController();
    const status = await controller.obs.getStreamStatus();
    return { active: status.active === true, raw: status };
  }
  const result = await cameraControl.getStatus();
  return {
    active: !!(result.ok && result.data && result.data.livestreaming === true),
    raw: result,
  };
}

async function rollbackSelectedPublisher(publisherMode) {
  if (publisherMode === PUBLISHER_MODES.FIXED_COMPOSITOR) {
    return getFixedCompositorController().obs.stopStreaming();
  }
  return cameraControl.stopLivestream();
}

function peerTubeIngestVerifier() {
  return createPeerTubeIngestVerifier({
    url: config.liveStream.peerTubeIngestHealthUrl,
    token: config.liveStream.peerTubeIngestHealthToken,
    requestTimeoutMs: config.liveStream.peerTubeIngestRequestTimeoutMs,
    confirmationTimeoutMs: config.liveStream.peerTubeIngestConfirmationTimeoutMs,
  });
}

router.post('/start', async (req, res) => {
  const requestId = createRequestId();
  if (!workspaceGuard(req, res, requestId)) return;
  const body = req.body || {};
  const plan = {
    production_mode: 'fixed_camera',
    director_mode: 'manual',
    camera_id: 3,
    scene_name: FIXED_SCENES.CAMERA_ONLY,
    recording_requested: body.recording_requested === true,
    production_plan_id: body.production_plan_id || null,
    deprecated_compatibility_fields_accepted: true,
  };
  const initiator = String(body.initiator || 'operator').toLowerCase();
  if (initiator !== 'operator' && initiator !== 'user') {
    return fail(res, req, {
      httpStatus: 409,
      code: ERROR_CODES.AUTOMATIC_STREAM_START_DISABLED,
      error: 'Background or autonomous stream start is disabled',
      requestId,
    });
  }
  if (plan.recording_requested && !isPlatformAdminUser(req.user)) {
    return fail(res, req, {
      httpStatus: 403,
      code: 'GLOBAL_CAMERA_ADMIN_REQUIRED',
      error: 'Starting the appliance-global recorder requires platform_admin',
      requestId,
    });
  }

  const publisherMode = config.liveStream.publisherMode;
  const preflightDirector = await getCameraDirectorState(req.workspaceId);
  const preflight = await buildStatusContract(req, preflightDirector, requestId);
  const payload = preflight.payload;
  const programState = preflight.programState;
  if (!preflightDirector.ok || preflightDirector.data?.annke_camera_3_stream !== true) {
    return fail(res, req, {
      httpStatus: 502,
      code: 'CAMERA_UNHEALTHY',
      error: preflightDirector.message || 'ANNKE camera is offline',
      requestId,
      payload: { ...payload, program_state: programState, production_plan: plan },
      capabilities: preflight.capabilities,
    });
  }
  if (!config.liveStream.peerTubeWatchUrl) {
    return fail(res, req, {
      httpStatus: 409,
      code: 'PEERTUBE_NOT_CONFIGURED',
      error: 'PeerTube livestream is not configured',
      requestId,
      payload: { ...payload, program_state: programState, production_plan: plan },
      capabilities: preflight.capabilities,
    });
  }

  const controller = getFixedCompositorController();
  if (
    publisherMode === PUBLISHER_MODES.FIXED_COMPOSITOR
    && preflightDirector.data?.publisher?.camera_edge_livestreaming === true
  ) {
    return fail(res, req, {
      httpStatus: 409,
      code: 'DUPLICATE_PUBLISHER_ACTIVE',
      error: 'Direct-camera publisher is active; fixed compositor will not start',
      requestId,
      payload: { publisher_mode: publisherMode },
    });
  }
  if (publisherMode === PUBLISHER_MODES.DIRECT_CAMERA) {
    const obsHealth = await controller.obs.health();
    if (obsHealth.available === true && obsHealth.stream?.active === true) {
      return fail(res, req, {
        httpStatus: 409,
        code: 'DUPLICATE_PUBLISHER_ACTIVE',
        error: 'Fixed-compositor publisher is active; direct camera will not start',
        requestId,
        payload: { publisher_mode: publisherMode },
      });
    }
  }

  let existingStatus;
  try {
    existingStatus = await publisherStatus(req.workspaceId, publisherMode);
  } catch (error) {
    return fail(res, req, {
      httpStatus: 502,
      code: error.code || 'PUBLISHER_UNAVAILABLE',
      error: error.message || 'Selected publisher is unavailable',
      requestId,
      payload: { publisher_mode: publisherMode },
    });
  }
  if (existingStatus.active) {
    return res.json({
      ...payload,
      success: true,
      request_id: requestId,
      stream_started: true,
      already_active: true,
      publisher: { mode: publisherMode, active: true },
      compositor: controller.getComposition(req.workspaceId),
      program_state: programState,
      production_plan: plan,
      peertube_watch_url: config.liveStream.peerTubeWatchUrl,
    });
  }

  let recordingStart = null;
  if (plan.recording_requested) {
    const recording = await cameraControl.startRecording();
    if (!recording.ok) {
      return fail(res, req, {
        httpStatus: 502,
        code: 'RECORDING_START_FAILED',
        error: recording.message || 'Recording could not start; livestream not started',
        requestId,
        payload: { production_plan: plan, recording_start: redactDirectorResult(recording) },
      });
    }
    recordingStart = recording;
  }

  let streamStart;
  try {
    if (publisherMode === PUBLISHER_MODES.FIXED_COMPOSITOR) {
      const currentComposition = controller.getComposition(req.workspaceId);
      await controller.selectCameraOnly({
        workspaceId: req.workspaceId,
        io: req.app.get('io'),
        expectedRevision: currentComposition.revision,
        idempotencyKey: `start:${requestId}:camera-only`,
      });
      streamStart = await controller.obs.startStreaming();
      if (streamStart.active !== true) {
        throw Object.assign(
          new Error('OBS did not accept the stream start'),
          { code: ERROR_CODES.STREAM_START_REJECTED },
        );
      }
    } else {
      streamStart = await cameraControl.startLivestream();
      if (!streamStart.ok || streamStart.data?.ok === false) {
        throw Object.assign(
          new Error(streamStart.message || 'Camera edge rejected stream start'),
          { code: ERROR_CODES.STREAM_START_REJECTED },
        );
      }
    }
  } catch (error) {
    if (recordingStart) await cameraControl.stopRecording();
    return fail(res, req, {
      httpStatus: 502,
      code: error.code || ERROR_CODES.STREAM_START_REJECTED,
      error: error.message || 'Selected publisher could not start',
      requestId,
      payload: {
        ...payload,
        publisher_mode: publisherMode,
        program_state: programState,
        production_plan: plan,
      },
      productionState: preflight.productionState,
    });
  }

  let verified = false;
  let verifiedPublisher = null;
  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      const publisherStatusResult = await publisherStatus(req.workspaceId, publisherMode);
      verifiedPublisher = publisherStatusResult;
      if (publisherStatusResult.active === true) {
        verified = true;
        break;
      }
    } catch (_) {}
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  const productionState = observeDirectorResult(
    req,
    { ok: verified, data: { stream_active: verified } },
    'stream:start-verified',
  );
  if (!verified) {
    await rollbackSelectedPublisher(publisherMode);
    if (recordingStart) await cameraControl.stopRecording();
    return fail(res, req, {
      httpStatus: 502,
      code: ERROR_CODES.STREAM_START_NOT_CONFIRMED,
      error: 'Selected publisher did not confirm an active PeerTube stream',
      requestId,
      payload: {
        ...payload,
        publisher_mode: publisherMode,
        publisher_status: verifiedPublisher,
        program_state: programState,
        production_plan: plan,
      },
      productionState,
    });
  }

  let peerTubeIngest;
  try {
    peerTubeIngest = await peerTubeIngestVerifier().waitForActive();
  } catch (error) {
    peerTubeIngest = {
      available: true,
      confirmed: false,
      code: 'PEERTUBE_INGEST_HEALTH_INVALID',
      message: error.message || 'PeerTube ingest health configuration is invalid',
    };
  }
  if (peerTubeIngest.available === true && peerTubeIngest.confirmed !== true) {
    try { await rollbackSelectedPublisher(publisherMode); } catch (_) {}
    if (recordingStart) {
      try { await cameraControl.stopRecording(); } catch (_) {}
    }
    const productionState = observeDirectorResult(
      req,
      { ok: false, data: { stream_active: false } },
      'stream:peertube-ingest-not-confirmed',
    );
    return fail(res, req, {
      httpStatus: 502,
      code: peerTubeIngest.code || 'PEERTUBE_INGEST_NOT_CONFIRMED',
      error: peerTubeIngest.message || 'PeerTube did not confirm the incoming live program',
      requestId,
      payload: {
        ...payload,
        publisher_mode: publisherMode,
        peertube_ingest: peerTubeIngest,
        program_state: programState,
        production_plan: plan,
      },
      productionState,
    });
  }

  clearLiveStreamLastError(req.workspaceId);
  logLiveStreamAction(req, 'start', {
    publisher_mode: publisherMode,
    selected_scene: FIXED_SCENES.CAMERA_ONLY,
    stream_started: true,
    recording_requested: !!plan.recording_requested,
    request_id: requestId,
  });
  const successDirector = await getCameraDirectorState(req.workspaceId);
  const successContract = await buildStatusContract(req, successDirector, requestId);
  res.json({
    ...payload,
    success: true,
    request_id: requestId,
    production_plan: plan,
    recording_start: recordingStart ? redactDirectorResult(recordingStart) : null,
    program_state: successContract.programState,
    program_url: { ok: true, data: { player_url: payload.player_url } },
    selected_scene: {
      ok: true,
      data: {
        current_scene: FIXED_SCENES.CAMERA_ONLY,
        actual_scene: successDirector.data?.current_scene || FIXED_SCENES.CAMERA_ONLY,
      },
    },
    stream_start: redactDirectorResult(
      publisherMode === PUBLISHER_MODES.FIXED_COMPOSITOR
        ? { ok: true, data: streamStart }
        : streamStart,
    ),
    stream_started: true,
    peertube_ingest: peerTubeIngest,
    publisher: {
      mode: publisherMode,
      active: true,
      duplicate_publisher_prevented: true,
    },
    camera_edge: successDirector.data?.camera_edge || null,
    compositor: controller.getComposition(req.workspaceId),
    program: successDirector.data?.program || successContract.programState,
    ai_director_status: redactDirectorResult(successDirector),
    production_state: productionState,
    capabilities: successContract.capabilities,
    peertube_watch_url: config.liveStream.peerTubeWatchUrl,
  });
});

router.post('/stop', async (req, res) => {
  const requestId = createRequestId();
  if (!workspaceGuard(req, res, requestId)) return;
  const payload = displayPayload(req);
  const publisherMode = config.liveStream.publisherMode;
  let stream;
  try {
    stream = publisherMode === PUBLISHER_MODES.FIXED_COMPOSITOR
      ? await getFixedCompositorController().obs.stopStreaming()
      : await cameraControl.stopLivestream();
  } catch (error) {
    return fail(res, req, {
      httpStatus: 502,
      code: ERROR_CODES.STREAM_STOP_NOT_CONFIRMED,
      error: error.message || 'Selected publisher could not stop',
      requestId,
      payload: {
        ...payload,
        publisher_mode: publisherMode,
        classroom_composition_preserved: true,
      },
    });
  }

  let verifiedActive = null;
  let productionState = getLiveProductionState(req.workspaceId);
  try {
    for (let attempt = 0; attempt < 5; attempt++) {
      await new Promise((r) => setTimeout(r, 1000));
      const check = await publisherStatus(req.workspaceId, publisherMode);
      verifiedActive = check.active;
      productionState = observeDirectorResult(
        req,
        { ok: true, data: { stream_active: check.active } },
        'stream:stop-verification',
      );
      if (check.active === false) break;
    }
    if (verifiedActive === true) {
      await rollbackSelectedPublisher(publisherMode);
      await new Promise((r) => setTimeout(r, 500));
      const check = await publisherStatus(req.workspaceId, publisherMode);
      verifiedActive = check.active;
      productionState = observeDirectorResult(
        req,
        { ok: true, data: { stream_active: check.active } },
        'stream:stop-verification',
      );
    }
  } catch (_) { /* verification best-effort */ }

  const stopAccepted = publisherMode === PUBLISHER_MODES.FIXED_COMPOSITOR
    ? stream.active === false
    : stream.ok === true;
  const stopped = stopAccepted && verifiedActive === false;
  if (!stopped) {
    return fail(res, req, {
      httpStatus: 502,
      code: ERROR_CODES.STREAM_STOP_NOT_CONFIRMED,
      error: stream.message || 'Selected publisher did not confirm that the live stream stopped',
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
    publisher_mode: publisherMode,
    classroom_composition_preserved: true,
    stream_active_after: verifiedActive,
    request_id: requestId,
  });
  res.json({
    ...payload,
    success: true,
    request_id: requestId,
    stream_stop: redactDirectorResult(
      publisherMode === PUBLISHER_MODES.FIXED_COMPOSITOR
        ? { ok: true, data: stream }
        : stream,
    ),
    publisher: { mode: publisherMode, active: false },
    compositor: getFixedCompositorController().getComposition(req.workspaceId),
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

router.get('/recordings', requirePlatformAdmin, async (req, res) => {
  const requestId = createRequestId();
  if (!workspaceGuard(req, res, requestId)) return;
  const result = await cameraControl.getRecordings();
  res.json(result.ok ? { success: true, request_id: requestId, ...(result.data && typeof result.data === 'object' ? result.data : { recordings: [] }) } : { success: false, request_id: requestId, recordings: [], error: result.message });
});

// Recording deletion: impact preview, archive, restore, permanent delete.
// PeerTube deletion is a separate explicit route.
router.get('/recordings/:id/deletion-impact', requirePlatformAdmin, async (req, res) => {
  const requestId = createRequestId();
  if (!workspaceGuard(req, res, requestId)) return;
  const result = await cameraControl.getDeletionImpact(req.params.id, { operatorId: req.user.id });
  if (result.ok) {
    res.json({ success: true, request_id: requestId, ...(result.data || {}) });
  } else {
    res.status(result.status || 404).json({ success: false, request_id: requestId, error: result.message });
  }
});

router.post('/recordings/:id/archive', requirePlatformAdmin, async (req, res) => {
  const requestId = createRequestId();
  if (!workspaceGuard(req, res, requestId)) return;
  const result = await cameraControl.archiveRecording(req.params.id, { operatorId: req.user.id });
  res.status(result.ok ? 200 : (result.status || 409)).json({ success: result.ok, request_id: requestId, ...(result.data || {}), error: result.message });
});

router.post('/recordings/:id/restore', requirePlatformAdmin, async (req, res) => {
  const requestId = createRequestId();
  if (!workspaceGuard(req, res, requestId)) return;
  const result = await cameraControl.restoreRecording(req.params.id, { operatorId: req.user.id });
  res.status(result.ok ? 200 : (result.status || 409)).json({ success: result.ok, request_id: requestId, ...(result.data || {}), error: result.message });
});

router.delete('/recordings/:id', requirePlatformAdmin, async (req, res) => {
  const requestId = createRequestId();
  if (!workspaceGuard(req, res, requestId)) return;
  const ifMatch = req.headers['if-match'];
  const result = await cameraControl.deleteRecording(req.params.id, {
    ifMatch,
    confirmTyped: req.body?.confirm,
    operatorId: req.user.id,
  });
  res.status(result.ok ? 200 : (result.status || 409)).json({ success: result.ok, request_id: requestId, ...(result.data || {}), error: result.message });
});

router.delete('/recordings/:id/peertube', requirePlatformAdmin, async (req, res) => {
  const requestId = createRequestId();
  if (!workspaceGuard(req, res, requestId)) return;
  const result = await cameraControl.deletePeerTubeVideo(req.params.id, {
    confirmTyped: req.body?.confirm,
    operatorId: req.user.id,
  });
  res.status(result.ok ? 200 : (result.status || 502)).json({ success: result.ok, request_id: requestId, ...(result.data || {}), error: result.message });
});

router.post('/clear-content', async (req, res) => {
  const requestId = createRequestId();
  if (!workspaceGuard(req, res, requestId)) return;
  if (!requireCompositionWrite(req, res, requestId)) return;
  if (config.liveStream.publisherMode === PUBLISHER_MODES.FIXED_COMPOSITOR) {
    try {
      const controller = getFixedCompositorController();
      const current = controller.getComposition(req.workspaceId);
      const result = await controller.removeContent({
        workspaceId: req.workspaceId,
        userId: req.user.id,
        io: req.app && typeof req.app.get === 'function' ? req.app.get('io') : null,
        contentInstanceId: current.content_instance_id,
        expectedRevision: current.revision,
        idempotencyKey: `deprecated-clear:${requestId}`,
      });
      logLiveStreamAction(req, 'clear-content', {
        cleared: true,
        compatibility_endpoint: true,
        revision: result.revision,
        request_id: requestId,
      });
      return res.json({
        success: true,
        request_id: requestId,
        cleared: true,
        deprecated: true,
        ...result,
        refresh: { ok: true, data: { message: 'Live content cleared after Camera Only confirmation' } },
        program_state: liveStreamProgramState(req.workspaceId),
      });
    } catch (error) {
      return compositionFailure(res, req, requestId, error);
    }
  }
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
  const director = await getCameraDirectorState(req.workspaceId);
  res.json({
    success: !!director.ok,
    request_id: requestId,
    refresh: redactDirectorResult(director),
  });
});

module.exports = router;
