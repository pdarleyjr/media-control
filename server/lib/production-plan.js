'use strict';

const crypto = require('crypto');

const PLAN_TTL_MS = 30 * 60 * 1000;
const plansByWorkspace = new Map();

const PRODUCTION_MODES = new Set(['fixed_camera', 'ai_director', 'manual_multicamera']);
const AUDIO_MODES = new Set(['speech', 'content_audio', 'screen_share_audio']);

function cameraScene(cameraId) {
  const id = Number(cameraId) || 1;
  return `KAMRUI_CAMERA_${id}_FULL`;
}

function normalizePlanInput(body = {}) {
  const production_mode = String(body.production_mode || 'fixed_camera').toLowerCase();
  if (!PRODUCTION_MODES.has(production_mode)) {
    const err = new Error(`Unknown production_mode: ${production_mode}`);
    err.code = 'INVALID_PRODUCTION_MODE';
    throw err;
  }
  const camera_id = body.camera_id != null ? Number(body.camera_id) : null;
  if (production_mode === 'fixed_camera') {
    if (![1, 2, 3].includes(camera_id)) {
      const err = new Error('Fixed Camera requires camera_id 1, 2, or 3');
      err.code = 'INVALID_CAMERA';
      throw err;
    }
  }
  const audio_mode = String(body.audio_mode || 'speech').toLowerCase().replace(/-/g, '_');
  if (!AUDIO_MODES.has(audio_mode)) {
    const err = new Error(`Unknown audio_mode: ${audio_mode}`);
    err.code = 'INVALID_AUDIO_MODE';
    throw err;
  }
  const director_mode = production_mode === 'ai_director' ? 'auto' : 'manual';
  const scene_name = body.scene_name
    || (production_mode === 'fixed_camera' ? cameraScene(camera_id) : null);
  return {
    production_mode,
    director_mode,
    camera_id: Number.isFinite(camera_id) ? camera_id : null,
    scene_name,
    audio_mode,
    recording_requested: body.recording_requested === true,
    confirm_auto_canary: body.confirm_auto_canary === true || production_mode === 'ai_director',
    initiator: 'operator',
    peertube_privacy: body.peertube_privacy || 'unlisted',
  };
}

function putPlan(workspaceId, body, meta = {}) {
  if (!workspaceId) {
    const err = new Error('workspace required');
    err.code = 'WORKSPACE_REQUIRED';
    throw err;
  }
  const base = normalizePlanInput(body);
  const now = Date.now();
  const plan = {
    production_plan_id: crypto.randomUUID(),
    workspace_id: workspaceId,
    version: 1,
    created_at: now,
    expires_at: now + PLAN_TTL_MS,
    ...base,
    camera_health: meta.camera_health || null,
    summary: {
      production_mode: base.production_mode,
      director_mode: base.director_mode,
      camera_id: base.camera_id,
      scene_name: base.scene_name,
      audio_mode: base.audio_mode,
      recording_requested: base.recording_requested,
      peertube_privacy: base.peertube_privacy,
    },
  };
  plansByWorkspace.set(workspaceId, plan);
  return plan;
}

function getPlan(workspaceId, planId) {
  const plan = plansByWorkspace.get(workspaceId) || null;
  if (!plan) return null;
  if (planId && plan.production_plan_id !== planId) return null;
  if (Date.now() > plan.expires_at) {
    plansByWorkspace.delete(workspaceId);
    return null;
  }
  return plan;
}

function clearPlan(workspaceId) {
  plansByWorkspace.delete(workspaceId);
}

function consumePlanForStart(workspaceId, body = {}) {
  const planId = body.production_plan_id || null;
  let plan = planId ? getPlan(workspaceId, planId) : getPlan(workspaceId);
  if (!plan && body.production_mode) {
    plan = putPlan(workspaceId, body);
  }
  if (!plan) {
    const err = new Error(
      'No production plan. Use Prepare Live Production and confirm the plan before starting.'
    );
    err.code = 'PRODUCTION_PLAN_REQUIRED';
    throw err;
  }
  if (Date.now() > plan.expires_at) {
    clearPlan(workspaceId);
    const err = new Error('Production plan expired. Prepare Live Production again.');
    err.code = 'PRODUCTION_PLAN_EXPIRED';
    throw err;
  }
  return plan;
}

module.exports = {
  PLAN_TTL_MS,
  PRODUCTION_MODES,
  AUDIO_MODES,
  putPlan,
  getPlan,
  clearPlan,
  consumePlanForStart,
  normalizePlanInput,
  cameraScene,
};
