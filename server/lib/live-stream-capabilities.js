'use strict';

const crypto = require('crypto');
const { sceneIsSafeToStream, APPROVED_PROGRAM_SCENES } = require('./live-stream-safety');

const STREAM_STATES = new Set([
  'unavailable',
  'not_configured',
  'standby',
  'preparing',
  'ready',
  'starting',
  'active',
  'stopping',
  'failed',
  'stale',
]);

const ERROR_CODES = Object.freeze({
  OPERATOR_STREAM_START_DISABLED: 'OPERATOR_STREAM_START_DISABLED',
  AUTOMATIC_STREAM_START_DISABLED: 'AUTOMATIC_STREAM_START_DISABLED',
  PEERTUBE_NOT_CONFIGURED: 'PEERTUBE_NOT_CONFIGURED',
  PEERTUBE_UNREACHABLE: 'PEERTUBE_UNREACHABLE',
  OBS_UNAVAILABLE: 'OBS_UNAVAILABLE',
  MANAGED_RECEIVER_OFFLINE: 'MANAGED_RECEIVER_OFFLINE',
  PROGRAM_NOT_PREPARED: 'PROGRAM_NOT_PREPARED',
  PROGRAM_SCENE_UNSAFE: 'PROGRAM_SCENE_UNSAFE',
  AI_DIRECTOR_TIMEOUT: 'AI_DIRECTOR_TIMEOUT',
  AI_DIRECTOR_UNREACHABLE: 'AI_DIRECTOR_UNREACHABLE',
  STREAM_START_REJECTED: 'STREAM_START_REJECTED',
  STREAM_START_NOT_CONFIRMED: 'STREAM_START_NOT_CONFIRMED',
  STREAM_STOP_NOT_CONFIRMED: 'STREAM_STOP_NOT_CONFIRMED',
  STREAM_ALREADY_ACTIVE: 'STREAM_ALREADY_ACTIVE',
  WORKSPACE_FORBIDDEN: 'WORKSPACE_FORBIDDEN',
  WORKSPACE_REQUIRED: 'WORKSPACE_REQUIRED',
  AUTO_CANARY_CONFIRMATION_REQUIRED: 'AUTO_CANARY_CONFIRMATION_REQUIRED',
  MALFORMED_DOWNSTREAM_RESPONSE: 'MALFORMED_DOWNSTREAM_RESPONSE',
  NON_JSON_DOWNSTREAM_RESPONSE: 'NON_JSON_DOWNSTREAM_RESPONSE',
});

function envFlag(name, defaultValue) {
  const raw = process.env[name];
  if (raw == null || raw === '') return defaultValue;
  const normalized = String(raw).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return defaultValue;
}

function createRequestId() {
  return `ls_${Date.now().toString(36)}_${crypto.randomBytes(4).toString('hex')}`;
}

function errorEnvelope({ code, error, requestId, details, httpStatus = 400 }) {
  const body = {
    success: false,
    code: code || 'STREAM_START_REJECTED',
    error: error || 'Request failed',
    request_id: requestId || createRequestId(),
  };
  if (details && typeof details === 'object') {
    body.details = details;
  }
  return { httpStatus, body };
}

function directorMessage(result) {
  if (!result) return '';
  if (result.data && typeof result.data === 'object') {
    return String(result.data.message || result.data.detail || result.data.error || result.message || '');
  }
  return String(result.message || '');
}

function classifyDirectorFailure(result, fallbackCode = ERROR_CODES.STREAM_START_REJECTED) {
  if (!result) {
    return {
      code: ERROR_CODES.AI_DIRECTOR_UNREACHABLE,
      error: 'AI Director did not respond',
    };
  }
  const message = directorMessage(result);
  const lowered = message.toLowerCase();
  if (result.message === 'AI Director request timed out' || lowered.includes('timed out')) {
    return { code: ERROR_CODES.AI_DIRECTOR_TIMEOUT, error: message || 'AI Director request timed out' };
  }
  if (typeof result.data === 'string' && result.data && !result.data.trim().startsWith('{')) {
    return {
      code: ERROR_CODES.NON_JSON_DOWNSTREAM_RESPONSE,
      error: 'AI Director returned a non-JSON response',
    };
  }
  if (
    lowered.includes('enable_stream_start=false')
    || lowered.includes('stream start disabled')
    || lowered.includes('operator stream start disabled')
  ) {
    return {
      code: ERROR_CODES.OPERATOR_STREAM_START_DISABLED,
      error: 'Operator stream start is disabled on the AI Director (ENABLE_STREAM_START=false). Enable operator starts without enabling automatic starts.',
    };
  }
  if (lowered.includes('automatic') && lowered.includes('disabled')) {
    return {
      code: ERROR_CODES.AUTOMATIC_STREAM_START_DISABLED,
      error: message || 'Automatic stream start is disabled',
    };
  }
  if (!result.ok && result.status == null && message) {
    return { code: ERROR_CODES.AI_DIRECTOR_UNREACHABLE, error: message };
  }
  return { code: fallbackCode, error: message || 'Live stream request was rejected' };
}

