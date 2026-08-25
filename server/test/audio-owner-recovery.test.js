'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  ensureAudioOwnershipAfterReconnect,
  recoverAudioOwnershipAfterLoss,
} = require('../lib/audio-owner-recovery');

function basePolicy(overrides = {}) {
  return {
    version: 1,
    output_device_id: 'tv1',
    owner_device_id: 'tv2',
    content_instance_id: 'instance-1',
    transaction_id: 'broadcast-1',
    generation: 8,
    revision: 100,
    source_key: 'content:known-audio',
    ...overrides,
  };
}

test('owner loss creates a fresh fenced transaction, persists it for all participants, and chooses stable failover', async () => {
  const devices = [
    { id: 'tv1', name: 'Classroom 1 - Front Left', playlist_id: 'p1' },
    { id: 'tv2', name: 'Classroom 1 - Front Center', playlist_id: 'p2' },
    { id: 'tv3', name: 'Classroom 1 - Front Right', playlist_id: 'p3' },
  ];
  const persisted = [];
  const emitted = [];
  const result = await recoverAudioOwnershipAfterLoss({
    lostDeviceId: 'tv2',
    listWorkspaceDevices: () => devices,
    getStoredPolicy: () => basePolicy(),
    isOnline: (deviceId) => deviceId !== 'tv2',
    fenceTargets: async ({ deviceIds, policy }) => ({
      ok: true,
      acknowledged_device_ids: deviceIds,
      failed_device_ids: [],
      offline_device_ids: [],
      committed_policy: policy,
    }),
    persistPolicy: (playlistId, policy) => { persisted.push({ playlistId, policy }); return true; },
    emitPolicyUpdate: (deviceId) => emitted.push(deviceId),
    persistedRevision: () => 100,
    now: () => 1_000,
    randomUUID: () => 'recovery-transaction',
  });

  assert.equal(result.recovered, true);
  assert.equal(result.policy.owner_device_id, 'tv1');
  assert.equal(result.policy.transaction_id, 'audio-recovery:recovery-transaction');
  assert.ok(result.policy.revision > 100);
  assert.deepEqual(persisted.map((entry) => entry.playlistId).sort(), ['p1', 'p2', 'p3']);
  assert.deepEqual(emitted.sort(), ['tv1', 'tv2', 'tv3']);
});

test('stale application heartbeat with a live old-owner socket fences that owner before failover', async () => {
  const devices = [
    { id: 'tv1', name: 'Classroom 1 - Front Left', playlist_id: 'p1' },
    { id: 'tv2', name: 'Classroom 1 - Front Center', playlist_id: 'p2' },
    { id: 'tv3', name: 'Classroom 1 - Front Right', playlist_id: 'p3' },
  ];
  let fencedDeviceIds = [];
  const result = await recoverAudioOwnershipAfterLoss({
    lostDeviceId: 'tv2',
    listWorkspaceDevices: () => devices,
    getStoredPolicy: () => basePolicy(),
    isOnline: () => true,
    fenceTargets: async ({ deviceIds, policy }) => {
      fencedDeviceIds = deviceIds;
      const oldOwnerAcknowledged = deviceIds.includes('tv2');
      return {
        ok: oldOwnerAcknowledged,
        acknowledged_device_ids: oldOwnerAcknowledged ? deviceIds : deviceIds.filter((id) => id !== 'tv2'),
        failed_device_ids: oldOwnerAcknowledged ? [] : ['tv2'],
        offline_device_ids: [],
        committed_policy: oldOwnerAcknowledged ? policy : { ...policy, owner_device_id: null },
      };
    },
    persistPolicy: () => true,
    emitPolicyUpdate: () => {},
    persistedRevision: () => 100,
    now: () => 1_000,
    randomUUID: () => 'stale-heartbeat-recovery',
  });

  assert.deepEqual(fencedDeviceIds, ['tv1', 'tv2', 'tv3']);
  assert.equal(result.recovered, true);
  assert.equal(result.policy.owner_device_id, 'tv1');
});

test('stale-heartbeat failover remains null-owned when the live old owner does not acknowledge mute', async () => {
  const devices = [
    { id: 'tv1', name: 'Classroom 1 - Front Left', playlist_id: 'p1' },
    { id: 'tv2', name: 'Classroom 1 - Front Center', playlist_id: 'p2' },
    { id: 'tv3', name: 'Classroom 1 - Front Right', playlist_id: 'p3' },
  ];
  let fencedDeviceIds = [];
  const persisted = [];
  const result = await recoverAudioOwnershipAfterLoss({
    lostDeviceId: 'tv2',
    listWorkspaceDevices: () => devices,
    getStoredPolicy: () => basePolicy(),
    isOnline: () => true,
    fenceTargets: async ({ deviceIds, policy }) => {
      fencedDeviceIds = deviceIds;
      return {
        ok: false,
        acknowledged_device_ids: deviceIds.filter((id) => id !== 'tv2'),
        failed_device_ids: ['tv2'],
        offline_device_ids: [],
        committed_policy: { ...policy, owner_device_id: null },
      };
    },
    persistPolicy: (playlistId, policy) => {
      persisted.push({ playlistId, policy });
      return true;
    },
    emitPolicyUpdate: () => {},
    persistedRevision: () => 100,
    now: () => 1_000,
    randomUUID: () => 'stale-heartbeat-failed-fence',
  });

  assert.deepEqual(fencedDeviceIds, ['tv1', 'tv2', 'tv3']);
  assert.equal(result.recovered, false);
  assert.equal(result.policy.owner_device_id, null);
  assert.ok(persisted.every((entry) => entry.policy.owner_device_id === null));
});

