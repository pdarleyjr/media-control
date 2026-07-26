'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createLiveProgramReceiver } = require('../lib/live-program-receiver');

function harness({ confirmedInstance = 'instance-a', confirmed = true } = {}) {
  const calls = [];
  let requestStatus = 'requested';
  const request = {
    id: 'delivery-a',
    devices: [{ device_id: 'live-display-a', command_id: 'command-a' }],
  };
  const deliveryStore = {
    createRequest(input) {
      calls.push(['delivery.create', input.sourceId, input.idempotencyKey]);
      return request;
    },
    markDispatched(input) {
      calls.push(['delivery.dispatched', input.playlistRevision]);
      requestStatus = confirmed ? 'confirmed' : 'failed';
    },
    getRequest() {
      return {
        ...request,
        status: requestStatus,
        devices: [{
          device_id: 'live-display-a',
          command_id: 'command-a',
          state: requestStatus,
          playlist_revision: 'playlist-a',
          render_generation: 9,
          confirmed_player_state: {
            current_content_id: 'content-a',
            content_instance_id: confirmedInstance,
            render_state: requestStatus === 'confirmed' ? 'playing' : 'error',
          },
        }],
      };
    },
  };
  const receiver = createLiveProgramReceiver({
    database: {},
    deliveryStore,
    ensureDisplay: () => ({
      id: 'live-display-a',
      workspace_id: 'workspace-a',
      status: 'online',
    }),
    sceneEngine: {
      pushSourceToDevice(_io, deviceId, source, options) {
        calls.push([
          'receiver.assign',
          deviceId,
          source.content_id,
          source.content_instance_id,
          options.delivery.requestId,
        ]);
        return {
          ok: true,
          delivered: true,
          queued: false,
          playlistRevision: 'playlist-a',
          expectedSourceId: 'content-a',
        };
      },
    },
    markContentChanged: (deviceId) => calls.push(['receiver.changed', deviceId]),
    wait: async () => {},
    confirmTimeoutMs: 20,
  });
  return { calls, receiver };
}

test('receiver assignment binds delivery to exact content instance and rendered revision', async () => {
  const { calls, receiver } = harness();
  const result = await receiver.assignContent({
    workspaceId: 'workspace-a',
    userId: 'user-a',
    source: { type: 'content', contentId: 'content-a' },
    contentInstanceId: 'instance-a',
    requestId: 'composition-a',
    io: {},
  });
  assert.equal(result.confirmed, true);
  assert.equal(result.contentId, 'content-a');
  assert.equal(result.contentInstanceId, 'instance-a');
  assert.equal(result.playlistRevision, 'playlist-a');
  assert.equal(result.renderGeneration, 9);
  assert.deepEqual(calls, [
    ['delivery.create', 'content-a', 'composition-a'],
    ['receiver.assign', 'live-display-a', 'content-a', 'instance-a', 'delivery-a'],
    ['delivery.dispatched', 'playlist-a'],
    ['receiver.changed', 'live-display-a'],
  ]);
});

test('receiver rejects a confirmation for another content instance', async () => {
  const { receiver } = harness({ confirmedInstance: 'instance-old' });
  await assert.rejects(
    () => receiver.assignContent({
      workspaceId: 'workspace-a',
      userId: 'user-a',
      source: { type: 'content', contentId: 'content-a' },
      contentInstanceId: 'instance-a',
      requestId: 'composition-a',
      io: {},
    }),
    (error) => error && error.code === 'RECEIVER_CONTENT_INSTANCE_MISMATCH',
  );
});

function receiverForControl({ displayState, audioAcknowledgements, audioError } = {}) {
  const database = {
    prepare(sql) {
      return {
        get() {
          if (sql.includes('SELECT playlist_id')) return { playlist_id: null };
          if (sql.includes('FROM display_states')) return displayState;
          return null;
        },
      };
    },
  };
  const receiver = createLiveProgramReceiver({
    database,
    deliveryStore: {},
    ensureDisplay: () => ({ id: 'live-display-a' }),
    sceneEngine: {},
    markContentChanged: () => {},
    wait: () => new Promise((resolve) => setTimeout(resolve, 1)),
    confirmTimeoutMs: 10,
  });
  const namespace = {
    timeout() { return this; },
    to() { return this; },
    emit(_event, _payload, callback) {
      callback(audioError || null, audioAcknowledgements);
    },
  };
  return {
    receiver,
    io: { of: () => namespace },
  };
}

test('clear confirmation fails closed when the authoritative display state is missing', async () => {
  const { receiver } = receiverForControl({ displayState: undefined });
  await assert.rejects(
    () => receiver.clearContent({
      workspaceId: 'workspace-a',
      contentInstanceId: 'instance-a',
      io: null,
    }),
    (error) => error && error.code === 'RECEIVER_CLEAR_TIMEOUT',
  );
});

test('clear confirmation requires an existing idle, cleared, non-error state', async () => {
  const { receiver } = receiverForControl({
    displayState: {
      current_content_id: null,
      render_state: 'idle',
      error_state: null,
    },
  });
  const result = await receiver.clearContent({
    workspaceId: 'workspace-a',
    contentInstanceId: 'instance-a',
    io: null,
  });
  assert.equal(result.confirmed, true);
  assert.equal(result.cleared, true);
});

test('audio policy requires an exact receiver policy and revision acknowledgement', async () => {
  const { receiver, io } = receiverForControl({
    audioAcknowledgements: [{
      ok: true,
      policy: 'content_replace',
      revision: 12,
    }],
  });
  const result = await receiver.setAudioPolicy('content_replace', {
    workspaceId: 'workspace-a',
    io,
    revision: 12,
  });
  assert.equal(result.confirmed, true);
  assert.equal(result.revision, 12);
});

test('audio policy fails closed on timeout or mismatched acknowledgement', async () => {
  const timedOut = receiverForControl({ audioError: new Error('timeout') });
  await assert.rejects(
    () => timedOut.receiver.setAudioPolicy('camera', {
      workspaceId: 'workspace-a',
      io: timedOut.io,
      revision: 7,
    }),
    (error) => error && error.code === 'RECEIVER_AUDIO_POLICY_TIMEOUT',
  );

  const mismatched = receiverForControl({
    audioAcknowledgements: [{ ok: true, policy: 'camera', revision: 6 }],
  });
  await assert.rejects(
    () => mismatched.receiver.setAudioPolicy('camera', {
      workspaceId: 'workspace-a',
      io: mismatched.io,
      revision: 7,
    }),
    (error) => error && error.code === 'RECEIVER_AUDIO_POLICY_MISMATCH',
  );
});