function redactDirectorResult(result) {
  if (!result || typeof result !== 'object') {
    return { ok: false, message: 'AI Director unavailable' };
  }
  const data = result.data && typeof result.data === 'object' && !Array.isArray(result.data)
    ? result.data
    : null;
  if (!data) {
    return {
      ok: !!result.ok,
      status: result.status || null,
      message: result.message || null,
    };
  }
  const safe = {
    status: data.status || null,
    obs: data.obs === true,
    obs_message: typeof data.obs_message === 'string' ? data.obs_message.slice(0, 160) : null,
    stream_active: typeof data.stream_active === 'boolean' ? data.stream_active : null,
    stream_state: typeof data.stream_state === 'string' ? data.stream_state.slice(0, 40) : null,
    recording_active: typeof data.recording_active === 'boolean' ? data.recording_active : null,
    recording_state: typeof data.recording_state === 'string' ? data.recording_state.slice(0, 40) : null,
    peertube_configured: data.peertube_configured === true,
    current_scene: typeof data.current_scene === 'string' ? data.current_scene.slice(0, 120) : null,
    actual_obs_scene: typeof data.actual_obs_scene === 'string' ? data.actual_obs_scene.slice(0, 120) : null,
    mode: typeof data.mode === 'string' ? data.mode.slice(0, 40) : null,
    configured_mode: typeof data.configured_mode === 'string' ? data.configured_mode.slice(0, 40) : null,
    effective_mode: typeof data.effective_mode === 'string' ? data.effective_mode.slice(0, 40) : null,
    autoswitch_enabled: data.autoswitch_enabled === true,
    media_control_available: data.media_control_available === true,
    media_control_content_active: data.media_control_content_active === true,
    kamrui_camera_1_stream: data.kamrui_camera_1_stream === true,
    kamrui_camera_2_stream: data.kamrui_camera_2_stream === true,
    annke_camera_3_stream: data.annke_camera_3_stream === true,
  };
  if (data.director && typeof data.director === 'object') {
    safe.director = {
      active_camera: Number(data.director.active_camera) || null,
      content_active: data.director.content_active === true,
    };
  }
  if (typeof data.operator_stream_start_allowed === 'boolean') {
    safe.operator_stream_start_allowed = data.operator_stream_start_allowed;
  }
  if (typeof data.automatic_stream_start_allowed === 'boolean') {
    safe.automatic_stream_start_allowed = data.automatic_stream_start_allowed;
  }
  if (typeof data.stream_start_allowed === 'boolean') {
    safe.stream_start_allowed = data.stream_start_allowed;
  }
  return {
    ok: !!result.ok,
    status: result.status || null,
    message: result.message || null,
    data: safe,
  };
}

function mapStreamState({
  directorOk,
  streamActive,
  peertubeConfigured,
  obsAvailable,
  receiverOnline,
  lastErrorCode,
  productionStreamStatus,
}) {
  if (lastErrorCode && !streamActive) return 'failed';
  if (streamActive === true || productionStreamStatus === 'live') return 'active';
  if (!directorOk) return 'unavailable';
  if (!peertubeConfigured) return 'not_configured';
  if (!obsAvailable) return 'unavailable';
  if (!receiverOnline) return 'standby';
  return 'ready';
}

