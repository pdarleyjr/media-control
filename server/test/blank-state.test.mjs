import test from 'node:test';
import assert from 'node:assert/strict';

import {
  BLANK_STATES,
  blankPresentation,
  createBlankIntentTracker,
  deriveBlankState,
} from '../../frontend/js/views/media-control/blank-state.js';

const display = (id, screenOn, extra = {}) => ({
  id,
  online: true,
  screen_on: screenOn,
  state_revision: 1,
  ...extra,
});

test('wall model distinguishes on, blanked, mixed, and unknown', () => {
  assert.equal(deriveBlankState(['a', 'b'], [display('a', true), display('b', true)]).state, BLANK_STATES.ON);
  assert.equal(deriveBlankState(['a', 'b'], [display('a', false), display('b', false)]).state, BLANK_STATES.BLANKED);
  assert.equal(deriveBlankState(['a', 'b'], [display('a', true), display('b', false)]).state, BLANK_STATES.MIXED);
  assert.equal(deriveBlankState(['a', 'b'], [display('a', true), display('b', null)]).state, BLANK_STATES.UNKNOWN);
});

test('wall model distinguishes partial/offline and error states', () => {
  assert.equal(
    deriveBlankState(['a', 'b'], [display('a', true), display('b', true, { online: false })]).state,
    BLANK_STATES.PARTIAL_OFFLINE,
  );
  assert.equal(
    deriveBlankState(['a'], [display('a', true, { error_state: 'renderer_failed' })]).state,
    BLANK_STATES.ERROR,
  );
});

test('pending intent remains distinct from confirmed display state', () => {
  const tracker = createBlankIntentTracker({ now: () => 1000, timeoutMs: 8000 });
  tracker.begin('a', 'off-1', false);
  tracker.begin('b', 'off-2', false);
  const result = deriveBlankState(
    ['a', 'b'],
    [display('a', true), display('b', true)],
    tracker.pending(),
    1000,
  );
  assert.equal(result.state, BLANK_STATES.PENDING_BLANK);
  assert.equal(result.confirmed, false);
});

test('scope-aware presentation separates status from deterministic action', () => {
  assert.deepEqual(blankPresentation(BLANK_STATES.ON, 'wall'), {
    statusKey: 'mc.blank.status.on', actionKey: 'mc.blank.action.blank_wall', desiredScreenOn: false, disabled: false,
  });
  assert.deepEqual(blankPresentation(BLANK_STATES.BLANKED, 'display'), {
    statusKey: 'mc.blank.status.blanked', actionKey: 'mc.blank.action.unblank_display', desiredScreenOn: true, disabled: false,
  });
  assert.equal(blankPresentation(BLANK_STATES.ON, 'room').actionKey, 'mc.blank.action.blank_room');
  assert.equal(blankPresentation(BLANK_STATES.BLANKED, 'room').actionKey, 'mc.blank.action.unblank_room');
  assert.equal(blankPresentation(BLANK_STATES.MIXED, 'wall').desiredScreenOn, true);
  assert.equal(blankPresentation(BLANK_STATES.UNKNOWN, 'wall').desiredScreenOn, true);
  assert.equal(blankPresentation(BLANK_STATES.PENDING_ON, 'wall').disabled, true);
});

test('late out-of-order ACK cannot settle a newer intent', () => {
  const tracker = createBlankIntentTracker({ now: () => 1000, timeoutMs: 8000 });
  tracker.begin('a', 'off-1', false);
  tracker.begin('a', 'on-2', true);
  assert.equal(tracker.acceptAck({ command_id: 'off-1', target_id: 'a', ok: true, state: { screen_on: false } }).accepted, false);
  assert.equal(tracker.pendingFor('a').commandId, 'on-2');
  assert.equal(tracker.acceptAck({ command_id: 'on-2', target_id: 'a', ok: true, state: { screen_on: true } }).confirmed, true);
  assert.equal(tracker.pendingFor('a'), null);
});

test('ACK without matching actual state stays pending', () => {
  const tracker = createBlankIntentTracker({ now: () => 1000, timeoutMs: 8000 });
  tracker.begin('a', 'off-1', false);
  const receipt = tracker.acceptAck({ command_id: 'off-1', target_id: 'a', ok: true, state: { screen_on: true } });
  assert.equal(receipt.accepted, true);
  assert.equal(receipt.confirmed, false);
  assert.equal(tracker.pendingFor('a').phase, 'acknowledged');
});

test('dropped ACK expires into a visible error instead of false success', () => {
  let now = 1000;
  const tracker = createBlankIntentTracker({ now: () => now, timeoutMs: 8000 });
  tracker.begin('a', 'off-1', false);
  now = 9001;
  tracker.expire();
  assert.equal(tracker.pendingFor('a').phase, 'error');
  assert.equal(
    deriveBlankState(['a'], [display('a', true)], tracker.pending(), now).state,
    BLANK_STATES.ERROR,
  );
});

test('state report can confirm a command when its ACK was dropped', () => {
  const tracker = createBlankIntentTracker({ now: () => 1000, timeoutMs: 8000 });
  tracker.begin('a', 'off-1', false);
  tracker.reconcile([display('a', false, { command_revision: 'off-1', state_revision: 4 })]);
  assert.equal(tracker.pendingFor('a'), null);
});

test('reconnect confirmation clears a queued pending command', () => {
  const tracker = createBlankIntentTracker({ now: () => 1000, timeoutMs: 8000 });
  tracker.begin('a', 'on-3', true);
  tracker.markDelivery('on-3', { queued: true, delivered: false });
  assert.equal(tracker.pendingFor('a').phase, 'queued');
  tracker.reconcile([display('a', true, { command_revision: 'on-3', state_revision: 9 })]);
  assert.equal(tracker.pendingFor('a'), null);
});

test('route unmount resets pending blank intent', () => {
  const tracker = createBlankIntentTracker({ now: () => 1000, timeoutMs: 8000 });
  tracker.begin('a', 'off-1', false);
  assert.equal(tracker.pending().length, 1);
  tracker.reset();
  assert.deepEqual(tracker.pending(), []);
});
