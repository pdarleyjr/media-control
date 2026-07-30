'use strict';

const APPROVED_PROGRAM_SCENES = new Set([
  'MEDIA_CONTROL_FULL',
  'ANPVIZ_CAMERA_FULL',
  'ANPVIZ_CAMERA_PLUS_MEDIA_CONTROL_PIP',
  'ANPVIZ_CONTENT_5050',
]);

function referencedCamera(scene) {
  return /^ANPVIZ_/.test(String(scene || '')) ? 'anpviz' : null;
}

function cameraIsHealthy(data, camera) {
  if (camera === 'anpviz') return data && data.anpviz_stream === true;
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
  const activeCamera = director.active_source === 'anpviz' ? 'anpviz' : null;
  const scene = String(data.current_scene || '');

  if (!contentActive) {
    return activeCamera === 'anpviz' && scene === 'ANPVIZ_CAMERA_FULL';
  }
  if (scene === 'MEDIA_CONTROL_FULL') return true;
  if (!activeCamera) return false;
  return scene === 'ANPVIZ_CAMERA_PLUS_MEDIA_CONTROL_PIP'
    || scene === 'ANPVIZ_CONTENT_5050';
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
