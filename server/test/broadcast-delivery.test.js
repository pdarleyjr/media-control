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

test('Mosaic delivery confirmation requires the exact region source state', () => {
  const { database, store } = fixture();
  try {
    const created = store.createRequest({
      workspaceId: 'classroom',
      userId: 'operator-1',
      sourceType: 'content',
      sourceId: 'image-left',
      typedTargets: [{
        type: 'wall-region',
        wall_id: 'mosaic',
        region_id: 'front-left',
        layout_revision: 44,
      }],
      targets: [{
        deviceId: 'front-center',
        expectedSourceId: 'image-left',
        regionId: 'front-left',
        zoneId: 'zone-front-left',
      }],
      expectedTargetCount: 1,
    });
    const target = created.devices[0];

    store.markDispatched({
      requestId: created.id,
      deviceId: target.device_id,
      commandId: target.command_id,
      delivered: true,
      playlistRevision: 'mosaic-r1',
    });
    const status = (playerState) => store.markPlayerStatus({
      requestId: created.id,
      deviceId: target.device_id,
      commandId: target.command_id,
      phase: 'confirmed',
      playlistRevision: 'mosaic-r1',
      rendererSessionId: 'renderer-mosaic',
      renderGeneration: 2,
      playerState,
    });

    assert.equal(status({ current_content_id: 'image-left' }).reason, 'region_state_missing');
    assert.equal(status({
      region_states: [{
        region_id: 'front-left',
        zone_id: 'zone-front-left',
        current_content_id: 'image-right',
      }],
    }).reason, 'source_mismatch');
    assert.equal(status({
      region_states: [{
        region_id: 'front-left',
        zone_id: 'zone-front-left',
        current_content_id: 'image-left',
        render_state: 'playing',
      }],
    }).applied, true);

    const confirmed = store.getRequest(created.id, 'classroom');
    assert.equal(confirmed.status, 'confirmed');
    assert.equal(confirmed.devices[0].region_id, 'front-left');
    assert.equal(confirmed.devices[0].zone_id, 'zone-front-left');
  } finally {
    database.close();
  }
});

test('one request can independently deliver and confirm two Mosaic regions on the same player', () => {
  const { database, store } = fixture();
  try {
    const created = store.createRequest({
      workspaceId: 'classroom',
      userId: 'operator-1',
      sourceType: 'content',
      sourceId: 'image-1',
      typedTargets: [
        { type: 'wall-region', wall_id: 'mosaic', region_id: 'left', layout_revision: 12 },
        { type: 'wall-region', wall_id: 'mosaic', region_id: 'right', layout_revision: 12 },
      ],
      targets: [
        {
          deviceId: 'front-center',
          expectedSourceId: 'image-1',
          regionId: 'left',
          zoneId: 'zone-left',
        },
        {
          deviceId: 'front-center',
          expectedSourceId: 'image-1',
          regionId: 'right',
          zoneId: 'zone-right',
        },
      ],
      expectedTargetCount: 2,
    });

    assert.equal(created.devices.length, 2);
    assert.deepEqual(created.devices.map((entry) => entry.region_id), ['left', 'right']);
    assert.equal(new Set(created.devices.map((entry) => entry.command_id)).size, 2);

    for (const [index, target] of created.devices.entries()) {
      const playlistRevision = `mosaic-r${index + 1}`;
      assert.equal(store.markDispatched({
        requestId: created.id,
        deviceId: target.device_id,
        commandId: target.command_id,
        delivered: true,
        playlistRevision,
      }).applied, true);
      assert.equal(store.markPlayerStatus({
        requestId: created.id,
        deviceId: target.device_id,
        commandId: target.command_id,
        phase: 'confirmed',
        playlistRevision,
        rendererSessionId: 'renderer-mosaic',
        renderGeneration: index + 1,
        playerState: {
          region_states: [{
            region_id: target.region_id,
            zone_id: target.zone_id,
            current_content_id: 'image-1',
            render_state: 'playing',
          }],
        },
      }).applied, true);
      assert.equal(
        store.getRequest(created.id, 'classroom').status,
        index === 0 ? 'in_progress' : 'confirmed',
      );
    }
  } finally {
    database.close();
  }
});

