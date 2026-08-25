'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  audioPolicyCanReplaceAssignments,
  audioPolicyHeartbeatDecision,
  buildAudioPolicy,
  nextAudioPolicyRevision,
  orderedRendererDeviceIds,
  policyForDevice,
  resolveDeterministicAudioOwner,
} = require('../lib/audio-ownership');

function storedAssignment(policy) {
  return {
    id: `assignment-${policy.revision}`,
    content_instance_id: policy.content_instance_id,
    audio_policy: policy,
  };
}

test('classroom renderer order is physical TV1-TV5 order, not request or alphabetical order', () => {
  assert.deepEqual(orderedRendererDeviceIds([
    { id: 'tv5', name: 'Classroom 1 - Side Right' },
    { id: 'tv2', name: 'Classroom 1 - Front Center' },
    { id: 'tv1', name: 'Classroom 1 - Front Left' },
    { id: 'tv4', name: 'Classroom 1 - Side Left' },
    { id: 'tv3', name: 'Classroom 1 - Front Right' },
  ]), ['tv1', 'tv2', 'tv3', 'tv4', 'tv5']);
});

test('owner resolution prefers TV1 when targeted, otherwise uses stable physical order', () => {
  const orderedDeviceIds = ['tv1', 'tv2', 'tv3', 'tv4', 'tv5'];
  assert.equal(resolveDeterministicAudioOwner({
    targetDeviceIds: ['tv3', 'tv1', 'tv2'],
    preferredDeviceId: 'tv1',
    orderedDeviceIds,
    onlineDeviceIds: orderedDeviceIds,
  }), 'tv1');
  assert.equal(resolveDeterministicAudioOwner({
    targetDeviceIds: ['tv5', 'tv4'],
    preferredDeviceId: 'tv1',
    orderedDeviceIds,
    onlineDeviceIds: orderedDeviceIds,
  }), 'tv4');
});

test('TV1-TV5 solo routes and both classroom walls each select exactly one stable renderer', () => {
  const order = ['tv1', 'tv2', 'tv3', 'tv4', 'tv5'];
  for (const deviceId of order) {
    assert.equal(resolveDeterministicAudioOwner({
      targetDeviceIds: [deviceId],
      preferredDeviceId: 'tv1',
      orderedDeviceIds: order,
      onlineDeviceIds: [deviceId],
    }), deviceId);
  }
  assert.equal(resolveDeterministicAudioOwner({
    targetDeviceIds: ['tv3', 'tv1', 'tv2'],
    preferredDeviceId: 'tv1',
    orderedDeviceIds: order,
    onlineDeviceIds: order,
  }), 'tv1', 'Primary wall prefers TV1');
  assert.equal(resolveDeterministicAudioOwner({
    targetDeviceIds: ['tv5', 'tv4'],
    preferredDeviceId: 'tv1',
    orderedDeviceIds: order,
    onlineDeviceIds: order,
  }), 'tv4', 'Secondary wall uses physical order when TV1 is absent');
});

test('owner resolution ignores request order, fails over online, and fails muted when all targets are offline', () => {
  const options = {
    preferredDeviceId: 'tv1',
    orderedDeviceIds: ['tv1', 'tv2', 'tv3', 'tv4', 'tv5'],
  };
  assert.equal(resolveDeterministicAudioOwner({
    ...options,
    targetDeviceIds: ['tv5', 'tv3', 'tv2'],
    onlineDeviceIds: ['tv2', 'tv3', 'tv5'],
  }), 'tv2');
  assert.equal(resolveDeterministicAudioOwner({
    ...options,
    targetDeviceIds: ['tv1', 'tv2', 'tv3'],
    onlineDeviceIds: ['tv2', 'tv3'],
  }), 'tv2');
  assert.equal(resolveDeterministicAudioOwner({
    ...options,
    targetDeviceIds: ['tv5', 'tv4'],
    onlineDeviceIds: [],
  }), null);
});

test('audio policy separates the renderer owner from the fixed TV1/eARC output identity', () => {
  assert.deepEqual(buildAudioPolicy({
    outputDeviceId: 'tv1',
    ownerDeviceId: 'tv5',
    contentInstanceId: 'broadcast-1',
    transactionId: 'broadcast-1',
    generation: 9,
    revision: 1_000,
  }), {
    version: 1,
    output_device_id: 'tv1',
    owner_device_id: 'tv5',
    content_instance_id: 'broadcast-1',
    transaction_id: 'broadcast-1',
    generation: 9,
    revision: 1_000,
  });
});

