'use strict';

// Workspace-scoped cache for the small, public subset of AI Director / OBS
// state that the room-state contract is allowed to expose. Raw director
// responses are never retained because they can grow new fields independently
// of this service and may eventually contain credentials.

const DEFAULT_STALE_AFTER_MS = 30000;
const stateByWorkspace = new Map();
const lastErrorByWorkspace = new Map();

function normalizeWorkspaceId(workspaceId) {
  const normalized = typeof workspaceId === 'string' ? workspaceId.trim() : '';
  if (!normalized) throw new TypeError('workspaceId is required');
  if (normalized.length > 255) throw new RangeError('workspaceId is too long');
  return normalized;
}

function safeText(value, maxLength = 160) {
  if (typeof value !== 'string') return null;
  const normalized = value.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  return normalized ? normalized.slice(0, maxLength) : null;
}

function explicitBoolean(data, keys) {
  const presentKeys = keys.filter((key) => Object.prototype.hasOwnProperty.call(data, key));
  if (!presentKeys.length) return null;
  const values = presentKeys.map((key) => data[key]);
  if (values.some((value) => typeof value !== 'boolean')) return null;
  if (values.some((value) => value !== values[0])) return null;
  return values[0];
}

function statusFor(active, activeStatus) {
  if (active === true) return activeStatus;
  if (active === false) return 'stopped';
  return 'unknown';
}

function mapDirectorStatus(data, now = Date.now()) {
  const source = data && typeof data === 'object' && !Array.isArray(data) ? data : {};
  const timestamp = Number.isFinite(Number(now)) ? Number(now) : Date.now();
  const streamActive = explicitBoolean(source, ['stream_active']);
  // These are the only recording booleans currently recognized. In
  // particular, streaming does not imply recording.
  const recordingActive = explicitBoolean(source, ['recording_active', 'record_active']);
  const activeCameraValue = source.director && typeof source.director === 'object'
    ? Number(source.director.active_camera)
    : NaN;
  const activeCamera = Number.isInteger(activeCameraValue)
    && activeCameraValue > 0 && activeCameraValue <= 64
    ? activeCameraValue
    : null;

  return {
    streamState: {
      status: statusFor(streamActive, 'live'),
      active: streamActive,
      reachable: true,
      stale: false,
      currentScene: safeText(source.current_scene),
      mode: safeText(source.mode, 40),
      activeCamera,
      updatedAt: timestamp,
      checkedAt: timestamp,
    },
    recordingState: {
      status: statusFor(recordingActive, 'recording'),
      active: recordingActive,
      reachable: true,
      stale: false,
      updatedAt: timestamp,
      checkedAt: timestamp,
    },
  };
}

function emptyState() {
  return {
    streamState: {
      status: 'unknown',
      active: null,
      reachable: null,
      stale: true,
      currentScene: null,
      mode: null,
      activeCamera: null,
      updatedAt: null,
      checkedAt: null,
    },
    recordingState: {
      status: 'unknown',
      active: null,
      reachable: null,
      stale: true,
      updatedAt: null,
      checkedAt: null,
    },
  };
}

function cloneState(state) {
  return {
    streamState: { ...state.streamState },
    recordingState: { ...state.recordingState },
  };
}

function semanticState(state) {
  const cloned = cloneState(state);
  delete cloned.streamState.updatedAt;
  delete cloned.streamState.checkedAt;
  delete cloned.recordingState.updatedAt;
  delete cloned.recordingState.checkedAt;
  return cloned;
}

function semanticallyEqual(left, right) {
  return JSON.stringify(semanticState(left)) === JSON.stringify(semanticState(right));
}

function failedObservation(previous, now) {
  const state = cloneState(previous || emptyState());
  for (const key of ['streamState', 'recordingState']) {
    state[key].reachable = false;
    state[key].stale = true;
    state[key].checkedAt = now;
    state[key].updatedAt = now;
  }
  return state;
}

function updateLiveProductionState(workspaceId, directorResult, options = {}) {
  const id = normalizeWorkspaceId(workspaceId);
  const now = Number.isFinite(Number(options.now)) ? Number(options.now) : Date.now();
  const previous = stateByWorkspace.get(id) || null;
  const candidate = directorResult && directorResult.ok === true
    ? mapDirectorStatus(directorResult.data, now)
    : failedObservation(previous, now);
  const changed = !previous || !semanticallyEqual(previous, candidate);

  if (!changed && previous) {
    candidate.streamState.updatedAt = previous.streamState.updatedAt;
    candidate.recordingState.updatedAt = previous.recordingState.updatedAt;
  }
  stateByWorkspace.set(id, cloneState(candidate));
  return { changed, state: cloneState(candidate) };
}

function getLiveProductionState(workspaceId, options = {}) {
  const id = normalizeWorkspaceId(workspaceId);
  const now = Number.isFinite(Number(options.now)) ? Number(options.now) : Date.now();
  const staleAfterMs = Number.isFinite(Number(options.staleAfterMs))
    ? Math.max(0, Number(options.staleAfterMs))
    : DEFAULT_STALE_AFTER_MS;
  const state = cloneState(stateByWorkspace.get(id) || emptyState());
  for (const key of ['streamState', 'recordingState']) {
    const checkedAt = state[key].checkedAt;
    if (checkedAt == null || now - checkedAt > staleAfterMs) state[key].stale = true;
  }
  return state;
}

function setLiveStreamLastError(workspaceId, error, options = {}) {
  const id = normalizeWorkspaceId(workspaceId);
  if (!error || !error.code) {
    lastErrorByWorkspace.delete(id);
    return null;
  }
  const entry = {
    code: safeText(String(error.code), 80),
    message: safeText(String(error.message || error.error || ''), 240),
    at: Number.isFinite(Number(options.now)) ? Number(options.now) : Date.now(),
    requestId: error.requestId || error.request_id || null,
  };
  lastErrorByWorkspace.set(id, entry);
  return { ...entry };
}

function clearLiveStreamLastError(workspaceId) {
  const id = normalizeWorkspaceId(workspaceId);
  lastErrorByWorkspace.delete(id);
}

function getLiveStreamLastError(workspaceId) {
  const id = normalizeWorkspaceId(workspaceId);
  const entry = lastErrorByWorkspace.get(id);
  return entry ? { ...entry } : null;
}

function resetLiveProductionStateForTests() {
  stateByWorkspace.clear();
  lastErrorByWorkspace.clear();
}

module.exports = {
  DEFAULT_STALE_AFTER_MS,
  mapDirectorStatus,
  updateLiveProductionState,
  getLiveProductionState,
  setLiveStreamLastError,
  clearLiveStreamLastError,
  getLiveStreamLastError,
  resetLiveProductionStateForTests,
};
