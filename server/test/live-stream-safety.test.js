'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  sceneIsSafeToStream,
  sceneMatchesProgramState,
  resolveDirectorContentActive,
} = require('../lib/live-stream-safety');

function status(overrides = {}) {
  return {
    mode: 'manual',
    current_scene: 'KAMRUI_CAMERA_1_FULL',
    kamrui_camera_1_stream: true,
    kamrui_camera_2_stream: false,
    annke_camera_3_stream: true,
    director: { active_camera: 1, content_active: false },
    ...overrides,
  };
}

test('manual start accepts only an approved composition with healthy referenced cameras', () => {
  assert.equal(sceneIsSafeToStream(status(), 'manual', false), true);
  assert.equal(sceneIsSafeToStream(status({ current_scene: 'KAMRUI_CONTENT_5050_CAM3' }), 'manual', true), true);
  assert.equal(sceneIsSafeToStream(status({ current_scene: 'KAMRUI_CAMERA_2_FULL' }), 'manual', false), false);
  assert.equal(sceneIsSafeToStream(status({ current_scene: 'UNREVIEWED_OPERATOR_SCENE' }), 'manual', false), false);
});

test('content-only program is approved while holding and emergency scenes are rejected', () => {
  assert.equal(sceneIsSafeToStream(status({ current_scene: 'MEDIA_CONTROL_FULL' }), 'manual', true), true);
  assert.equal(sceneIsSafeToStream(status({ current_scene: 'HOLDING_SLIDE' }), 'manual', false), false);
  assert.equal(sceneIsSafeToStream(status({ current_scene: 'EMERGENCY_FALLBACK' }), 'manual', false), false);
});

test('automatic start also requires director content and camera state to match the composition', () => {
  assert.equal(sceneMatchesProgramState(status({
    mode: 'auto',
    current_scene: 'KAMRUI_CAMERA_1_FULL',
  }), false), true);
  assert.equal(sceneMatchesProgramState(status({
    mode: 'auto',
    current_scene: 'KAMRUI_CAMERA_1_FULL',
    director: { active_camera: 1, content_active: true },
  }), false), false);
  assert.equal(sceneMatchesProgramState(status({
    mode: 'auto',
    current_scene: 'KAMRUI_CAMERA_2_FULL',
    director: { active_camera: 2, content_active: false },
  }), false), false);
});

test('unconfigured/unknown content probes do not count as trustworthy content state', () => {
  const unknown = resolveDirectorContentActive(status({
    director: {
      active_camera: 1,
      content_active: false,
      content_observation_state: 'unknown',
      content_observation_reason: 'expected_room_not_configured',
    },
  }));
  assert.equal(unknown.known, false);

  const fromMc = resolveDirectorContentActive(status({
    media_control_content_active: true,
    director: {
      active_camera: 1,
      content_active: false,
      content_observation_state: 'unknown',
      content_observation_reason: 'expected_room_not_configured',
    },
  }));
  assert.equal(fromMc.known, true);
  assert.equal(fromMc.value, true);
  assert.equal(fromMc.source, 'media_control_content_active');
});

test('auto go-live is not bricked when room content probe is unconfigured', () => {
  const data = status({
    mode: 'auto',
    effective_mode: 'auto',
    configured_mode: 'auto',
    current_scene: 'KAMRUI_CAMERA_1_FULL',
    media_control_content_active: true,
    director: {
      active_camera: 1,
      content_active: false,
      content_observation_state: 'unknown',
      content_observation_reason: 'expected_room_not_configured',
    },
  });
  assert.equal(sceneIsSafeToStream(data, 'auto', true), true);
  const noMc = { ...data };
  delete noMc.media_control_content_active;
  assert.equal(sceneIsSafeToStream(noMc, 'auto', true), true);
});