test('idempotency keys replay the original request and reject a different request fingerprint', () => {
  const { database, store } = fixture();
  try {
    const args = {
      workspaceId: 'classroom',
      userId: 'operator-1',
      sourceType: 'content',
      sourceId: 'image-1',
      typedTargets: [{ type: 'display', id: 'front-center' }],
      targets: [{ deviceId: 'front-center', expectedSourceId: 'image-1' }],
      idempotencyKey: 'operator-click-42', // gitleaks:allow - deterministic test-only value
      requestFingerprint: 'content:image-1:front-center',
    };
    const first = store.createRequest(args);
    const replay = store.createRequest(args);
    assert.equal(replay.id, first.id);
    assert.equal(replay.idempotent_replay, true);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM broadcast_requests').get().count, 1);

    assert.throws(
      () => store.createRequest({
        ...args,
        sourceId: 'image-2',
        requestFingerprint: 'content:image-2:front-center',
      }),
      (error) => error && error.code === 'IDEMPOTENCY_KEY_REUSED',
    );
  } finally {
    database.close();
  }
});

test('schema self-heal preserves existing delivery rows while upgrading to region target keys', () => {
  const database = new Database(':memory:');
  try {
    database.exec(`
      CREATE TABLE devices (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, name TEXT NOT NULL);
      INSERT INTO devices VALUES ('front-center', 'classroom', 'Front Center');
      CREATE TABLE broadcast_requests (
        id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, user_id TEXT,
        source_type TEXT NOT NULL, source_id TEXT NOT NULL,
        typed_targets_json TEXT NOT NULL DEFAULT '[]',
        resolved_target_ids_json TEXT NOT NULL DEFAULT '[]',
        expected_target_count INTEGER NOT NULL, status TEXT NOT NULL,
        created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, completed_at INTEGER
      );
      CREATE TABLE broadcast_device_results (
        request_id TEXT NOT NULL, device_id TEXT NOT NULL, device_name TEXT NOT NULL,
        ordinal INTEGER NOT NULL DEFAULT 0, command_id TEXT NOT NULL UNIQUE,
        expected_source_id TEXT, expected_playlist_revision TEXT, state TEXT NOT NULL,
        delivery_state TEXT NOT NULL, acknowledgment_state TEXT NOT NULL,
        confirmed_player_state_json TEXT, failure_reason TEXT,
        render_generation INTEGER, requested_at INTEGER NOT NULL,
        delivered_at INTEGER, acknowledged_at INTEGER, confirmed_at INTEGER,
        updated_at INTEGER NOT NULL, PRIMARY KEY (request_id, device_id)
      );
      INSERT INTO broadcast_requests VALUES (
        'request-old', 'classroom', 'operator-1', 'content', 'image-1',
        '[]', '["front-center"]', 1, 'requested', 1000, 9000, NULL
      );
      INSERT INTO broadcast_device_results VALUES (
        'request-old', 'front-center', 'Front Center', 0, 'command-old',
        'image-1', NULL, 'requested', 'requested', 'pending',
        NULL, NULL, NULL, 1000, NULL, NULL, NULL, 1000
      );
    `);
    const store = createBroadcastDeliveryStore(database, {
      now: () => 1_000,
      randomUUID: () => 'unused',
      timeoutMs: 8_000,
    });
    const primaryKey = database.prepare('PRAGMA table_info(broadcast_device_results)')
      .all()
      .filter((column) => column.pk > 0)
      .sort((left, right) => left.pk - right.pk)
      .map((column) => column.name);
    assert.deepEqual(primaryKey, ['request_id', 'target_key']);
    const migrated = store.getRequest('request-old', 'classroom');
    assert.equal(migrated.devices[0].target_key, 'front-center');
    assert.equal(migrated.devices[0].command_id, 'command-old');
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
