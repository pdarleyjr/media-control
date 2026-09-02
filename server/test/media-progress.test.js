'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  DEFAULT_STALL_THRESHOLD_MS,
  createMediaProgressTracker,
  normalizePlaybackError,
  RendererProgressRegistry,
} = require('../lib/media-progress');

test('advancing expected media reports software render progress without claiming physical pixels', () => {
  const tracker = createMediaProgressTracker({ stallThresholdMs: 30_000 });
  tracker.observe({ now: 1_000, expected_playing: true, current_time: 2, decoded_frames: 10 });
  const snapshot = tracker.observe({ now: 6_000, expected_playing: true, current_time: 7, decoded_frames: 16 });

  assert.equal(snapshot.playback_state, 'PLAYING_PROGRESS');
  assert.equal(snapshot.last_media_progress_at, 6_000);
  assert.equal(snapshot.last_decoded_frame_progress_at, 6_000);
  assert.equal(snapshot.last_confirmed_render_progress_at, 6_000);
  assert.equal(snapshot.physical_pixels_observed, false);
});

test('a fresh heartbeat equivalent with unchanged media time does not prove render progress', () => {
  const tracker = createMediaProgressTracker({ stallThresholdMs: 30_000 });
  tracker.observe({ now: 1_000, expected_playing: true, current_time: 4 });
  const snapshot = tracker.observe({ now: 11_000, expected_playing: true, current_time: 4 });

  assert.equal(snapshot.playback_state, 'PLAYING_PROGRESS');
  // Initial media position establishes a baseline; it is not advancement.
  assert.equal(snapshot.last_media_progress_at, null);
  assert.equal(snapshot.last_confirmed_render_progress_at, null);
});

test('paused media is not classified as stalled', () => {
  const tracker = createMediaProgressTracker({ stallThresholdMs: 30_000 });
  tracker.observe({ now: 1_000, expected_playing: true, current_time: 4 });
  const snapshot = tracker.observe({ now: 61_000, expected_playing: false, paused: true, current_time: 4 });

  assert.equal(snapshot.playback_state, 'PAUSED');
  assert.equal(snapshot.stall_started_at, null);
});

test('expected-playing media with no progress becomes stalled only after the bounded threshold', () => {
  const tracker = createMediaProgressTracker({ stallThresholdMs: DEFAULT_STALL_THRESHOLD_MS });
  tracker.observe({ now: 1_000, expected_playing: true, current_time: 4 });
  assert.equal(tracker.observe({ now: 30_999, expected_playing: true, current_time: 4 }).playback_state, 'PLAYING_PROGRESS');
  const stalled = tracker.observe({ now: 31_000, expected_playing: true, current_time: 4 });

  assert.equal(stalled.playback_state, 'STALLED');
  assert.equal(stalled.stall_started_at, 31_000);
});

test('progress after a stall enters recovering then returns to playing progress', () => {
  const tracker = createMediaProgressTracker({ stallThresholdMs: 30_000 });
  tracker.observe({ now: 1_000, expected_playing: true, current_time: 4 });
  tracker.observe({ now: 31_000, expected_playing: true, current_time: 4 });
  const recovering = tracker.observe({ now: 32_000, expected_playing: true, current_time: 5 });
  const live = tracker.observe({ now: 33_000, expected_playing: true, current_time: 6 });

  assert.equal(recovering.playback_state, 'RECOVERING');
  assert.equal(recovering.recovered_at, 32_000);
  assert.equal(live.playback_state, 'PLAYING_PROGRESS');
});

test('structured playback errors distinguish recoverable HLS network failures from fatal decode failures and recover', () => {
  const recoverable = normalizePlaybackError({ source: 'hls', type: 'networkError', details: 'manifestLoadError', fatal: false });
  const fatal = normalizePlaybackError({ source: 'hls', type: 'mediaError', details: 'fragParsingError', fatal: true });
  assert.deepEqual(recoverable, {
    category: 'NETWORK', code: 'HLS_MANIFEST_LOAD_ERROR', fatal: false, recoverable: true,
    message: 'HLS manifest could not be loaded.',
  });
  assert.deepEqual(fatal, {
    category: 'DECODE', code: 'HLS_FRAG_PARSING_ERROR', fatal: true, recoverable: false,
    message: 'HLS media could not be decoded.',
  });

  const tracker = createMediaProgressTracker();
  tracker.observe({ now: 1_000, expected_playing: true, error: recoverable });
  const errored = tracker.observe({ now: 2_000, expected_playing: true, error: recoverable });
  const recovered = tracker.observe({ now: 3_000, expected_playing: true, current_time: 1 });
  assert.equal(errored.error.first_seen_at, 1_000);
  assert.equal(errored.error.last_seen_at, 2_000);
  assert.equal(recovered.error.recovered_at, 3_000);
});

test('missing decoded-frame APIs gracefully fall back to media time', () => {
  const tracker = createMediaProgressTracker();
  tracker.observe({ now: 1_000, expected_playing: true, current_time: 1 });
  const snapshot = tracker.observe({ now: 2_000, expected_playing: true, current_time: 2 });
  assert.equal(snapshot.decoded_frame_available, false);
  assert.equal(snapshot.last_decoded_frame_progress_at, null);
  assert.equal(snapshot.last_confirmed_render_progress_at, 2_000);
});

test('bounded renderer registry records server-observed progress, preserves the command correlation, and strips unsafe error details', () => {
  const registry = new RendererProgressRegistry({ maxEntries: 2, now: () => 9_000 });
  const snapshot = registry.record('display-a', {
    playback_state: 'PLAYING_PROGRESS',
    last_media_progress_at: 8_000,
    last_confirmed_render_progress_at: 8_000,
    command_id: 'command-a',
    error: { category: 'NETWORK', code: 'HLS_MANIFEST_LOAD_ERROR', message: 'https://token.example/secret' },
  });

  assert.equal(snapshot.observed_at, 9_000);
  assert.equal(snapshot.command_id, 'command-a');
  assert.equal(snapshot.error.message, 'HLS manifest could not be loaded.');
  assert.equal(registry.get('display-a').physical_pixels_observed, false);
  registry.record('display-b', { playback_state: 'IDLE' });
  registry.record('display-c', { playback_state: 'IDLE' });
  assert.equal(registry.get('display-a'), null);
});
