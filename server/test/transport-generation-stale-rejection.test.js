'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createTransportTransactionCoordinator } = require('../lib/transport-transaction');

const PHYSICAL_DEVICES = [
  { id: 'front-left', name: 'Front Left', workspace_id: 'ws-classroom' },
  { id: 'front-center', name: 'Front Center', workspace_id: 'ws-classroom' },
  { id: 'front-right', name: 'Front Right', workspace_id: 'ws-classroom' },
  { id: 'side-left', name: 'Side Left', workspace_id: 'ws-classroom' },
  { id: 'side-right', name: 'Side Right', workspace_id: 'ws-classroom' },
];

function makeCoordinator({ displayStates = {}, online = true, audioAuthorityId = 'front-left' } = {}) {
  const devices = new Map(PHYSICAL_DEVICES.map((d) => [d.id, d]));
  devices.set('live-program', { id: 'live-program', name: 'Live Program', workspace_id: 'ws-classroom' });
  const defaultState = {
    current_content_id: 'content-a',
    current_asset_id: 'asset-a',
    content_instance_id: 'instance-a',
    slide_index: 1,
    slide_count: 5,
    paused: false,
    state_revision: 1,
    playback_revision: 1,
    generation: 1,
  };
  const emitted = [];
  const queued = [];
  const persisted = [];
  let sequence = 0;
  const coordinator = createTransportTransactionCoordinator({
    getDevice: (id) => devices.get(id) || null,
    listWorkspaceDevices: () => PHYSICAL_DEVICES,
    getDisplayState: (deviceId) => displayStates[deviceId] || { ...defaultState },
    getLiveState: () => ({ configured: true, content_active: true, display_id: 'live-program' }),
    getRoomRevision: () => 1,
    getContentGeneration: () => 1,
    isDeviceOnline: () => online,
    emitToDevice: (deviceId, envelope) => emitted.push({ deviceId, envelope }),
    queueToDevice: (deviceId, envelope) => { queued.push({ deviceId, envelope }); return true; },
    ingestCommand: (values) => { persisted.push(values); return { command_id: values.command_id || `cmd-${++sequence}` }; },
    createCommand: (values) => ({
      version: 1, type: 'device:command',
      command_id: values.command_id || `cmd-${++sequence}`,
      issued_at: '2026-08-20T21:00:00.000Z',
      device_id: values.device_id,
      target_scope: 'display',
      payload: { ...values.payload },
    }),
    resolveAudioAuthority: () => ({ valid: true, authority_device_id: audioAuthorityId }),
    randomUUID: () => `uuid-${++sequence}`,
    now: () => 1_000_000,
  });
  const byDevice = (store) => Object.fromEntries(store.map((e) => [e.deviceId, e.envelope.payload]));
  return { coordinator, emitted, queued, persisted, byDevice, sequence: () => sequence };
}

test('mixed-generation pause binds each target to its own current generation', () => {
  const h = makeCoordinator({
    displayStates: {
      'front-left':  { current_content_id: 'content-a', current_asset_id: 'asset-a', content_instance_id: 'instance-A', generation: 21, state_revision: 21 },
      'front-center': { current_content_id: 'content-a', current_asset_id: 'asset-a', content_instance_id: 'instance-A', generation: 22, state_revision: 22 },
    },
  });
  const result = h.coordinator.dispatch({
    workspaceId: 'ws-classroom',
    deviceIds: ['front-left', 'front-center'],
    action: 'pause',
    payload: {},
    issuedBy: 'operator-1',
    idempotencyKey: 'mixed-pause-1',
  });
  assert.equal(result.ok, true);
  const byDevice = h.byDevice(h.emitted);
  assert.equal(byDevice['front-left'].expected_generation, 21, 'front-left must use its own generation');
  assert.equal(byDevice['front-center'].expected_generation, 22, 'front-center must use its own generation');
});

test('mixed-generation play binds each target to its own current generation', () => {
  const h = makeCoordinator({
    displayStates: {
      'front-left':  { current_content_id: 'content-b', current_asset_id: 'asset-b', content_instance_id: 'instance-B', generation: 31, state_revision: 31, paused: true },
      'front-center': { current_content_id: 'content-b', current_asset_id: 'asset-b', content_instance_id: 'instance-B', generation: 32, state_revision: 32, paused: true },
    },
  });
  const result = h.coordinator.dispatch({
    workspaceId: 'ws-classroom',
    deviceIds: ['front-left', 'front-center'],
    action: 'play',
    payload: {},
    issuedBy: 'operator-1',
    idempotencyKey: 'mixed-play-1',
  });
  assert.equal(result.ok, true);
  const byDevice = h.byDevice(h.emitted);
  assert.equal(byDevice['front-left'].expected_generation, 31);
  assert.equal(byDevice['front-center'].expected_generation, 32);
});

