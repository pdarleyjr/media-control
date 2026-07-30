'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  sceneIsSafeToStream,
  sceneMatchesProgramState,
} = require('../lib/live-stream-safety');

function status(overrides = {}) {
  return {
    mode: 'manual',
    current_scene: 'ANPVIZ_CAMERA_FULL',
    anpviz_stream: true,
    director: { active_source: 'anpviz', content_active: false },
    ...overrides,
  };
}

test('manual start accepts only an approved composition with healthy referenced cameras', () => {
  assert.equal(sceneIsSafeToStream(status(), 'manual', false), true);
  assert.equal(sceneIsSafeToStream(status({ current_scene: 'ANPVIZ_CONTENT_5050' }), 'manual', true), true);
  assert.equal(sceneIsSafeToStream(status({ anpviz_stream: false }), 'manual', false), false);
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
    current_scene: 'ANPVIZ_CAMERA_FULL',
  }), false), true);
  assert.equal(sceneMatchesProgramState(status({
    mode: 'auto',
    current_scene: 'ANPVIZ_CAMERA_FULL',
    director: { active_source: 'anpviz', content_active: true },
  }), false), false);
  assert.equal(sceneMatchesProgramState(status({
    mode: 'auto',
    current_scene: 'ANPVIZ_CAMERA_FULL',
    director: { active_source: null, content_active: false },
  }), false), false);
});