test('server never derives a renderer grant from an incomplete ownership epoch', () => {
  for (const invalid of [
    { generation: 0 },
    { generation: 1.5 },
    { revision: 0 },
    { transactionId: null },
    { contentInstanceId: null },
    { outputDeviceId: null },
  ]) {
    assert.equal(policyForDevice(buildAudioPolicy({
      outputDeviceId: 'tv1',
      ownerDeviceId: 'tv2',
      contentInstanceId: 'broadcast-1',
      transactionId: 'broadcast-1',
      generation: 9,
      revision: 1_000,
      ...invalid,
    }), 'tv2'), null);
  }
});

test('audio revision is monotonic across same-millisecond calls and a restored future snapshot', () => {
  const clock = () => 1_700_000_000_000;
  const first = nextAudioPolicyRevision({ now: clock, persistedRevision: 1_700_000_000_000_100 });
  const second = nextAudioPolicyRevision({ now: clock, persistedRevision: first });
  assert.ok(first > 1_700_000_000_000_100);
  assert.ok(second > first);
});

test('an ambiguous mixed snapshot cannot be replaced by a stale or equal ownership revision', () => {
  const base = {
    outputDeviceId: 'tv1',
    ownerDeviceId: 'tv2',
    contentInstanceId: 'instance-current',
    generation: 8,
    sourceKey: 'content:audio',
  };
  const assignments = [
    storedAssignment(buildAudioPolicy({ ...base, transactionId: 'transaction-900', revision: 900 })),
    storedAssignment(buildAudioPolicy({ ...base, transactionId: 'transaction-901', revision: 901 })),
  ];
  assert.equal(audioPolicyCanReplaceAssignments(assignments, buildAudioPolicy({
    ...base,
    transactionId: 'late-transaction',
    revision: 900,
  })), false);
  assert.equal(audioPolicyCanReplaceAssignments(assignments, buildAudioPolicy({
    ...base,
    transactionId: 'recovery-transaction',
    revision: 902,
  })), true);
});

test('heartbeat comparison clamps stale, conflicting, or unexpectedly unmuted renderers', () => {
  const common = buildAudioPolicy({
    outputDeviceId: 'tv1',
    ownerDeviceId: 'tv2',
    contentInstanceId: 'instance-1',
    transactionId: 'transaction-1',
    generation: 12,
    revision: 500,
    sourceKey: 'content:known-audio',
  });
  const owner = policyForDevice(common, 'tv2', 'playlist-500');
  const follower = policyForDevice(common, 'tv3', 'playlist-500');

  assert.deepEqual(audioPolicyHeartbeatDecision(owner, {
    transaction_id: 'transaction-1', content_instance_id: 'instance-1', revision: 500,
    generation: 12, playlist_revision: 'playlist-500', audio_allowed: true, muted: false,
  }), { clamp: false, reason: null });
  assert.deepEqual(audioPolicyHeartbeatDecision(follower, {
    transaction_id: 'transaction-1', content_instance_id: 'instance-1', revision: 500,
    generation: 12, playlist_revision: 'playlist-500', audio_allowed: false, muted: false,
  }), { clamp: true, reason: 'renderer_unmuted_without_authority' });
  assert.deepEqual(audioPolicyHeartbeatDecision(owner, {
    transaction_id: 'old', content_instance_id: 'instance-1', revision: 499,
    generation: 11, playlist_revision: 'playlist-500', audio_allowed: true, muted: false,
  }), { clamp: true, reason: 'audio_policy_identity_mismatch' });
  assert.deepEqual(audioPolicyHeartbeatDecision(owner, {
    transaction_id: 'transaction-1', content_instance_id: 'instance-1', revision: 500,
    generation: 11, playlist_revision: 'playlist-500', audio_allowed: true, muted: false,
  }), { clamp: true, reason: 'audio_policy_identity_mismatch' });
  assert.deepEqual(audioPolicyHeartbeatDecision(owner, {
    transaction_id: 'transaction-1', content_instance_id: 'different-instance', revision: 500,
    generation: 12, playlist_revision: 'playlist-500', audio_allowed: true, muted: false,
  }), { clamp: true, reason: 'audio_policy_identity_mismatch' });
  assert.deepEqual(audioPolicyHeartbeatDecision(owner, {
    transaction_id: 'transaction-1', content_instance_id: 'instance-1', revision: 500,
    generation: 12, playlist_revision: 'old-playlist', audio_allowed: true, muted: false,
  }), { clamp: true, reason: 'audio_policy_identity_mismatch' });
  assert.deepEqual(audioPolicyHeartbeatDecision(null, {
    transaction_id: 'transaction-1', revision: 500, audio_allowed: true, muted: false,
  }), { clamp: true, reason: 'authoritative_audio_policy_missing' });
});
