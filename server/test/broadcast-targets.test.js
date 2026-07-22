const { test } = require('node:test');
const assert = require('node:assert/strict');
const { resolveBroadcastTargets } = require('../lib/broadcast-targets');

function makeDb(devices) {
  return {
    prepare(sql) {
      assert.match(sql, /SELECT id, workspace_id FROM devices WHERE id = \?/);
      return { get: (id) => devices[id] || null };
    },
  };
}

test('resolveBroadcastTargets skips stale missing device ids and keeps valid targets', () => {
  const db = makeDb({
    d1: { id: 'd1', workspace_id: 'ws1' },
    d2: { id: 'd2', workspace_id: 'ws1' },
  });

  const result = resolveBroadcastTargets({
    db,
    requestedIds: ['missing-old-device', 'd1', 'd1', 'd2'],
    workspaceId: 'ws1',
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.requested, ['missing-old-device', 'd1', 'd2']);
  assert.deepEqual(result.targets, ['d1', 'd2']);
  assert.deepEqual(result.missing, ['missing-old-device']);
});

test('resolveBroadcastTargets rejects foreign workspace targets', () => {
  const db = makeDb({ foreign: { id: 'foreign', workspace_id: 'other' } });

  const result = resolveBroadcastTargets({
    db,
    requestedIds: ['foreign'],
    workspaceId: 'ws1',
  });

  assert.equal(result.ok, false);
  assert.equal(result.status, 403);
  assert.match(result.body.error, /not in this workspace/);
});

test('resolveBroadcastTargets fails clearly when every target is stale', () => {
  const result = resolveBroadcastTargets({
    db: makeDb({}),
    requestedIds: ['old-a', 'old-b'],
    workspaceId: 'ws1',
  });

  assert.equal(result.ok, false);
  assert.equal(result.status, 404);
  assert.equal(result.body.error, 'No valid target devices found');
  assert.deepEqual(result.body.missing, ['old-a', 'old-b']);
});

test('managed live-program targets require the explicit include-live-stream gate', () => {
  const liveId = 'live-stream-program-abc123';
  const db = makeDb({
    d1: { id: 'd1', workspace_id: 'ws1' },
    [liveId]: { id: liveId, workspace_id: 'ws1' },
  });

  const blocked = resolveBroadcastTargets({
    db,
    requestedIds: ['d1', liveId],
    workspaceId: 'ws1',
  });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.status, 400);
  assert.equal(blocked.body.code, 'LIVE_STREAM_CONFIRMATION_REQUIRED');

  const allowed = resolveBroadcastTargets({
    db,
    requestedIds: ['d1', liveId],
    workspaceId: 'ws1',
    allowLiveStream: true,
  });
  assert.equal(allowed.ok, true);
  assert.deepEqual(allowed.targets, ['d1', liveId]);
});
