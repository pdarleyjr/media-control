const { test } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');

const { createBroadcastDeliveryStore } = require('../lib/broadcast-delivery');

function fixture() {
  const database = new Database(':memory:');
  database.exec(`
    CREATE TABLE devices (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      name TEXT NOT NULL
    );
  `);
  const insert = database.prepare('INSERT INTO devices (id, workspace_id, name) VALUES (?, ?, ?)');
  insert.run('front-center', 'classroom', 'Front Center');
  insert.run('front-left', 'classroom', 'Front Left');
  insert.run('side-left', 'classroom', 'Side Left');
  let now = 1_000;
  let sequence = 0;
  const store = createBroadcastDeliveryStore(database, {
    now: () => now,
    randomUUID: () => `uuid-${++sequence}`,
    timeoutMs: 8_000,
  });
  return {
    database,
    store,
    setNow(value) { now = value; },
  };
}

test('a broadcast request persists its source, typed targets, resolved players, and per-device command IDs', () => {
  const { database, store } = fixture();
  try {
    const request = store.createRequest({
      workspaceId: 'classroom',
      userId: 'operator-1',
      sourceType: 'content',
      sourceId: 'image-1',
      typedTargets: [{ type: 'room', id: 'classroom' }],
      targets: [
        { deviceId: 'front-center', expectedSourceId: 'image-1' },
        { deviceId: 'front-left', expectedSourceId: 'image-1' },
      ],
      expectedTargetCount: 2,
    });

    assert.equal(request.id, 'uuid-1');
    assert.equal(request.status, 'requested');
    assert.deepEqual(request.typed_targets, [{ type: 'room', id: 'classroom' }]);
    assert.deepEqual(request.resolved_target_ids, ['front-center', 'front-left']);
    assert.equal(request.expected_target_count, 2);
    assert.deepEqual(
      request.devices.map((entry) => ({
        id: entry.device_id,
        name: entry.device_name,
        command: entry.command_id,
        state: entry.state,
        delivery: entry.delivery_state,
        ack: entry.acknowledgment_state,
      })),
      [
        {
          id: 'front-center',
          name: 'Front Center',
          command: 'uuid-2',
          state: 'requested',
          delivery: 'requested',
          ack: 'pending',
        },
        {
          id: 'front-left',
          name: 'Front Left',
          command: 'uuid-3',
          state: 'requested',
          delivery: 'requested',
          ack: 'pending',
        },
      ],
    );
  } finally {
    database.close();
  }
});

test('confirmation requires the authenticated player command and exact playlist revision', () => {
  const { database, store } = fixture();
  try {
    const created = store.createRequest({
      workspaceId: 'classroom',
      userId: 'operator-1',
      sourceType: 'content',
      sourceId: 'image-1',
      typedTargets: [{ type: 'display', id: 'front-center' }],
      targets: [{ deviceId: 'front-center', expectedSourceId: 'image-1' }],
      expectedTargetCount: 1,
    });
    const target = created.devices[0];

    store.markDispatched({
      requestId: created.id,
      deviceId: target.device_id,
      commandId: target.command_id,
      delivered: true,
      playlistRevision: 'playlist-r1',
    });
    assert.equal(store.getRequest(created.id, 'classroom').devices[0].state, 'delivered');

    assert.equal(store.markPlayerStatus({
      requestId: created.id,
      deviceId: target.device_id,
      commandId: 'wrong-command',
      phase: 'acknowledged',
      playlistRevision: 'playlist-r1',
    }).applied, false);

    assert.equal(store.markPlayerStatus({
      requestId: created.id,
      deviceId: target.device_id,
      commandId: target.command_id,
      phase: 'acknowledged',
      playlistRevision: 'playlist-r1',
      rendererSessionId: 'renderer-a',
    }).applied, true);
    assert.equal(store.getRequest(created.id, 'classroom').devices[0].state, 'acknowledged');

    assert.equal(store.markPlayerStatus({
      requestId: created.id,
      deviceId: target.device_id,
      commandId: target.command_id,
      phase: 'confirmed',
      playlistRevision: 'playlist-r2',
      rendererSessionId: 'renderer-a',
      renderGeneration: 4,
      playerState: { current_content_id: 'image-1', render_state: 'playing' },
    }).applied, false);

    assert.equal(store.markPlayerStatus({
      requestId: created.id,
      deviceId: target.device_id,
      commandId: target.command_id,
      phase: 'confirmed',
      playlistRevision: 'playlist-r1',
      rendererSessionId: 'renderer-a',
      renderGeneration: 4,
      playerState: { current_content_id: 'different-image', render_state: 'playing' },
    }).applied, false);

    assert.equal(store.markPlayerStatus({
      requestId: created.id,
      deviceId: target.device_id,
      commandId: target.command_id,
      phase: 'confirmed',
      playlistRevision: 'playlist-r1',
      rendererSessionId: 'renderer-a',
      renderGeneration: 4,
      playerState: { current_content_id: 'image-1', render_state: 'playing' },
    }).applied, true);

    const confirmed = store.getRequest(created.id, 'classroom');
    assert.equal(confirmed.status, 'confirmed');
    assert.equal(confirmed.devices[0].state, 'confirmed');
    assert.equal(confirmed.devices[0].acknowledgment_state, 'confirmed');
    assert.equal(confirmed.devices[0].render_generation, 4);
    assert.deepEqual(confirmed.devices[0].confirmed_player_state, {
      current_content_id: 'image-1',
      render_state: 'playing',
    });
  } finally {
    database.close();
  }
});

test('offline, failed, and expired devices remain explicit instead of becoming HTTP success', () => {
  const { database, store, setNow } = fixture();
  try {
    const created = store.createRequest({
      workspaceId: 'classroom',
      userId: 'operator-1',
      sourceType: 'playlist',
      sourceId: 'playlist-1',
      typedTargets: [{ type: 'wall', id: 'front-wall', revision: 7 }],
      targets: [
        { deviceId: 'front-center' },
        { deviceId: 'front-left' },
        { deviceId: 'side-left' },
      ],
      expectedTargetCount: 3,
    });
    const [center, left, side] = created.devices;
    store.markDispatched({
      requestId: created.id,
      deviceId: center.device_id,
      commandId: center.command_id,
      delivered: true,
      playlistRevision: 'center-r1',
    });
    store.markDispatched({
      requestId: created.id,
      deviceId: left.device_id,
      commandId: left.command_id,
      queued: true,
    });
    store.markDispatched({
      requestId: created.id,
      deviceId: side.device_id,
      commandId: side.command_id,
      failureReason: 'playlist mutation failed',
    });

    let status = store.getRequest(created.id, 'classroom');
    assert.deepEqual(status.devices.map((entry) => entry.state), ['delivered', 'offline', 'failed']);
    assert.equal(status.status, 'in_progress');

    setNow(9_001);
    store.sweepExpired();
    status = store.getRequest(created.id, 'classroom');
    assert.deepEqual(status.devices.map((entry) => entry.state), ['timed_out', 'timed_out', 'failed']);
    assert.equal(status.status, 'failed');
    assert.match(status.devices[0].failure_reason, /timed out/i);
  } finally {
    database.close();
  }
});
