const { test } = require('node:test');
const assert = require('node:assert/strict');
const { resolveBroadcastTargets, resolveTypedBroadcastTargets } = require('../lib/broadcast-targets');

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

function makeTopologyDb({ devices = {}, walls = {}, wallMembers = {}, groups = {}, groupMembers = {} }) {
  return {
    prepare(sql) {
      if (/FROM video_walls WHERE id = \?/.test(sql)) {
        return { get: (id) => walls[id] || null };
      }
      if (/FROM device_groups WHERE id = \?/.test(sql)) {
        return { get: (id) => groups[id] || null };
      }
      if (/FROM video_wall_devices vwd/.test(sql)) {
        return { all: (wallId) => (wallMembers[wallId] || []).map((id) => ({ device_id: id, workspace_id: devices[id]?.workspace_id })) };
      }
      if (/FROM device_group_members dgm/.test(sql)) {
        return { all: (groupId) => (groupMembers[groupId] || []).map((id) => ({ device_id: id, workspace_id: devices[id]?.workspace_id })) };
      }
      if (/SELECT id, workspace_id FROM devices WHERE id = \?/.test(sql)) {
        return { get: (id) => devices[id] || null };
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    },
  };
}

test('typed targets resolve current display, wall, device-group, and wall-group membership once with de-duplication', () => {
  const db = makeTopologyDb({
    devices: {
      d1: { id: 'd1', workspace_id: 'ws1' },
      d2: { id: 'd2', workspace_id: 'ws1' },
      d3: { id: 'd3', workspace_id: 'ws1' },
    },
    walls: {
      wall1: {
        id: 'wall1', workspace_id: 'ws1', layout_revision: 8,
        layout_json: JSON.stringify({ groups: [
          { id: 'left', member_ids: ['d1'] },
          { id: 'right', member_ids: ['d2', 'd3'] },
        ] }),
      },
    },
    wallMembers: { wall1: ['d1', 'd2', 'd3'] },
    groups: { operators: { id: 'operators', workspace_id: 'ws1' } },
    groupMembers: { operators: ['d1', 'd3'] },
  });

  const result = resolveTypedBroadcastTargets({
    db,
    workspaceId: 'ws1',
    refs: [
      { type: 'display', id: 'd1' },
      { type: 'wall', id: 'wall1', layout_revision: 8 },
      { type: 'group', id: 'operators' },
      { type: 'wall-group', wall_id: 'wall1', group_id: 'right', layout_revision: 8 },
    ],
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.targets, ['d1', 'd2', 'd3']);
});

test('typed wall targets reject stale revisions with a conflict before returning any membership', () => {
  const db = makeTopologyDb({
    devices: { current: { id: 'current', workspace_id: 'ws1' } },
    walls: { wall1: { id: 'wall1', workspace_id: 'ws1', layout_revision: 9, layout_json: '{"groups":[]}' } },
    wallMembers: { wall1: ['current'] },
  });

  const result = resolveTypedBroadcastTargets({
    db,
    workspaceId: 'ws1',
    refs: [{ type: 'wall', id: 'wall1', layout_revision: 8 }],
  });

  assert.equal(result.ok, false);
  assert.equal(result.status, 409);
  assert.equal(result.body.code, 'LAYOUT_REVISION_CONFLICT');
  assert.equal(result.body.current_revision, 9);
  assert.deepEqual(result.targets, []);
});

test('typed wall targets require an explicit revision even when the current revision is zero', () => {
  const db = makeTopologyDb({
    devices: { current: { id: 'current', workspace_id: 'ws1' } },
    walls: { wall1: { id: 'wall1', workspace_id: 'ws1', layout_revision: 0, layout_json: '{"groups":[]}' } },
    wallMembers: { wall1: ['current'] },
  });

  const result = resolveTypedBroadcastTargets({
    db,
    workspaceId: 'ws1',
    refs: [{ type: 'wall', id: 'wall1', layout_revision: null }],
  });

  assert.equal(result.ok, false);
  assert.equal(result.status, 409);
  assert.equal(result.body.code, 'LAYOUT_REVISION_CONFLICT');
  assert.equal(result.body.expected_revision, null);
  assert.equal(result.body.current_revision, 0);
});

test('typed wall-group targets ignore client membership and never reuse members removed from the current layout', () => {
  const db = makeTopologyDb({
    devices: {
      old: { id: 'old', workspace_id: 'ws1' },
      current: { id: 'current', workspace_id: 'ws1' },
    },
    walls: {
      wall1: {
        id: 'wall1', workspace_id: 'ws1', layout_revision: 4,
        layout_json: JSON.stringify({ groups: [{ id: 'focus', member_ids: ['current'] }] }),
      },
    },
    wallMembers: { wall1: ['current'] },
  });

  const result = resolveTypedBroadcastTargets({
    db,
    workspaceId: 'ws1',
    refs: [{
      type: 'wall-group', wall_id: 'wall1', group_id: 'focus', layout_revision: 4,
      member_ids: ['old'],
    }],
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.targets, ['current']);
  assert.equal(result.targets.includes('old'), false);
});

test('typed wall-group targets reject missing current topology as a layout conflict', () => {
  const db = makeTopologyDb({
    walls: { wall1: { id: 'wall1', workspace_id: 'ws1', layout_revision: 4, layout_json: null } },
    wallMembers: { wall1: [] },
  });

  const result = resolveTypedBroadcastTargets({
    db,
    workspaceId: 'ws1',
    refs: [{ type: 'wall-group', wall_id: 'wall1', group_id: 'gone', layout_revision: 4 }],
  });

  assert.equal(result.ok, false);
  assert.equal(result.status, 409);
  assert.equal(result.body.code, 'LAYOUT_REVISION_CONFLICT');
});

test('typed wall-group targets reject a stored layout that omits a current wall member', () => {
  const db = makeTopologyDb({
    devices: {
      d1: { id: 'd1', workspace_id: 'ws1' },
      newlyAdded: { id: 'newlyAdded', workspace_id: 'ws1' },
    },
    walls: {
      wall1: {
        id: 'wall1', workspace_id: 'ws1', layout_revision: 5,
        layout_json: JSON.stringify({ revision: 5, groups: [{ id: 'focus', member_ids: ['d1'] }] }),
      },
    },
    wallMembers: { wall1: ['d1', 'newlyAdded'] },
  });

  const result = resolveTypedBroadcastTargets({
    db,
    workspaceId: 'ws1',
    refs: [{ type: 'wall-group', wall_id: 'wall1', group_id: 'focus', layout_revision: 5 }],
  });

  assert.equal(result.ok, false);
  assert.equal(result.status, 409);
  assert.equal(result.body.code, 'LAYOUT_REVISION_CONFLICT');
  assert.deepEqual(result.targets, []);
});

test('typed mixed selections fail closed when one display reference is missing', () => {
  const db = makeTopologyDb({
    devices: { current: { id: 'current', workspace_id: 'ws1' } },
  });

  const result = resolveTypedBroadcastTargets({
    db,
    workspaceId: 'ws1',
    refs: [
      { type: 'display', id: 'current' },
      { type: 'display', id: 'removed' },
    ],
  });

  assert.equal(result.ok, false);
  assert.equal(result.status, 404);
  assert.equal(result.body.code, 'TARGET_NOT_FOUND');
  assert.deepEqual(result.targets, []);
});

test('typed missing device-group references fail closed', () => {
  const result = resolveTypedBroadcastTargets({
    db: makeTopologyDb({}),
    workspaceId: 'ws1',
    refs: [{ type: 'group', id: 'removed-group' }],
  });

  assert.equal(result.ok, false);
  assert.equal(result.status, 404);
  assert.equal(result.body.code, 'TARGET_NOT_FOUND');
  assert.deepEqual(result.targets, []);
});

test('typed empty device groups reject as incomplete topology before broadcast', () => {
  const db = makeTopologyDb({
    groups: { empty: { id: 'empty', workspace_id: 'ws1' } },
    groupMembers: { empty: [] },
  });

  const result = resolveTypedBroadcastTargets({
    db,
    workspaceId: 'ws1',
    refs: [{ type: 'group', id: 'empty' }],
  });

  assert.equal(result.ok, false);
  assert.equal(result.status, 409);
  assert.equal(result.body.code, 'TOPOLOGY_CONFLICT');
  assert.deepEqual(result.targets, []);
});
