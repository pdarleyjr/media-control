'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  EXPLICIT_SYNCHRONIZED_ACTIONS,
  createLiveTransportMirror,
} = require('../lib/transport-transaction');

const root = path.join(__dirname, '..', '..');
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), 'utf8');

function command({
  action = 'pause',
  transactionId = 'tx-shared-1',
  targetCount = 5,
  payload = {},
} = {}) {
  return {
    version: 1,
    type: 'device:command',
    command_id: `source-${Math.random()}`,
    issued_at: new Date().toISOString(),
    device_id: 'display-a',
    target_scope: 'display',
    payload: {
      action,
      transport_transaction_id: transactionId,
      idempotency_key: transactionId,
      transaction_target_count: targetCount,
      mirror_to_live_program: true,
      ...payload,
    },
  };
}

function fixture({ contentActive = true, liveOnline = true } = {}) {
  const persisted = [];
  const emitted = [];
  const queued = [];
  const marked = [];
  const mirror = createLiveTransportMirror({
    lookupWorkspace: () => 'workspace-a',
    getProgramState: () => ({
      content_active: typeof contentActive === 'function' ? contentActive() : contentActive,
    }),
    getLiveDeviceId: () => 'live-stream-program-a',
    markContentChanged: (id) => marked.push(id),
    persistCommand: (input) => {
      persisted.push(input);
      return { command_id: `live-command-${persisted.length}` };
    },
    isDeviceOnline: () => liveOnline,
    emitCommand: (deviceId, envelope) => emitted.push({ deviceId, envelope }),
    queueCommand: (deviceId, envelope) => {
      queued.push({ deviceId, envelope });
      return true;
    },
    now: () => 10_000,
  });
  return { mirror, persisted, emitted, queued, marked };
}

test('synchronized transport vocabulary contains only explicit presentation/video actions', () => {
  assert.deepEqual(
    [...EXPLICIT_SYNCHRONIZED_ACTIONS].sort(),
    ['go_to_slide', 'next', 'pause', 'play', 'prev', 'restart', 'seek', 'stop'].sort(),
  );
  assert.equal(EXPLICIT_SYNCHRONIZED_ACTIONS.has('play_pause'), false);
});

test('one shared transaction mirrors to Live Program exactly once across all classroom targets', () => {
  const f = fixture();
  const first = f.mirror.dispatch({
    sourceDeviceId: 'display-a',
    envelope: command(),
    userId: 'operator-a',
  });
  const second = f.mirror.dispatch({
    sourceDeviceId: 'display-b',
    envelope: command(),
    userId: 'operator-a',
  });

  assert.equal(first.included, true);
  assert.equal(first.owner, true);
  assert.equal(first.command_id, 'live-command-1');
  assert.equal(first.device_id, 'live-stream-program-a');
  assert.equal(first.transaction_id, 'tx-shared-1');
  assert.equal(first.target_count, 5);
  assert.equal(first.delivered, true);
  assert.equal(second.included, true);
  assert.equal(second.owner, false);
  assert.equal(second.deduplicated, true);
  assert.equal(second.command_id, 'live-command-1');
  assert.equal(f.persisted.length, 1);
  assert.equal(f.emitted.length, 1);
  assert.equal(f.queued.length, 0);
  assert.deepEqual(f.marked, ['live-stream-program-a']);
});

test('reusing a transport idempotency key for a different action is rejected', () => {
  const f = fixture();
  const first = f.mirror.dispatch({
    sourceDeviceId: 'display-a',
    envelope: command({ action: 'pause' }),
    userId: 'operator-a',
  });
  const conflict = f.mirror.dispatch({
    sourceDeviceId: 'display-b',
    envelope: command({ action: 'play' }),
    userId: 'operator-a',
  });

  assert.equal(first.included, true);
  assert.deepEqual(conflict, {
    included: false,
    reason: 'transport_idempotency_conflict',
    transaction_id: 'tx-shared-1',
  });
  assert.equal(f.persisted.length, 1);
  assert.equal(f.emitted.length, 1);
});

test('mirrored command preserves one idempotency key and strips classroom-audio controls', () => {
  const f = fixture();
  f.mirror.dispatch({
    sourceDeviceId: 'display-a',
    envelope: command({
      action: 'seek',
      payload: {
        seconds: 42,
        audio_enabled: true,
        muted: false,
        volume: 1,
        audio_device_id: 'front-left-earc',
      },
    }),
    userId: 'operator-a',
  });

  assert.equal(f.persisted[0].payload.transport_transaction_id, 'tx-shared-1');
  assert.equal(f.persisted[0].payload.idempotency_key, 'tx-shared-1');
  assert.equal(f.persisted[0].payload.seconds, 42);
  assert.equal(f.persisted[0].payload.audio_enabled, undefined);
  assert.equal(f.persisted[0].payload.muted, undefined);
  assert.equal(f.persisted[0].payload.volume, undefined);
  assert.equal(f.persisted[0].payload.audio_device_id, undefined);
  assert.equal(f.emitted[0].envelope.payload.audio_enabled, undefined);
});