test('mixed-generation seek binds each target to its own current generation', () => {
  const h = makeCoordinator({
    displayStates: {
      'front-left':  { current_content_id: 'video-c', current_asset_id: 'asset-c', content_instance_id: 'instance-C', generation: 41, state_revision: 41 },
      'front-center': { current_content_id: 'video-c', current_asset_id: 'asset-c', content_instance_id: 'instance-C', generation: 42, state_revision: 42 },
    },
  });
  const result = h.coordinator.dispatch({
    workspaceId: 'ws-classroom',
    deviceIds: ['front-left', 'front-center'],
    action: 'seek',
    payload: { position_seconds: 120 },
    issuedBy: 'operator-1',
    idempotencyKey: 'mixed-seek-1',
  });
  assert.equal(result.ok, true);
  const byDevice = h.byDevice(h.emitted);
  assert.equal(byDevice['front-left'].expected_generation, 41);
  assert.equal(byDevice['front-center'].expected_generation, 42);
  assert.equal(byDevice['front-left'].position_seconds, 120);
});

test('slide command binds each target to its own deck generation', () => {
  const h = makeCoordinator({
    displayStates: {
      'front-left':  { current_content_id: 'deck-d', current_asset_id: 'asset-d', content_instance_id: 'instance-D', generation: 51, state_revision: 51, slide_index: 2, slide_count: 10 },
      'front-center': { current_content_id: 'deck-d', current_asset_id: 'asset-d', content_instance_id: 'instance-D', generation: 52, state_revision: 52, slide_index: 2, slide_count: 10 },
    },
  });
  const result = h.coordinator.dispatch({
    workspaceId: 'ws-classroom',
    deviceIds: ['front-left', 'front-center'],
    action: 'next',
    payload: {},
    issuedBy: 'operator-1',
    idempotencyKey: 'mixed-slide-1',
  });
  assert.equal(result.ok, true);
  const byDevice = h.byDevice(h.emitted);
  assert.equal(byDevice['front-left'].action, 'go_to_slide');
  assert.equal(byDevice['front-left'].slide, 3);
  assert.equal(byDevice['front-left'].expected_generation, 51);
  assert.equal(byDevice['front-center'].expected_generation, 52);
});

test('one stale target and one current target both receive their own generation', () => {
  const h = makeCoordinator({
    displayStates: {
      'front-left':  { current_content_id: 'content-e', current_asset_id: 'asset-e', content_instance_id: 'instance-E', generation: 61, state_revision: 61 },
      'front-center': { current_content_id: 'content-e', current_asset_id: 'asset-e', content_instance_id: 'instance-E', generation: 99, state_revision: 99 },
    },
  });
  const result = h.coordinator.dispatch({
    workspaceId: 'ws-classroom',
    deviceIds: ['front-left', 'front-center'],
    action: 'pause',
    payload: {},
    issuedBy: 'operator-1',
    idempotencyKey: 'mixed-stale-1',
  });
  assert.equal(result.ok, true);
  const byDevice = h.byDevice(h.emitted);
  assert.equal(byDevice['front-left'].expected_generation, 61);
  assert.equal(byDevice['front-center'].expected_generation, 99);
});

test('offline queued command preserves per-target generation binding', () => {
  const h = makeCoordinator({
    online: false,
    displayStates: {
      'front-left':  { current_content_id: 'content-f', current_asset_id: 'asset-f', content_instance_id: 'instance-F', generation: 71, state_revision: 71 },
      'front-center': { current_content_id: 'content-f', current_asset_id: 'asset-f', content_instance_id: 'instance-F', generation: 72, state_revision: 72 },
    },
  });
  const result = h.coordinator.dispatch({
    workspaceId: 'ws-classroom',
    deviceIds: ['front-left', 'front-center'],
    action: 'pause',
    payload: {},
    issuedBy: 'operator-1',
    idempotencyKey: 'offline-mixed-1',
  });
  assert.equal(result.ok, true);
  const physicalQueued = h.queued.filter((q) => q.deviceId === 'front-left' || q.deviceId === 'front-center');
  assert.equal(physicalQueued.length, 2);
  const byDevice = h.byDevice(physicalQueued);
  assert.equal(byDevice['front-left'].expected_generation, 71);
  assert.equal(byDevice['front-center'].expected_generation, 72);
});

test('audio companion target with distinct generation receives its own generation', () => {
  const h = makeCoordinator({
    displayStates: {
      'front-left': { current_content_id: 'companion-g', current_asset_id: 'asset-g', content_instance_id: 'companion-instance-g', generation: 81, state_revision: 81 },
    },
  });
  const result = h.coordinator.dispatch({
    workspaceId: 'ws-classroom',
    deviceIds: ['front-left'],
    action: 'pause',
    payload: {},
    issuedBy: 'operator-1',
    idempotencyKey: 'companion-mixed-1',
  });
  assert.equal(result.ok, true);
  assert.equal(h.emitted[0].envelope.payload.content_instance_id, 'companion-instance-g');
  assert.equal(h.emitted[0].envelope.payload.expected_generation, 81);
});
