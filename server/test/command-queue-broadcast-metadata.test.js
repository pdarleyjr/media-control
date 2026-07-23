const { afterEach, test } = require('node:test');
const assert = require('node:assert/strict');

const commandQueue = require('../lib/command-queue');

function namespace(onlineIds = []) {
  const emitted = [];
  return {
    emitted,
    adapter: {
      rooms: new Map(onlineIds.map((id) => [id, new Set([`socket-${id}`])])),
    },
    to(deviceId) {
      return {
        emit(event, payload) {
          emitted.push({ deviceId, event, payload });
        },
      };
    },
  };
}

afterEach(() => commandQueue._resetForTests());

test('online playlist delivery builds metadata before emit and returns its exact revision', () => {
  const deviceNs = namespace(['front-center']);
  const context = { requestId: 'request-1', commandId: 'command-1' };
  const prepared = [];
  const build = (deviceId, delivery) => {
    prepared.push({ deviceId, delivery });
    return {
      playlist_revision: 'revision-1',
      broadcast_delivery: {
        request_id: delivery.requestId,
        command_id: delivery.commandId,
        expected_source_id: 'content-1',
      },
    };
  };

  const result = commandQueue.queueOrEmitPlaylistUpdate(
    deviceNs,
    'front-center',
    build,
    context,
  );
  assert.equal(result.delivered, true);
  assert.equal(result.playlistRevision, 'revision-1');
  assert.deepEqual(prepared, [{ deviceId: 'front-center', delivery: context }]);
  assert.equal(deviceNs.emitted.length, 1);
  assert.equal(deviceNs.emitted[0].payload.broadcast_delivery.command_id, 'command-1');
});

test('offline replay retains the latest request metadata and rebuilds the payload on reconnect', () => {
  const deviceNs = namespace();
  const builds = [];
  const build = (deviceId, delivery) => {
    builds.push({ deviceId, delivery });
    return {
      playlist_revision: `revision-${delivery.commandId}`,
      broadcast_delivery: {
        request_id: delivery.requestId,
        command_id: delivery.commandId,
      },
    };
  };

  const first = commandQueue.queueOrEmitPlaylistUpdate(deviceNs, 'front-left', build, {
    requestId: 'request-1',
    commandId: 'command-1',
  });
  const second = commandQueue.queueOrEmitPlaylistUpdate(deviceNs, 'front-left', build, {
    requestId: 'request-2',
    commandId: 'command-2',
  });
  assert.equal(first.queued, true);
  assert.equal(second.queued, true);
  assert.equal(commandQueue.getQueueDepth('front-left'), 1);

  deviceNs.adapter.rooms.set('front-left', new Set(['socket-front-left']));
  const flushed = commandQueue.flushQueue(deviceNs, 'front-left', build);
  assert.equal(flushed.playlistUpdate, true);
  assert.equal(deviceNs.emitted.length, 1);
  assert.equal(deviceNs.emitted[0].payload.broadcast_delivery.request_id, 'request-2');
  assert.equal(deviceNs.emitted[0].payload.broadcast_delivery.command_id, 'command-2');
  assert.equal(commandQueue.getQueueDepth('front-left'), 0);
  assert.equal(builds.length, 3, 'both offline preparations plus one reconnect rebuild');
});
