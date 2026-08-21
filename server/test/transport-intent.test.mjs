import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createTransportIntentTracker,
  resolveTransportIntent,
} from '../../frontend/js/views/media-control/transport-intent.js';

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

test('rapid presentation clicks only advance as far as authoritative state permits', () => {
  const tracker = createTransportIntentTracker();
  const playback = {
    kind: 'document',
    contentId: 'deck-1',
    slideIndex: 1,
    slideCount: 51,
  };

  // Until the player confirms, authoritative slideIndex stays at 1, so every
  // click resolves to the same idempotent go_to_slide 2 target. The UI must
  // NOT manufacture slide 3/4 from a local optimistic cursor.
  const first = tracker.resolve('wall-1:deck-1', 'next', playback);
  const second = tracker.resolve('wall-1:deck-1', 'next', playback);
  const third = tracker.resolve('wall-1:deck-1', 'next', playback);
  const back = tracker.resolve('wall-1:deck-1', 'prev', playback);

  assert.deepEqual(first.payload, { slide: 2 });
  assert.deepEqual(second.payload, { slide: 2 });
  assert.deepEqual(third.payload, { slide: 2 });
  assert.deepEqual(back.payload, { slide: 1 });
  assert.ok(first.sequence < second.sequence && second.sequence < third.sequence);
});

test('rapid play pause clicks resolve from authoritative paused state, not a local guess', () => {
  const tracker = createTransportIntentTracker();
  const playback = { kind: 'video', contentId: 'video-1', paused: false };

  const pause = tracker.resolve('display-1:video-1', 'play_pause', playback);
  const play = tracker.resolve('display-1:video-1', 'play_pause', playback);
  const pauseAgain = tracker.resolve('display-1:video-1', 'play_pause', playback);

  // Authoritative paused is false for every call until the player reports back,
  // so each play_pause resolves to 'pause'. No optimistic flip to 'play'.
  assert.equal(pause.action, 'pause');
  assert.equal(play.action, 'pause');
  assert.equal(pauseAgain.action, 'pause');
});

test('a failed command is forgotten and the next intent uses authoritative state', () => {
  const tracker = createTransportIntentTracker();
  const playback = { kind: 'document', contentId: 'deck-1', slideIndex: 5, slideCount: 51 };

  const first = tracker.resolve('wall-1:deck-1', 'next', playback);
  const second = tracker.resolve('wall-1:deck-1', 'next', playback);

  assert.equal(tracker.settle('wall-1:deck-1', first.sequence, { ok: false }), false);
  assert.deepEqual(tracker.resolve('wall-1:deck-1', 'next', playback).payload, { slide: 6 });
  assert.equal(tracker.settle('wall-1:deck-1', second.sequence, { ok: false }), false);
});

test('a successful intent does not manufacture extra advance on a stale repaint', () => {
  const tracker = createTransportIntentTracker();
  const stalePlayback = {
    kind: 'document', contentId: 'deck-1', slideIndex: 10, slideCount: 51,
  };

  const first = tracker.resolve('wall-1:deck-1', 'next', stalePlayback);
  assert.equal(tracker.settle('wall-1:deck-1', first.sequence, { ok: true }), true);

  // The stale authoritative state still reports slide 10, so the next click is
  // slide 11, not 12. No optimistic carry-forward from the previous intent.
  const second = tracker.resolve('wall-1:deck-1', 'next', stalePlayback);
  assert.deepEqual(second.payload, { slide: 11 });
});

test('the latest failed intent falls back to authoritative state', () => {
  const tracker = createTransportIntentTracker();
  const playback = {
    kind: 'document', contentId: 'deck-1', slideIndex: 10, slideCount: 51,
  };

  const failed = tracker.resolve('wall-1:deck-1', 'next', playback);
  assert.equal(tracker.settle('wall-1:deck-1', failed.sequence, { ok: false }), true);

  const retry = tracker.resolve('wall-1:deck-1', 'next', playback);
  assert.deepEqual(retry.payload, { slide: 11 });
});

test('out-of-order confirmations are ignored', () => {
  const tracker = createTransportIntentTracker();
  const playback = { kind: 'document', contentId: 'deck-1', slideIndex: 3, slideCount: 51 };

  const a = tracker.resolve('wall-1:deck-1', 'next', playback);
  const b = tracker.resolve('wall-1:deck-1', 'next', playback);
  // Confirming the older intent after a newer one exists must be ignored.
  assert.equal(tracker.settle('wall-1:deck-1', a.sequence, { ok: true }), false);
  assert.equal(tracker.settle('wall-1:deck-1', b.sequence, { ok: true }), true);
});
