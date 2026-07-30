const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');

const { createBroadcastDeliveryStore } = require('../lib/broadcast-delivery');

const CLASSROOM_DISPLAYS = [
  ['front-left', 'Classroom 1 - Front Left'],
  ['front-center', 'Classroom 1 - Front Center'],
  ['front-right', 'Classroom 1 - Front Right'],
  ['side-left', 'Classroom 1 - Side Left'],
  ['side-right', 'Classroom 1 - Side Right'],
];

test('unchanged-content render confirmation has no display or wall-one restriction', () => {
  const player = fs.readFileSync(
    path.join(__dirname, '..', 'player', 'index.html'),
    'utf8',
  );
  const unchanged = player.slice(
    player.indexOf('if (newFp === oldFp'),
    player.indexOf("console.log('Playlist changed, updating')"),
  );

  assert.match(
    unchanged,
    /^if \(newFp === oldFp && playlist\.length > 0 && !wallChanged\)/,
  );
  assert.match(
    unchanged,
    /bindPendingBroadcastToRender\(\);\s*scheduleCurrentRenderConfirmation\(\)/,
  );
  assert.doesNotMatch(
    unchanged,
    /front[-_ ]?(?:left|center|right)|side[-_ ]?(?:left|right)|wall[_ -]?1|deviceId/i,
  );
});

test('one unchanged-content delivery request confirms independently for all five classroom displays', () => {
  const database = new Database(':memory:');
  try {
    database.exec(`
      CREATE TABLE devices (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        name TEXT NOT NULL
      );
    `);
    const insert = database.prepare(
      'INSERT INTO devices (id, workspace_id, name) VALUES (?, ?, ?)',
    );
    for (const [id, name] of CLASSROOM_DISPLAYS) {
      insert.run(id, 'classroom', name);
    }

    let sequence = 0;
    const store = createBroadcastDeliveryStore(database, {
      now: () => 1_000,
      randomUUID: () => `all-displays-${++sequence}`,
      timeoutMs: 8_000,
    });
    const created = store.createRequest({
      workspaceId: 'classroom',
      userId: 'operator-1',
      sourceType: 'content',
      sourceId: 'already-visible-content',
      typedTargets: [
        { type: 'wall', id: 'front-wall', revision: 112 },
        { type: 'wall', id: 'side-wall', revision: 112 },
      ],
      targets: CLASSROOM_DISPLAYS.map(([deviceId]) => ({
        deviceId,
        expectedSourceId: 'already-visible-content',
      })),
      expectedTargetCount: CLASSROOM_DISPLAYS.length,
    });

    assert.deepEqual(
      created.devices.map((entry) => entry.device_id),
      CLASSROOM_DISPLAYS.map(([deviceId]) => deviceId),
    );

    for (const [index, target] of created.devices.entries()) {
      const playlistRevision = `unchanged-playlist-${index + 1}`;
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
        phase: 'acknowledged',
        playlistRevision,
        rendererSessionId: `renderer-${target.device_id}`,
      }).applied, true);
      assert.equal(store.markPlayerStatus({
        requestId: created.id,
        deviceId: target.device_id,
        commandId: target.command_id,
        phase: 'confirmed',
        playlistRevision,
        rendererSessionId: `renderer-${target.device_id}`,
        renderGeneration: index + 1,
        playerState: {
          current_content_id: 'already-visible-content',
          render_state: 'playing',
        },
      }).applied, true);
    }

    const status = store.getRequest(created.id, 'classroom');
    assert.equal(status.status, 'confirmed');
    assert.equal(status.expected_target_count, 5);
    assert.deepEqual(
      status.devices.map((entry) => [entry.device_id, entry.state]),
      CLASSROOM_DISPLAYS.map(([deviceId]) => [deviceId, 'confirmed']),
    );
  } finally {
    database.close();
  }
});
