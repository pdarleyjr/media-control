'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  ERROR_CODES,
  buildLivestreamCapabilities,
  classifyDirectorFailure,
  redactDirectorResult,
  startGateFailure,
} = require('../lib/live-stream-capabilities');

test('status capabilities expose non-secret operator fields', () => {
  const caps = buildLivestreamCapabilities({
    workspaceId: 'ws-1',
    display: { id: 'live-stream-program-x', status: 'online' },
    programState: { configured: true, content_active: true },
    directorResult: {
      ok: true,
      data: {
        obs: true,
        peertube_configured: true,
        stream_active: false,
        current_scene: 'KAMRUI_CAMERA_1_FULL',
        mode: 'manual',
        effective_mode: 'manual',
        autoswitch_enabled: false,
        kamrui_camera_1_stream: true,
        operator_stream_start_allowed: true,
        automatic_stream_start_allowed: false,
        director: { active_camera: 1, content_active: true },
        settings: { rtmp_url: 'rtmp://secret', stream_key: 'abc' },
      },
    },
    peerTubeWatchUrl: 'https://videos.example/watch/x',
    requestId: 'ls_test',
  });

  assert.equal(caps.request_id, 'ls_test');
  assert.equal(caps.operator_start_allowed, true);
  assert.equal(caps.automatic_start_allowed, false);
  assert.equal(caps.peertube_configured, true);
  assert.equal(caps.obs_available, true);
  assert.equal(caps.managed_receiver_online, true);
  assert.equal(caps.program_prepared, true);
  assert.equal(caps.program_content_active, true);
  assert.equal(caps.program_scene, 'KAMRUI_CAMERA_1_FULL');
  assert.equal(caps.stream_state, 'ready');
  assert.equal(caps.director_mode, 'manual');
  assert.equal('rtmp_url' in caps, false);
  assert.equal('stream_key' in caps, false);
});

test('operator start may stay enabled while automatic remains disabled', () => {
  const caps = buildLivestreamCapabilities({
    display: { id: 'live-stream-program-x', status: 'online' },
    programState: { configured: true, content_active: false },
    directorResult: {
      ok: true,
      data: {
        obs: true,
        peertube_configured: true,
        operator_stream_start_allowed: true,
        automatic_stream_start_allowed: false,
        current_scene: 'KAMRUI_CAMERA_1_FULL',
        mode: 'manual',
        kamrui_camera_1_stream: true,
      },
    },
    peerTubeWatchUrl: 'https://videos.example/watch/x',
  });
  assert.equal(caps.operator_start_allowed, true);
  assert.equal(caps.automatic_start_allowed, false);
  assert.equal(startGateFailure(caps, { directorMode: 'manual' }), null);
  assert.equal(
    startGateFailure(caps, { directorMode: 'auto', confirmAutoCanary: false }).code,
    ERROR_CODES.AUTO_CANARY_CONFIRMATION_REQUIRED,
  );
});

test('classify ENABLE_STREAM_START=false as operator start disabled', () => {
  const classified = classifyDirectorFailure({
    ok: true,
    data: { ok: false, message: 'stream start disabled by ENABLE_STREAM_START=false' },
  });
  assert.equal(classified.code, ERROR_CODES.OPERATOR_STREAM_START_DISABLED);
  assert.match(classified.error, /Operator stream start is disabled/i);
});

test('classify timeout and non-json responses', () => {
  assert.equal(
    classifyDirectorFailure({ ok: false, message: 'AI Director request timed out' }).code,
    ERROR_CODES.AI_DIRECTOR_TIMEOUT,
  );
  assert.equal(
    classifyDirectorFailure({ ok: false, data: '<html>bad gateway</html>', message: 'x' }).code,
    ERROR_CODES.NON_JSON_DOWNSTREAM_RESPONSE,
  );
});

test('redaction strips settings secrets and keeps safe status fields', () => {
  const redacted = redactDirectorResult({
    ok: true,
    status: 200,
    data: {
      obs: true,
      current_scene: 'KAMRUI_CAMERA_1_FULL',
      stream_active: false,
      settings: { stream_key: 'secret', rtmp_url: 'rtmp://x' },
      director: { active_camera: 1, content_active: false, internal_token: 'nope' },
    },
  });
  assert.equal(redacted.data.settings, undefined);
  assert.equal(redacted.data.current_scene, 'KAMRUI_CAMERA_1_FULL');
  assert.equal(redacted.data.director.active_camera, 1);
  assert.equal(redacted.data.director.internal_token, undefined);
});

test('start gates surface specific offline/unconfigured codes', () => {
  const base = {
    operator_start_allowed: true,
    automatic_start_allowed: false,
    peertube_configured: true,
    peertube_reachable: true,
    obs_available: true,
    managed_receiver_online: true,
    program_prepared: true,
  };
  assert.equal(
    startGateFailure({ ...base, peertube_configured: false }, { directorMode: 'manual' }).code,
    ERROR_CODES.PEERTUBE_NOT_CONFIGURED,
  );
  assert.equal(
    startGateFailure({ ...base, obs_available: false }, { directorMode: 'manual' }).code,
    ERROR_CODES.OBS_UNAVAILABLE,
  );
  assert.equal(
    startGateFailure({ ...base, managed_receiver_online: false }, { directorMode: 'manual' }).code,
    ERROR_CODES.MANAGED_RECEIVER_OFFLINE,
  );
  assert.equal(
    startGateFailure({ ...base, operator_start_allowed: false }, { directorMode: 'manual' }).code,
    ERROR_CODES.OPERATOR_STREAM_START_DISABLED,
  );
});
