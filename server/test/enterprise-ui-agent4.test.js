import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  deriveLiveLadder,
  formatLiveFailure,
  LIVE_LADDER,
} from '../../frontend/js/state/live-stream-ui.js';
import {
  createScreenshotPoller,
  getScreenshotPollMetrics,
} from '../../frontend/js/services/screenshot-poll.js';

describe('live-stream-ui ladder', () => {
  it('blocks start when operator_start_allowed is false', () => {
    const ladder = deriveLiveLadder({
      capabilities: {
        peertube_configured: true,
        peertube_reachable: true,
        managed_receiver_online: true,
        obs_available: true,
        program_prepared: true,
        program_scene_safe: true,
        operator_start_allowed: false,
        last_error_code: 'OPERATOR_STREAM_START_DISABLED',
        last_error_message: 'stream start disabled',
      },
    });
    assert.equal(ladder.canStart, false);
    assert.match(String(ladder.reason), /disabled|Start|stream/i);
  });

  it('reports OBS compositor unavailable for fixed_compositor blocker (no AI Director text)', () => {
    const ladder = deriveLiveLadder({
      publisher: { mode: 'fixed_compositor', active: false },
      camera_edge: { camera_online: true, livestreaming: false },
      compositor: { available: false, scene: 'MBFD_CAMERA_ONLY' },
      capabilities: {
        peertube_configured: true,
        peertube_reachable: true,
        managed_receiver_online: true,
        obs_available: false,
        program_prepared: false,
        program_scene_safe: true,
        operator_start_allowed: false,
        publisher_mode: 'fixed_compositor',
        publisher_ready: false,
        last_error_code: null,
        last_error_message: null,
      },
    });
    assert.equal(ladder.canStart, false);
    assert.equal(ladder.reason, 'OBS compositor unavailable');
    assert.doesNotMatch(String(ladder.reason), /AI Director/i);
  });

  it('reports camera unavailable when camera edge is offline', () => {
    const ladder = deriveLiveLadder({
      publisher: { mode: 'direct_camera', active: false },
      camera_edge: { camera_online: false, livestreaming: false },
      capabilities: {
        peertube_configured: true,
        peertube_reachable: true,
        managed_receiver_online: true,
        obs_available: false,
        operator_start_allowed: false,
      },
    });
    assert.equal(ladder.canStart, false);
    assert.equal(ladder.reason, 'Camera unavailable');
  });

  it('reports direct publisher already active when the other path is publishing', () => {
    const ladder = deriveLiveLadder({
      publisher: { mode: 'fixed_compositor', active: false },
      camera_edge: { camera_online: true, livestreaming: true },
      capabilities: {
        peertube_configured: true,
        peertube_reachable: true,
        managed_receiver_online: true,
        obs_available: true,
        operator_start_allowed: false,
      },
    });
    assert.equal(ladder.canStart, false);
    assert.equal(ladder.reason, 'Direct publisher already active');
  });

  it('reports on air from director stream_active', () => {
    const ladder = deriveLiveLadder({
      ai_director: { data: { stream_active: true } },
    });
    assert.equal(ladder.state, LIVE_LADDER.ON_AIR);
    assert.equal(ladder.canStart, false);
  });

  it('formats errors without Request failed', () => {
    assert.notEqual(formatLiveFailure({ message: 'Request failed' }).toLowerCase(), 'request failed');
    assert.match(formatLiveFailure({ code: 'OBS_UNAVAILABLE', error: 'OBS down' }), /OBS/);
  });
});

describe('screenshot poller', () => {
  it('dedupes in-flight and exposes metrics', async () => {
    let calls = 0;
    const pending = [];
    const poller = createScreenshotPoller({
      minIntervalMs: 1,
      activeIntervalMs: 100000,
      backgroundIntervalMs: 100000,
      requestScreenshot: (id) => {
        calls += 1;
        return new Promise((resolve) => pending.push({ id, resolve }));
      },
      listVisibleIds: () => ['a', 'a', 'b'],
      isFresh: () => false,
      isRetired: () => false,
    });
    poller.requestIds(['a', 'a', 'b'], true);
    assert.equal(calls, 2);
    const m = getScreenshotPollMetrics();
    assert.ok(m.inFlightScreenshotRequests >= 1);
    pending.forEach((p) => p.resolve());
    await Promise.resolve();
    poller.stop();
  });
});
