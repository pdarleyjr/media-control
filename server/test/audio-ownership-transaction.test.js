'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  fenceAudioOwnershipTargets,
} = require('../lib/audio-ownership-transaction');

function namespaceWithAcks(acksByDevice, events) {
  return {
    adapter: {
      rooms: new Map(Object.keys(acksByDevice).map((deviceId) => [deviceId, new Set([`socket-${deviceId}`])])),
    },
    to(deviceId) {
      return {
        timeout() { return this; },
        emit(event, payload, acknowledge) {
          events.push({ deviceId, event, payload });
          const configured = acksByDevice[deviceId];
          if (configured instanceof Error) acknowledge(configured, []);
          else {
            const responses = Array.isArray(configured)
              ? configured.map((response) => (typeof response === 'function' ? response(payload) : response))
              : [typeof configured === 'function' ? configured(payload) : configured];
            acknowledge(null, responses);
          }
        },
      };
    },
  };
}

function policy(overrides = {}) {
  return {
    version: 1,
    output_device_id: 'tv1',
    owner_device_id: 'tv2',
    content_instance_id: 'broadcast-2',
    transaction_id: 'broadcast-2',
    generation: 9,
    revision: 900,
    source_key: 'content:known-good-audio',
    ...overrides,
  };
}

function matchingAck(deviceId) {
  return (payload) => ({
    ok: true,
    muted: true,
    host_muted: true,
    device_id: deviceId,
    renderer_session_id: `session-${deviceId}`,
    transaction_id: payload.audio_policy.transaction_id,
    revision: payload.audio_policy.revision,
    generation: payload.audio_policy.generation,
    phase: 'muted',
  });
}

test('every online participant acknowledges the exact mute fence before owner grant can commit', async () => {
  const events = [];
  const result = await fenceAudioOwnershipTargets(namespaceWithAcks({
    tv1: matchingAck('tv1'),
    tv2: matchingAck('tv2'),
    tv3: matchingAck('tv3'),
  }, events), {
    deviceIds: ['tv3', 'tv1', 'tv2'],
    policy: policy(),
    timeoutMs: 25,
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.acknowledged_device_ids.sort(), ['tv1', 'tv2', 'tv3']);
  assert.equal(events.length, 3);
  assert.ok(events.every((entry) => entry.event === 'device:audio-policy-fence'));
  assert.ok(events.every((entry) => entry.payload.audio_policy.owner_device_id === null));
  assert.ok(events.every((entry) => entry.payload.pending_owner_device_id === 'tv2'));
});

test('a timeout, unmuted response, or late prior-generation acknowledgement fails closed', async () => {
  for (const badAck of [
    new Error('timeout'),
    { ok: true, muted: false, device_id: 'tv3', transaction_id: 'broadcast-2', revision: 900, phase: 'muted' },
    { ok: true, muted: true, device_id: 'tv3', transaction_id: 'broadcast-old', revision: 899, phase: 'muted' },
    { ok: true, muted: true, device_id: 'tv3', renderer_session_id: 'session-tv3', transaction_id: 'broadcast-2', revision: 900, generation: 8, phase: 'muted' },
  ]) {
    const events = [];
    const result = await fenceAudioOwnershipTargets(namespaceWithAcks({
      tv2: matchingAck('tv2'),
      tv3: badAck,
    }, events), {
      deviceIds: ['tv2', 'tv3'],
      policy: policy(),
      timeoutMs: 25,
    });
    assert.equal(result.ok, false);
    assert.equal(result.committed_policy.owner_device_id, null);
    assert.ok(result.failed_device_ids.includes('tv3'));
  }
});

test('a local-media ACK without verified Electron host mute fails closed', async () => {
  const result = await fenceAudioOwnershipTargets(namespaceWithAcks({
    tv2: (payload) => ({
      ...matchingAck('tv2')(payload),
      host_muted: undefined,
    }),
  }, []), {
    deviceIds: ['tv2'],
    policy: policy(),
    timeoutMs: 25,
  });

  assert.equal(result.ok, false);
  assert.equal(result.committed_policy.owner_device_id, null);
  assert.deepEqual(result.failed_device_ids, ['tv2']);
});

test('a malformed non-positive fence epoch cannot commit an owner even with a matching ACK', async () => {
  const result = await fenceAudioOwnershipTargets(namespaceWithAcks({
    tv2: matchingAck('tv2'),
  }, []), {
    deviceIds: ['tv2'],
    policy: policy({ generation: 0 }),
    timeoutMs: 25,
  });

  assert.equal(result.ok, false);
  assert.equal(result.committed_policy.owner_device_id, null);
});

test('offline participants are reported and cannot accidentally receive an owner grant', async () => {
  const namespace = namespaceWithAcks({ tv2: matchingAck('tv2') }, []);
  const result = await fenceAudioOwnershipTargets(namespace, {
    deviceIds: ['tv2', 'tv4'],
    policy: policy(),
    timeoutMs: 25,
  });
  assert.equal(result.ok, false);
  assert.equal(result.committed_policy.owner_device_id, null);
  assert.deepEqual(result.offline_device_ids, ['tv4']);
});

test('every socket in a reconnect-overlap device room must acknowledge muted', async () => {
  const events = [];
  const namespace = namespaceWithAcks({
    tv2: [
      matchingAck('tv2'),
      {
        ok: true,
        muted: false,
        phase: 'muted',
        device_id: 'tv2',
        renderer_session_id: 'stale-session-tv2',
        transaction_id: 'broadcast-2',
        revision: 900,
        generation: 9,
      },
    ],
  }, events);
  namespace.adapter.rooms.set('tv2', new Set(['socket-tv2-old', 'socket-tv2-new']));

  const result = await fenceAudioOwnershipTargets(namespace, {
    deviceIds: ['tv2'],
    policy: policy(),
    timeoutMs: 25,
  });

  assert.equal(result.ok, false);
  assert.equal(result.committed_policy.owner_device_id, null);
  assert.deepEqual(result.failed_device_ids, ['tv2']);
});
