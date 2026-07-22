'use strict';

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const {
  DEFAULT_STALE_AFTER_MS,
  mapDirectorStatus,
  updateLiveProductionState,
  getLiveProductionState,
  resetLiveProductionStateForTests,
} = require('../lib/live-production-state');

beforeEach(() => resetLiveProductionStateForTests());

test('director status is converted to strict public stream and recording DTOs', () => {
  const mapped = mapDirectorStatus({
    stream_active: true,
    recording_active: true,
    current_scene: 'KAMRUI_CAMERA_2_FULL',
    mode: 'auto',
    director: { active_camera: 2, token: 'must-not-leak' },
    password: 'must-not-leak',
    arbitrary: { secret: 'must-not-leak' },
  }, 1700000000000);

  assert.deepEqual(mapped, {
    streamState: {
      status: 'live',
      active: true,
      reachable: true,
      stale: false,
      currentScene: 'KAMRUI_CAMERA_2_FULL',
      mode: 'auto',
      activeCamera: 2,
      updatedAt: 1700000000000,
      checkedAt: 1700000000000,
    },
    recordingState: {
      status: 'recording',
      active: true,
      reachable: true,
      stale: false,
      updatedAt: 1700000000000,
      checkedAt: 1700000000000,
    },
  });
  assert.doesNotMatch(JSON.stringify(mapped), /token|password|secret|arbitrary/i);
});

test('recording remains unknown when the director does not explicitly report it', () => {
  const mapped = mapDirectorStatus({
    stream_active: true,
    current_scene: 'MEDIA_CONTROL_FULL',
  }, 42);

  assert.equal(mapped.streamState.status, 'live');
  assert.deepEqual(mapped.recordingState, {
    status: 'unknown',
    active: null,
    reachable: true,
    stale: false,
    updatedAt: 42,
    checkedAt: 42,
  });
});

test('conflicting explicit recording flags fail closed to unknown', () => {
  const mapped = mapDirectorStatus({
    stream_active: false,
    recording_active: true,
    record_active: false,
  }, 43);

  assert.equal(mapped.streamState.status, 'stopped');
  assert.equal(mapped.recordingState.status, 'unknown');
  assert.equal(mapped.recordingState.active, null);
});

test('malformed known status fields fail closed instead of being coerced', () => {
  const mapped = mapDirectorStatus({
    stream_active: 'true',
    recording_active: true,
    record_active: 0,
  }, 44);

  assert.equal(mapped.streamState.status, 'unknown');
  assert.equal(mapped.streamState.active, null);
  assert.equal(mapped.recordingState.status, 'unknown');
  assert.equal(mapped.recordingState.active, null);
});

test('cache is workspace isolated and returns defensive copies', () => {
  updateLiveProductionState('ws-one', {
    ok: true,
    data: { stream_active: true, recording_active: false, current_scene: 'PROGRAM' },
  }, { now: 100 });
  updateLiveProductionState('ws-two', {
    ok: true,
    data: { stream_active: false, recording_active: true, current_scene: 'HOLDING_SLIDE' },
  }, { now: 101 });

  const one = getLiveProductionState('ws-one', { now: 102 });
  const two = getLiveProductionState('ws-two', { now: 102 });
  assert.equal(one.streamState.status, 'live');
  assert.equal(one.recordingState.status, 'stopped');
  assert.equal(two.streamState.status, 'stopped');
  assert.equal(two.recordingState.status, 'recording');

  one.streamState.status = 'tampered';
  assert.equal(getLiveProductionState('ws-one', { now: 102 }).streamState.status, 'live');
});

test('director failure preserves the last observed truth but marks it unreachable and stale', () => {
  updateLiveProductionState('ws-one', {
    ok: true,
    data: { stream_active: true, recording_active: true, current_scene: 'PROGRAM' },
  }, { now: 100 });

  const result = updateLiveProductionState('ws-one', {
    ok: false,
    message: 'connection failed',
    data: { token: 'must-not-leak' },
  }, { now: 200 });

  assert.equal(result.changed, true);
  assert.deepEqual(result.state.streamState, {
    status: 'live',
    active: true,
    reachable: false,
    stale: true,
    currentScene: 'PROGRAM',
    mode: null,
    activeCamera: null,
    updatedAt: 200,
    checkedAt: 200,
  });
  assert.equal(result.state.recordingState.status, 'recording');
  assert.equal(result.state.recordingState.reachable, false);
  assert.doesNotMatch(JSON.stringify(result), /connection failed|token|must-not-leak/i);
});

test('cached observations age to stale without changing their last observed status', () => {
  updateLiveProductionState('ws-one', {
    ok: true,
    data: { stream_active: false },
  }, { now: 100 });

  const fresh = getLiveProductionState('ws-one', { now: 100 + DEFAULT_STALE_AFTER_MS });
  const stale = getLiveProductionState('ws-one', { now: 101 + DEFAULT_STALE_AFTER_MS });
  assert.equal(fresh.streamState.stale, false);
  assert.equal(stale.streamState.stale, true);
  assert.equal(stale.streamState.status, 'stopped');
  assert.equal(stale.recordingState.status, 'unknown');
});

test('repeated equivalent observations do not report an authoritative state change', () => {
  const first = updateLiveProductionState('ws-one', {
    ok: true,
    data: { stream_active: true, recording_active: false, current_scene: 'PROGRAM' },
  }, { now: 100 });
  const repeated = updateLiveProductionState('ws-one', {
    ok: true,
    data: { stream_active: true, recording_active: false, current_scene: 'PROGRAM' },
  }, { now: 200 });

  assert.equal(first.changed, true);
  assert.equal(repeated.changed, false);
  assert.equal(repeated.state.streamState.checkedAt, 200);
  assert.equal(repeated.state.streamState.updatedAt, 100);
});
