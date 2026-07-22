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

function sceneMatchesProgramState(data, contentActive) {
  if (String(data && data.mode || '').toLowerCase() !== 'auto') return false;
  if (!approvedSceneIsHealthy(data)) return false;
  const director = data && data.director || {};
  if (typeof director.content_active !== 'boolean' || director.content_active !== !!contentActive) return false;
  const activeCamera = Number(director.active_camera) || null;
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
  if (directorMode === 'auto') return sceneMatchesProgramState(data, contentActive);
  return String(data && data.mode || '').toLowerCase() === 'manual';
}

module.exports = {
  APPROVED_PROGRAM_SCENES,
  approvedSceneIsHealthy,
  cameraIsHealthy,
  referencedCamera,
  sceneIsSafeToStream,
  sceneMatchesProgramState,
};