function buildLivestreamCapabilities({
  workspaceId,
  display,
  programState,
  directorResult,
  productionState,
  peerTubeWatchUrl,
  peertubeReachable = null,
  lastError = null,
  requestId = null,
} = {}) {
  const directorOk = !!(directorResult && directorResult.ok && directorResult.data);
  const data = directorOk ? directorResult.data : {};
  const mcOperatorAllowed = envFlag('LIVE_STREAM_OPERATOR_START_ALLOWED', true);
  const mcAutomaticAllowed = envFlag('LIVE_STREAM_AUTOMATIC_START_ALLOWED', false);

  const directorOperatorAllowed = typeof data.operator_stream_start_allowed === 'boolean'
    ? data.operator_stream_start_allowed
    : (typeof data.stream_start_allowed === 'boolean' ? data.stream_start_allowed : null);
  const directorAutomaticAllowed = typeof data.automatic_stream_start_allowed === 'boolean'
    ? data.automatic_stream_start_allowed
    : false;

  const operatorStartAllowed = mcOperatorAllowed && directorOperatorAllowed !== false;
  const automaticStartAllowed = mcAutomaticAllowed && directorAutomaticAllowed === true;

  const peertubeConfigured = !!(
    (typeof data.peertube_configured === 'boolean' && data.peertube_configured)
    || String(peerTubeWatchUrl || '').trim()
  );
  const peertubeReachableValue = typeof peertubeReachable === 'boolean'
    ? peertubeReachable
    : (directorOk && peertubeConfigured ? true : null);

  const obsAvailable = directorOk && data.obs !== false && (
    data.obs === true
    || typeof data.current_scene === 'string'
    || data.media_control_available === true
  );
  const receiverOnline = !!(display && String(display.status || '').toLowerCase() === 'online');
  const programPrepared = !!(programState && programState.configured && display && display.id);
  const programContentActive = !!(programState && programState.content_active);
  const programScene = typeof data.current_scene === 'string' ? data.current_scene : null;
  const directorMode = typeof data.mode === 'string' ? data.mode : null;
  const effectiveMode = typeof data.effective_mode === 'string' ? data.effective_mode : directorMode;
  const autoswitchEnabled = data.autoswitch_enabled === true;
  const contentActive = programContentActive;
  const programSceneSafe = directorOk
    ? sceneIsSafeToStream(data, directorMode === 'auto' ? 'auto' : 'manual', contentActive)
    : false;

  const streamActive = data.stream_active === true
    || (productionState && productionState.streamState && productionState.streamState.active === true);
  const recordingActive = data.recording_active === true
    || (productionState && productionState.recordingState && productionState.recordingState.active === true);

  const productionStreamStatus = productionState && productionState.streamState
    ? productionState.streamState.status
    : null;
  const streamState = mapStreamState({
    directorOk,
    streamActive,
    peertubeConfigured,
    obsAvailable,
    receiverOnline,
    lastErrorCode: lastError && lastError.code,
    productionStreamStatus,
  });
  const recordingState = recordingActive
    ? 'active'
    : (directorOk ? 'standby' : 'unavailable');

  const normalizedStreamState = STREAM_STATES.has(streamState) ? streamState : 'unavailable';

  return {
    request_id: requestId || createRequestId(),
    operator_start_allowed: operatorStartAllowed,
    automatic_start_allowed: automaticStartAllowed,
    peertube_configured: peertubeConfigured,
    peertube_reachable: peertubeReachableValue,
    obs_available: obsAvailable,
    managed_receiver_online: receiverOnline,
    program_prepared: programPrepared,
    program_content_active: programContentActive,
    program_scene: programScene,
    program_scene_safe: programSceneSafe,
    stream_state: normalizedStreamState,
    recording_state: recordingState,
    director_mode: directorMode,
    effective_mode: effectiveMode,
    autoswitch_enabled: autoswitchEnabled,
    last_error_code: lastError && lastError.code ? lastError.code : null,
    last_error_message: lastError && lastError.message ? String(lastError.message).slice(0, 240) : null,
    last_error_at: lastError && lastError.at ? lastError.at : null,
    workspace_id: workspaceId || null,
    display_id: display && display.id ? display.id : null,
    approved_program_scenes: Array.from(APPROVED_PROGRAM_SCENES),
  };
}

function startGateFailure(capabilities, { directorMode, confirmAutoCanary }) {
  if (!capabilities) {
    return {
      code: ERROR_CODES.STREAM_START_REJECTED,
      error: 'Livestream capabilities are unavailable',
      httpStatus: 503,
    };
  }
  if (directorMode === 'auto' && !confirmAutoCanary) {
    return {
      code: ERROR_CODES.AUTO_CANARY_CONFIRMATION_REQUIRED,
      error: 'Automatic direction requires an explicit completed-canary confirmation',
      httpStatus: 409,
    };
  }
  if (!capabilities.operator_start_allowed) {
    return {
      code: ERROR_CODES.OPERATOR_STREAM_START_DISABLED,
      error: 'Operator-initiated stream start is disabled',
      httpStatus: 409,
    };
  }
  if (!capabilities.peertube_configured) {
    return {
      code: ERROR_CODES.PEERTUBE_NOT_CONFIGURED,
      error: 'PeerTube live output is not configured',
      httpStatus: 503,
    };
  }
  if (capabilities.peertube_reachable === false) {
    return {
      code: ERROR_CODES.PEERTUBE_UNREACHABLE,
      error: 'PeerTube is not reachable',
      httpStatus: 503,
    };
  }
  if (!capabilities.obs_available) {
    return {
      code: ERROR_CODES.OBS_UNAVAILABLE,
      error: 'OBS is not available through the AI Director',
      httpStatus: 503,
    };
  }
  if (!capabilities.managed_receiver_online) {
    return {
      code: ERROR_CODES.MANAGED_RECEIVER_OFFLINE,
      error: 'Managed OBS program receiver is offline',
      httpStatus: 503,
    };
  }
  if (!capabilities.program_prepared) {
    return {
      code: ERROR_CODES.PROGRAM_NOT_PREPARED,
      error: 'Live program display is not prepared',
      httpStatus: 503,
    };
  }
  return null;
}

module.exports = {
  ERROR_CODES,
  STREAM_STATES,
  buildLivestreamCapabilities,
  classifyDirectorFailure,
  createRequestId,
  directorMessage,
  envFlag,
  errorEnvelope,
  redactDirectorResult,
  startGateFailure,
};
