'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { persistedSignal } = require('../lib/live-source-state');

test('persistent live-source state excludes volatile measurements and heartbeat timestamps', () => {
  const value = persistedSignal({
    video_online: true,
    microphone_connected: true,
    audio_online: true,
    synchronization_status: 'locked',
    configured_delay_ms: 0,
    input_level_db: -4.25,
    mean_level_db: -30,
    last_audio_frame_at: '2026-07-30T20:00:00Z',
    last_audio_measurement_at: '2026-07-30T20:00:01Z',
    last_update: '2026-07-30T20:00:02Z',
  });

  assert.deepEqual(value, {
    video_online: true,
    microphone_connected: true,
    audio_online: true,
    synchronization_status: 'locked',
    configured_delay_ms: 0,
  });
});
