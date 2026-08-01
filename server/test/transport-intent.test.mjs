import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveTransportIntent } from '../../frontend/js/views/media-control/transport-intent.js';

test('presentation next and previous become absolute, verifiable slide commands', () => {
  const playback = {
    kind: 'document',
    slideIndex: 2,
    slideCount: 51,
  };

  assert.deepEqual(resolveTransportIntent('next', playback), {
    action: 'go_to_slide',
    payload: { slide: 3 },
    noOp: false,
  });
  assert.deepEqual(resolveTransportIntent('prev', playback), {
    action: 'go_to_slide',
    payload: { slide: 1 },
    noOp: false,
  });
  assert.deepEqual(resolveTransportIntent('restart', playback), {
    action: 'go_to_slide',
    payload: { slide: 1 },
    noOp: false,
  });
});

test('presentation boundaries are no-ops instead of duplicate relative commands', () => {
  assert.deepEqual(
    resolveTransportIntent('prev', {
      kind: 'pdf',
      slide_index: 1,
      slide_count: 10,
    }),
    { action: 'go_to_slide', payload: { slide: 1 }, noOp: true },
  );
  assert.deepEqual(
    resolveTransportIntent('next', {
      kind: 'document',
      slide_index: 10,
      slide_count: 10,
    }),
    { action: 'go_to_slide', payload: { slide: 10 }, noOp: true },
  );
});

test('video play, pause, restart, and next keep their explicit transport meaning', () => {
  const playback = { kind: 'video', paused: false };
  for (const action of ['play', 'pause', 'restart', 'next']) {
    assert.deepEqual(resolveTransportIntent(action, playback), {
      action,
      payload: {},
      noOp: false,
    });
  }
});

test('presentation intent safely falls back when authoritative slide state is unavailable', () => {
  assert.deepEqual(
    resolveTransportIntent('next', { kind: 'document' }),
    { action: 'next', payload: {}, noOp: false },
  );
});