test('stale heartbeat with no replacement still fences a live old-owner socket fail-muted', async () => {
  const devices = [
    { id: 'tv2', name: 'Classroom 1 - Front Center', playlist_id: 'p2' },
  ];
  let fencedDeviceIds = [];
  const result = await recoverAudioOwnershipAfterLoss({
    lostDeviceId: 'tv2',
    listWorkspaceDevices: () => devices,
    getStoredPolicy: () => basePolicy(),
    isOnline: () => true,
    fenceTargets: async ({ deviceIds, policy }) => {
      fencedDeviceIds = deviceIds;
      return {
        ok: true,
        acknowledged_device_ids: deviceIds,
        failed_device_ids: [],
        offline_device_ids: [],
        committed_policy: policy,
      };
    },
    persistPolicy: () => true,
    emitPolicyUpdate: () => {},
    persistedRevision: () => 100,
    now: () => 1_000,
    randomUUID: () => 'stale-heartbeat-no-replacement',
  });

  assert.deepEqual(fencedDeviceIds, ['tv2']);
  assert.equal(result.recovered, false);
  assert.equal(result.reason, 'audio_recovery_failed_muted');
  assert.equal(result.policy.owner_device_id, null);
});

test('failed recovery fence persists a fresh null-owner policy so late owner messages cannot revive audio', async () => {
  const devices = [
    { id: 'tv2', name: 'Classroom 1 - Front Center', playlist_id: 'p2' },
    { id: 'tv3', name: 'Classroom 1 - Front Right', playlist_id: 'p3' },
  ];
  const persisted = [];
  const result = await recoverAudioOwnershipAfterLoss({
    lostDeviceId: 'tv2',
    listWorkspaceDevices: () => devices,
    getStoredPolicy: () => basePolicy(),
    isOnline: (deviceId) => deviceId === 'tv3',
    fenceTargets: async ({ policy }) => ({
      ok: false,
      acknowledged_device_ids: [], failed_device_ids: ['tv3'], offline_device_ids: [],
      committed_policy: { ...policy, owner_device_id: null },
    }),
    persistPolicy: (playlistId, policy) => { persisted.push({ playlistId, policy }); return true; },
    emitPolicyUpdate: () => {},
    persistedRevision: () => 100,
    now: () => 1_000,
    randomUUID: () => 'recovery-failed',
  });
  assert.equal(result.recovered, false);
  assert.equal(result.policy.owner_device_id, null);
  assert.ok(persisted.every((entry) => entry.policy.owner_device_id === null));
});

test('disconnect of a follower does not create a new ownership transaction', async () => {
  const result = await recoverAudioOwnershipAfterLoss({
    lostDeviceId: 'tv3',
    listWorkspaceDevices: () => [{ id: 'tv3', name: 'Classroom 1 - Front Right', playlist_id: 'p3' }],
    getStoredPolicy: () => basePolicy(),
    isOnline: () => false,
    persistPolicy: () => { throw new Error('must not persist'); },
    emitPolicyUpdate: () => {},
  });
  assert.deepEqual(result, { recovered: false, reason: 'lost_device_was_not_audio_owner' });
});

test('first renderer back after a whole-P3 restart recovers a durable null-owner policy', async () => {
  const devices = [
    { id: 'tv1', name: 'Classroom 1 - Front Left', playlist_id: 'p1' },
    { id: 'tv2', name: 'Classroom 1 - Front Center', playlist_id: 'p2' },
    { id: 'tv3', name: 'Classroom 1 - Front Right', playlist_id: 'p3' },
  ];
  const stored = basePolicy({ owner_device_id: null, transaction_id: 'audio-recovery:all-offline', revision: 101 });
  const persisted = [];
  const result = await ensureAudioOwnershipAfterReconnect({
    deviceId: 'tv3',
    listWorkspaceDevices: () => devices,
    getStoredPolicy: () => stored,
    isOnline: (deviceId) => deviceId === 'tv3',
    fenceTargets: async ({ deviceIds, policy }) => ({
      ok: true, acknowledged_device_ids: deviceIds, failed_device_ids: [], offline_device_ids: [],
      committed_policy: policy,
    }),
    persistPolicy: (playlistId, policy) => { persisted.push({ playlistId, policy }); return true; },
    emitPolicyUpdate: () => {},
    persistedRevision: () => 101,
    now: () => 1_001,
    randomUUID: () => 'restart-recovery',
  });
  assert.equal(result.recovered, true);
  assert.equal(result.policy.owner_device_id, 'tv3');
  assert.equal(result.policy.transaction_id, 'audio-recovery:restart-recovery');
  assert.ok(persisted.every((entry) => entry.policy.owner_device_id === 'tv3'));
});
