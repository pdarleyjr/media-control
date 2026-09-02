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

test('explicit null decoded frames remain unavailable and never become frame zero', () => {
  const tracker = createMediaProgressTracker({ stallThresholdMs: 30_000 });
  tracker.observe({ now: 1_000, expected_playing: true, current_time: 1, decoded_frames: null });
  const snapshot = tracker.observe({ now: 2_000, expected_playing: true, current_time: 2, decoded_frames: null });

  assert.equal(snapshot.decoded_frame_available, false);
  assert.equal(snapshot.last_decoded_frame_progress_at, null);
  assert.equal(snapshot.last_confirmed_render_progress_at, 2_000);
});

test('decoded-frame reads preserve null and missing telemetry while retaining numeric zero', () => {
  const { readDecodedFrames } = require('../player/media-progress');
  assert.equal(readDecodedFrames({ getVideoPlaybackQuality: () => ({ totalVideoFrames: null }) }), null);
  assert.equal(readDecodedFrames({ getVideoPlaybackQuality: () => ({}) }), null);
  assert.equal(readDecodedFrames({ getVideoPlaybackQuality: () => ({ totalVideoFrames: 0 }) }), 0);
  assert.equal(readDecodedFrames({ getVideoPlaybackQuality: () => ({ totalVideoFrames: 17 }) }), 17);
});

test('decoded-frame telemetry is authoritative when available: a moving media clock cannot hide frozen frames', () => {
  const tracker = createMediaProgressTracker({ stallThresholdMs: 30_000 });
  tracker.observe({ now: 1_000, expected_playing: true, current_time: 1, decoded_frames: 10 });
  const snapshot = tracker.observe({ now: 2_000, expected_playing: true, current_time: 2, decoded_frames: 10 });

  assert.equal(snapshot.last_media_progress_at, 2_000);
  assert.equal(snapshot.last_decoded_frame_progress_at, null);
  assert.equal(snapshot.last_confirmed_render_progress_at, null);
});

test('an indefinitely loading expected playback transitions to stalled after startup grace', () => {
  const tracker = createMediaProgressTracker({ stallThresholdMs: 30_000 });
  assert.equal(tracker.observe({ now: 1_000, expected_playing: true, loading: true }).playback_state, 'LOADING');
  const stalled = tracker.observe({ now: 31_000, expected_playing: true, loading: true });
  assert.equal(stalled.playback_state, 'STALLED');
  assert.equal(stalled.stall_started_at, 31_000);
});

test('a seek is not render progress and a content lifecycle reset clears prior evidence', () => {
  const tracker = createMediaProgressTracker({ stallThresholdMs: 30_000 });
  tracker.observe({ now: 1_000, expected_playing: true, current_time: 1 });
  tracker.observe({ now: 2_000, expected_playing: true, current_time: 2 });
  const seeking = tracker.observe({ now: 3_000, expected_playing: true, current_time: 90, seeking: true });
  assert.equal(seeking.last_confirmed_render_progress_at, 2_000);
  tracker.reset();
  const fresh = tracker.observe({ now: 4_000, expected_playing: true, current_time: 90 });
  assert.equal(fresh.last_confirmed_render_progress_at, null);
});

test('a newly applicable command cannot inherit old render progress and freezes its first post-command advancement', () => {
  const tracker = createMediaProgressTracker({ stallThresholdMs: 30_000 });
  tracker.observe({ now: 1_000, expected_playing: true, current_time: 1, decoded_frames: 10 });
  tracker.observe({ now: 2_000, expected_playing: true, current_time: 2, decoded_frames: 11 });
  tracker.setCommand('command-a', { now: 2_100 });
  assert.equal(tracker.observe({ now: 2_200, expected_playing: true, current_time: 2, decoded_frames: 11 }).command_id, null);
  assert.equal(tracker.observe({ now: 3_000, expected_playing: true, current_time: 3, decoded_frames: 12 }).command_id, 'command-a');
  tracker.setCommand('command-b', { now: 3_100 });
  assert.equal(tracker.observe({ now: 3_200, expected_playing: true, current_time: 3, decoded_frames: 12 }).command_id, null);
  const confirmedB = tracker.observe({ now: 4_000, expected_playing: true, current_time: 4, decoded_frames: 13 });
  assert.equal(confirmedB.command_id, 'command-b');
  assert.equal(confirmedB.command_confirmation_at, 4_000);
  assert.equal(tracker.observe({ now: 5_000, expected_playing: true, current_time: 5, decoded_frames: 14 }).command_confirmation_at, 4_000);
});

