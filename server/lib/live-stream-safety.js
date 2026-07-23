'use strict';

const APPROVED_PROGRAM_SCENES = new Set([
  'MEDIA_CONTROL_FULL',
  'KAMRUI_CAMERA_1_FULL',
  'KAMRUI_CAMERA_2_FULL',
  'KAMRUI_CAMERA_3_FULL',
  'KAMRUI_CAMERA_1_PLUS_MEDIA_CONTROL_PIP',
  'KAMRUI_CAMERA_2_PLUS_MEDIA_CONTROL_PIP',
  'KAMRUI_CAMERA_3_PLUS_MEDIA_CONTROL_PIP',
  'KAMRUI_CONTENT_5050_CAM1',
  'KAMRUI_CONTENT_5050_CAM2',
  'KAMRUI_CONTENT_5050_CAM3',
]);

const UNKNOWN_CONTENT_OBSERVATION = new Set([
  'unknown',
  'no_observation_yet',
  'unavailable',
  'unconfigured',
]);

const UNRELIABLE_CONTENT_REASONS = new Set([
  'no_observation_yet',
  'expected_room_not_configured',
  'room_not_configured',
  'probe_unavailable',
  'media_control_unreachable',
]);

function referencedCamera(scene) {
  const match = String(scene || '').match(/(?:CAMERA_|CAM)([123])(?:_|$)/);
  return match ? Number(match[1]) : null;
}

function cameraIsHealthy(data, camera) {
  if (camera === 1) return data && data.kamrui_camera_1_stream === true;
  if (camera === 2) return data && data.kamrui_camera_2_stream === true;
  if (camera === 3) {
    return !!(data && (data.annke_camera_3_stream === true || data.kamrui_camera_3_stream === true));
  }
  return true;
}

function approvedSceneIsHealthy(data) {
  const scene = String(data && data.current_scene || '');
  if (!APPROVED_PROGRAM_SCENES.has(scene)) return false;
  return cameraIsHealthy(data, referencedCamera(scene));
}

function isUnreliableContentObservation(director = {}) {
  if (director.content_probe_stale === true || director.content_probe_safety_timeout === true) {
    return true;
  }
  const hasExplicitState = director.content_observation_state != null
    && String(director.content_observation_state).trim() !== '';
  const hasExplicitReason = director.content_observation_reason != null
    && String(director.content_observation_reason).trim() !== '';
  const state = hasExplicitState ? String(director.content_observation_state).toLowerCase() : '';
  const reason = hasExplicitReason ? String(director.content_observation_reason).toLowerCase() : '';
  if (hasExplicitState && UNKNOWN_CONTENT_OBSERVATION.has(state)) return true;
  if (hasExplicitReason && UNRELIABLE_CONTENT_REASONS.has(reason)) return true;
  return false;
}

/**
 * Resolve whether content-active is known for start-gate comparison.
 * Prefer Media Control-informed deep /status flag when present.
 * Unknown/unconfigured room probes are "not known" so they cannot brick go-live.
 */
function resolveDirectorContentActive(data) {
  if (data && typeof data.media_control_content_active === 'boolean') {
    return {
      known: true,
      value: data.media_control_content_active === true,
      source: 'media_control_content_active',
    };
  }
  const director = (data && data.director) || {};
  if (isUnreliableContentObservation(director)) {
    const state = String(director.content_observation_state || '').toLowerCase();
    const reason = String(director.content_observation_reason || '').toLowerCase();
    return { known: false, value: null, source: reason || state || 'unknown' };
  }
  if (typeof director.content_active === 'boolean') {
    return {
      known: true,
      value: director.content_active === true,
      source: 'director.content_active',
    };
  }
  return { known: false, value: null, source: 'missing' };
}

function modeIsAuto(data) {
  return String(
    (data && (data.mode || data.effective_mode || data.configured_mode)) || ''
  ).toLowerCase() === 'auto';
}

function modeIsManual(data) {
  return String(
    (data && (data.mode || data.effective_mode || data.configured_mode)) || ''
  ).toLowerCase() === 'manual';
}

function sceneMatchesProgramState(data, contentActive) {
  if (!modeIsAuto(data)) return false;
  if (!approvedSceneIsHealthy(data)) return false;
  const content = resolveDirectorContentActive(data);
  if (!content.known || content.value !== !!contentActive) return false;
  const director = data && data.director || {};
  const activeCamera = Number(director.active_camera || data.active_camera) || null;
  const scene = String(data.current_scene || '');

  if (!contentActive) {
    return !!activeCamera && scene === `KAMRUI_CAMERA_${activeCamera}_FULL`;
  }
  if (scene === 'MEDIA_CONTROL_FULL') return true;
  if (!activeCamera) return false;
  return scene === `KAMRUI_CAMERA_${activeCamera}_PLUS_MEDIA_CONTROL_PIP`
    || scene === `KAMRUI_CONTENT_5050_CAM${activeCamera}`;
}

function sceneIsSafeToStream(data, directorMode, contentActive) {
  if (!approvedSceneIsHealthy(data)) return false;
  if (directorMode === 'auto') {
    if (sceneMatchesProgramState(data, contentActive)) return true;
    // Broken/unconfigured content probe must not brick auto go-live when the
    // program scene is already an approved healthy composition.
    if (isUnreliableContentObservation((data && data.director) || {})) {
      return modeIsAuto(data);
    }
    return false;
  }
  return modeIsManual(data);
}

module.exports = {
  APPROVED_PROGRAM_SCENES,
  approvedSceneIsHealthy,
  cameraIsHealthy,
  isUnreliableContentObservation,
  referencedCamera,
  resolveDirectorContentActive,
  sceneIsSafeToStream,
  sceneMatchesProgramState,
};
