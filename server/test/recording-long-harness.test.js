'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

test('user-run long recording harness is explicit, bounded by the user and produces a report', () => {
  const harness = fs.readFileSync(path.join(__dirname, '..', '..', 'kamrui-media-edge', 'scripts', 'user-long-recording-test.sh'), 'utf8');
  assert.match(harness, /MBFD_USER_AUTHORIZED_LONG_TEST=YES/);
  assert.match(harness, /LONG_TEST_DURATION_SECONDS/);
  assert.match(harness, /ffprobe/);
  assert.match(harness, /sha256sum/);
  assert.match(harness, /samples\.jsonl/);
  assert.match(harness, /report\.json/);
  assert.match(harness, /report\.md/);
  assert.match(harness, /elapsed_seconds/);
  assert.match(harness, /current_segment/);
  assert.match(harness, /supervisor_state/);
  assert.match(harness, /mbfd-recording-admin status/);
  assert.match(harness, /supervisor_validated/);
  assert.match(harness, /video_track_healthy/);
  assert.match(harness, /audio_track_healthy/);
  assert.match(harness, /file_size_bytes/);
  assert.match(harness, /free_space_bytes/);
  assert.match(harness, /camera_source_healthy/);
  assert.match(harness, /cpu_percent/);
  assert.match(harness, /ram_bytes/);
  assert.match(harness, /temperature_c/);
  assert.match(harness, /api_restart_observed/);
  assert.match(harness, /curl.*--config/s);
  assert.doesNotMatch(harness, /X-Api-Token:\s*\$CAMERA_API_TOKEN/);
  assert.match(harness, /checksum_mismatch/);
  assert.match(harness, /chmod 0444/);
  assert.doesNotMatch(harness, /LONG_TEST_DURATION_SECONDS:=/);
  assert.doesNotMatch(harness, /node-detached/);
});

test('recording systemd template gives the validated runner a bounded finalization window', () => {
  const unit = fs.readFileSync(
    path.join(__dirname, '..', '..', 'kamrui-media-edge', 'systemd', 'mbfd-camera-recording@.service'),
    'utf8'
  );
  assert.match(unit, /KillMode=mixed/);
  assert.match(unit, /KillSignal=SIGINT/);
  assert.match(unit, /TimeoutStopSec=45/);
  assert.match(unit, /TimeoutStopFailureMode=kill/);
  assert.match(unit, /Restart=no/);
  assert.match(unit, /StartLimitBurst=/);
  assert.match(unit, /NoNewPrivileges=true/);
});
