'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createTransportTransactionCoordinator } = require('../lib/transport-transaction');

function makeCoordinator({ displayStates = {}, audioAuthorityId = 'front-left' } = {}) {
  const devices = new Map([
    ['front-left', { id: 'front-left', workspace_id: 'ws-classroom' }],
    ['front-center', { id: 'front-center', workspace_id: 'ws-classroom' }],
    ['front-right', { id: 'front-right', workspace_id: 'ws-classroom' }],
  ]);
  const emitted = [];
  const queued = [];
  const persisted = [];
  let sequence = 0;
  const coordinator = createTransportTransactionCoordinator({
    getDevice: (id) => devices.get(id) || null,
    listWorkspaceDevices: () => [...devices.values()],
    getDisplayState: (deviceId) => displayStates[deviceId] || { current_content_id: 'c', current_asset_id: 'a', content_instance_id: 'i', generation: 1, state_revision: 1 },
    getLiveState: () => ({ configured: true, content_active: true, display_id: 'live-program' }),
    getRoomRevision: () => 1,
    getContentGeneration: () => 1,
    isDeviceOnline: () => true,
    emitToDevice: (deviceId, envelope) => emitted.push({ deviceId, envelope }),
    queueToDevice: (deviceId, envelope) => { queued.push({ deviceId, envelope }); return true; },
    ingestCommand: (values) => { persisted.push(values); return { command_id: values.command_id || `cmd-${++sequence}` }; },
    createCommand: (values) => ({ version: 1, type: 'device:command', command_id: values.command_id || `cmd-${++sequence}`, issued_at: '2026-08-20T21:00:00.000Z', device_id: values.device_id, target_scope: 'display', payload: { ...values.payload } }),
    resolveAudioAuthority: () => ({ valid: true, authority_device_id: audioAuthorityId }),
    randomUUID: () => `uuid-${++sequence}`,
    now: () => 1_000_000,
  });
  return { coordinator, emitted, byDevice: (store) => Object.fromEntries(store.map((e) => [e.deviceId, e.envelope.payload])) };
}

test('audio authority device is allowed while followers are force-muted', () => {
  const { coordinator, emitted, byDevice } = makeCoordinator();
  coordinator.dispatch({
    workspaceId: 'ws-classroom',
    deviceIds: ['front-left', 'front-center', 'front-right'],
    action: 'pause',
    payload: {},
    issuedBy: 'op',
    idempotencyKey: 'audio-auth-1',
  });
  const byDevicePayloads = byDevice(emitted);
  assert.equal(byDevicePayloads['front-left'].audio_allowed, true);
  assert.equal(byDevicePayloads['front-left'].force_muted, false);
  for (const follower of ['front-center', 'front-right']) {
    assert.equal(byDevicePayloads[follower].audio_allowed, false);
    assert.equal(byDevicePayloads[follower].force_muted, true);
  }
});

test('audio companion command binds each device to its own current generation', () => {
  const { coordinator, emitted, byDevice } = makeCoordinator({
    displayStates: {
      'front-left': { current_content_id: 'audio-a', current_asset_id: 'asset-a', content_instance_id: 'instance-A', generation: 61, state_revision: 61 },
      'front-center': { current_content_id: 'audio-a', current_asset_id: 'asset-a', content_instance_id: 'instance-A', generation: 62, state_revision: 62 },
    },
  });
  coordinator.dispatch({
    workspaceId: 'ws-classroom',
    deviceIds: ['front-left', 'front-center'],
    action: 'pause',
    payload: {},
    issuedBy: 'op',
    idempotencyKey: 'audio-gen-1',
  });
  const byDevicePayloads = byDevice(emitted);
  assert.equal(byDevicePayloads['front-left'].expected_generation, 61);
  assert.equal(byDevicePayloads['front-center'].expected_generation, 62);
});

test('stale audio companion generation on the authority device is bound exactly as supplied', () => {
  const { coordinator, emitted, byDevice } = makeCoordinator({
    displayStates: {
      'front-left': { current_content_id: 'audio-b', current_asset_id: 'asset-b', content_instance_id: 'instance-B', generation: 90, state_revision: 90 },
    },
  });
  coordinator.dispatch({
    workspaceId: 'ws-classroom',
    deviceIds: ['front-left'],
    action: 'play',
    payload: { expected_generation: 44 },
    issuedBy: 'op',
    idempotencyKey: 'audio-stale-1',
  });
  const payload = byDevice(emitted)['front-left'];
  assert.equal(payload.expected_generation, 44);
  assert.equal(payload.audio_allowed, true);
});