test('a command-specific baseline prevents unsampled pre-command progress from confirming a later command', () => {
  const tracker = createMediaProgressTracker({ stallThresholdMs: 30_000 });
  tracker.observe({ now: 1_000, expected_playing: true, current_time: 1, decoded_frames: 10 });
  tracker.observe({ now: 2_000, expected_playing: true, current_time: 2, decoded_frames: 11 });
  tracker.setCommand('command-b', { now: 2_100 });

  // Frame 15 may have advanced before command B; its first post-command
  // observation is a command baseline, never confirmation evidence.
  const firstPostCommand = tracker.observe({ now: 3_000, expected_playing: true, current_time: 6, decoded_frames: 15 });
  assert.equal(firstPostCommand.command_id, null);
  assert.equal(firstPostCommand.command_confirmation_at, null);

  const laterProgress = tracker.observe({ now: 4_000, expected_playing: true, current_time: 7, decoded_frames: 16 });
  assert.equal(laterProgress.command_id, 'command-b');
  assert.equal(laterProgress.command_confirmation_at, 4_000);
});

test('the first stable post-seek observation is a baseline even if seek completed before telemetry sampled it', () => {
  const tracker = createMediaProgressTracker({ stallThresholdMs: 30_000 });
  tracker.observe({ now: 1_000, expected_playing: true, current_time: 1, decoded_frames: 10 });
  tracker.observe({ now: 2_000, expected_playing: true, current_time: 2, decoded_frames: 11 });
  tracker.setCommand('seek-command', { now: 2_100 });

  const postSeek = tracker.observe({
    now: 3_000, expected_playing: true, current_time: 90, decoded_frames: 90,
    seek_transition: true,
  });
  assert.equal(postSeek.command_id, null);
  assert.equal(postSeek.last_confirmed_render_progress_at, 2_000);

  const laterProgress = tracker.observe({ now: 4_000, expected_playing: true, current_time: 91, decoded_frames: 91 });
  assert.equal(laterProgress.command_id, 'seek-command');
  assert.equal(laterProgress.command_confirmation_at, 4_000);
});

test('registry records command confirmation at server observation time only after a qualifying report', () => {
  const registry = new RendererProgressRegistry({ maxEntries: 2, now: () => 9_000 });
  registry.record('display-a', { playback_state: 'PLAYING_PROGRESS', command_id: null, last_confirmed_render_progress_at: 1_000 });
  const entry = registry.record('display-a', {
    playback_state: 'PLAYING_PROGRESS', command_id: 'command-b', command_confirmation_at: 4_000,
    last_confirmed_render_progress_at: 4_000,
  });
  assert.equal(entry.command_id, 'command-b');
  assert.equal(entry.command_confirmation_at, 9_000);
});

test('error telemetry is allowlisted and never returns arbitrary bearer text', () => {
  const error = normalizePlaybackError({
    source: 'html5', type: 'mediaError', details: 2,
    message: 'Authorization: Bearer very-secret-token', fatal: true,
  });
  assert.deepEqual(error, {
    category: 'NETWORK', code: 'HTML5_MEDIA_ERR_NETWORK', fatal: true, recoverable: false,
    message: 'Playback source could not be reached.',
  });
});

test('unknown external codes and YouTube text collapse to bounded safe codes', () => {
  const hostile = normalizePlaybackError({
    source: 'hls', type: 'networkError', details: 'AUTHORIZATION_BEARER_ABC123_SECRET',
  });
  assert.deepEqual(hostile, {
    category: 'NETWORK', code: 'PLAYBACK_SOURCE_ERROR', fatal: false, recoverable: true,
    message: 'Playback source could not be reached.',
  });
  const youtube = normalizePlaybackError({ source: 'youtube', details: 'token=secret' });
  assert.deepEqual(youtube, {
    category: 'MEDIA', code: 'PLAYBACK_UNKNOWN_ERROR', fatal: false, recoverable: true,
    message: 'Playback failed.',
  });
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

test('a renderer session or content generation change cannot retain prior render confirmation', () => {
  const registry = new RendererProgressRegistry({ maxEntries: 2, now: () => 9_000 });
  registry.record('display-a', {
    renderer_session_id: 'session-a', content_generation: 'generation-a',
    playback_state: 'PLAYING_PROGRESS', last_confirmed_render_progress_at: 8_000,
    command_id: 'command-a', command_confirmation_at: 8_000,
  });
  const fresh = registry.record('display-a', {
    renderer_session_id: 'session-a', content_generation: 'generation-b', playback_state: 'IDLE',
  });
  assert.equal(fresh.last_confirmed_render_progress_at, null);
  assert.equal(fresh.command_id, null);
  assert.equal(fresh.command_confirmation_at, null);
});