test('Live Program is not mirrored without an active routed source', () => {
  const f = fixture({ contentActive: false });
  const result = f.mirror.dispatch({
    sourceDeviceId: 'display-a',
    envelope: command(),
    userId: 'operator-a',
  });

  assert.deepEqual(result, {
    included: false,
    reason: 'live_content_inactive',
    transaction_id: 'tx-shared-1',
  });
  assert.equal(f.persisted.length, 0);
  assert.equal(f.emitted.length, 0);
  assert.equal(f.queued.length, 0);
});

test('clearing Live Program stops every future mirror even for a new transaction', () => {
  let contentActive = true;
  const f = fixture({ contentActive: () => contentActive });
  const first = f.mirror.dispatch({
    sourceDeviceId: 'display-a',
    envelope: command({ transactionId: 'tx-before-clear' }),
    userId: 'operator-a',
  });
  contentActive = false;
  const afterClear = f.mirror.dispatch({
    sourceDeviceId: 'display-a',
    envelope: command({ transactionId: 'tx-after-clear' }),
    userId: 'operator-a',
  });

  assert.equal(first.included, true);
  assert.equal(afterClear.included, false);
  assert.equal(afterClear.reason, 'live_content_inactive');
  assert.equal(f.persisted.length, 1);
});

test('ambiguous play_pause and missing transaction keys never reach Live Program', () => {
  const f = fixture();
  const toggle = f.mirror.dispatch({
    sourceDeviceId: 'display-a',
    envelope: command({ action: 'play_pause' }),
    userId: 'operator-a',
  });
  const missing = f.mirror.dispatch({
    sourceDeviceId: 'display-a',
    envelope: command({ transactionId: '' }),
    userId: 'operator-a',
  });

  assert.equal(toggle.included, false);
  assert.equal(toggle.reason, 'ambiguous_or_unsupported_action');
  assert.equal(missing.included, false);
  assert.equal(missing.reason, 'missing_transport_transaction');
  assert.equal(f.persisted.length, 0);
});

test('offline Live Program is queued once and reported as not yet delivered', () => {
  const f = fixture({ liveOnline: false });
  const result = f.mirror.dispatch({
    sourceDeviceId: 'display-a',
    envelope: command(),
    userId: 'operator-a',
  });

  assert.equal(result.included, true);
  assert.equal(result.owner, true);
  assert.equal(result.delivered, false);
  assert.equal(result.queued, true);
  assert.equal(f.emitted.length, 0);
  assert.equal(f.queued.length, 1);
});

test('Live Program persistence failure is contained and never emits an untracked command', () => {
  const f = fixture();
  f.mirror = createLiveTransportMirror({
    lookupWorkspace: () => 'workspace-a',
    getProgramState: () => ({ content_active: true }),
    getLiveDeviceId: () => 'live-stream-program-a',
    persistCommand: () => { throw new Error('database unavailable'); },
    isDeviceOnline: () => true,
    emitCommand: (deviceId, envelope) => f.emitted.push({ deviceId, envelope }),
    queueCommand: (deviceId, envelope) => {
      f.queued.push({ deviceId, envelope });
      return true;
    },
  });
  const result = f.mirror.dispatch({
    sourceDeviceId: 'display-a',
    envelope: command(),
    userId: 'operator-a',
  });

  assert.equal(result.included, false);
  assert.equal(result.reason, 'live_command_persistence_failed');
  assert.equal(f.emitted.length, 0);
  assert.equal(f.queued.length, 0);
});

test('controller sends one workspace transaction and awaits physical plus Live Program confirmations', () => {
  const transport = read('frontend/js/views/media-control/transport.js');
  const main = read('frontend/js/views/media-control.js');
  const dashboard = read('server/ws/dashboardSocket.js');

  assert.match(transport, /export function sendWorkspaceTransportTransaction/);
  assert.match(transport, /const transactionId = opts\.transactionId \|\| createTransportTransactionId\(\)/);
  assert.match(transport, /dashboard:transport-transaction/);
  assert.match(transport, /Promise\.all\(\(ack\.targets \|\| \[\]\)\.map/);
  assert.match(transport, /idempotency_key: transactionId/);
  assert.match(transport, /physical_confirmations/);
  assert.match(transport, /live_confirmation/);
  assert.match(transport, /awaitCommandConfirmation/);
  assert.match(main, /dispatchTransportTransaction\(/);
  assert.doesNotMatch(main, /ids\.forEach\(id => sendCommand\(id, COMMAND_TYPES\.TRANSPORT/);
  assert.match(dashboard, /dashboard:transport-transaction/);
});
