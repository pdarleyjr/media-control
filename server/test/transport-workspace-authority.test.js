'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createTransportTransactionCoordinator } = require('../lib/transport-transaction');

function makeCoordinator(devices, { audioAuthorityId = 'front-left' } = {}) {
  const byId = new Map(devices.map((d) => [d.id, d]));
  const emitted = [];
  const queued = [];
  const persisted = [];
  let sequence = 0;
  const coordinator = createTransportTransactionCoordinator({
    getDevice: (id) => byId.get(id) || null,
    listWorkspaceDevices: () => devices.filter((d) => d.workspace_id === 'ws-classroom'),
    getDisplayState: () => ({ current_content_id: 'c', current_asset_id: 'a', content_instance_id: 'i', generation: 1, state_revision: 1 }),
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
  return { coordinator, emitted, queued, persisted };
}

const CLASSROOM = [
  { id: 'front-left', workspace_id: 'ws-classroom' },
  { id: 'front-center', workspace_id: 'ws-classroom' },
  { id: 'front-right', workspace_id: 'ws-classroom' },
];

test('valid two-display wall is accepted and binds every target', () => {
  const { coordinator, emitted } = makeCoordinator(CLASSROOM);
  const result = coordinator.dispatch({
    workspaceId: 'ws-classroom',
    deviceIds: ['front-left', 'front-center'],
    action: 'pause',
    payload: {},
    issuedBy: 'op',
    idempotencyKey: 'wall2-ok',
  });
  assert.equal(result.ok, true);
  assert.equal(result.targets.length, 3); // 2 physical + live
  const ids = emitted.map((e) => e.deviceId).sort();
  assert.deepEqual(ids, ['front-center', 'front-left', 'live-program']);
});

test('valid three-display wall is accepted', () => {
  const { coordinator } = makeCoordinator(CLASSROOM);
  const result = coordinator.dispatch({
    workspaceId: 'ws-classroom',
    deviceIds: ['front-left', 'front-center', 'front-right'],
    action: 'play',
    payload: {},
    issuedBy: 'op',
    idempotencyKey: 'wall3-ok',
  });
  assert.equal(result.ok, true);
  assert.equal(result.targets.length, 4);
});

test('cross-workspace target is rejected, never executed', () => {
  const devices = [
    ...CLASSROOM,
    { id: 'lobby-screen', workspace_id: 'ws-lobby' },
  ];
  const { coordinator, emitted } = makeCoordinator(devices);
  const result = coordinator.dispatch({
    workspaceId: 'ws-classroom',
    deviceIds: ['front-left', 'lobby-screen'],
    action: 'pause',
    payload: {},
    issuedBy: 'op',
    idempotencyKey: 'xws-reject',
  });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'workspace_mismatch');
  assert.equal(emitted.length, 0);
});

test('unknown device id is rejected', () => {
  const { coordinator, emitted } = makeCoordinator(CLASSROOM);
  const result = coordinator.dispatch({
    workspaceId: 'ws-classroom',
    deviceIds: ['front-left', 'ghost-device'],
    action: 'pause',
    payload: {},
    issuedBy: 'op',
    idempotencyKey: 'unknown-reject',
  });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'device_not_found');
  assert.equal(emitted.length, 0);
});

test('empty target expansion is rejected', () => {
  const { coordinator } = makeCoordinator(CLASSROOM);
  const result = coordinator.dispatch({
    workspaceId: 'ws-classroom',
    deviceIds: [],
    action: 'pause',
    payload: {},
    issuedBy: 'op',
    idempotencyKey: 'empty-reject',
  });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'missing_device_ids');
});

test('duplicate device ids are collapsed to a single target', () => {
  const { coordinator } = makeCoordinator(CLASSROOM);
  const result = coordinator.dispatch({
    workspaceId: 'ws-classroom',
    deviceIds: ['front-left', 'front-left', 'front-center'],
    action: 'pause',
    payload: {},
    issuedBy: 'op',
    idempotencyKey: 'dup-collapse',
  });
  assert.equal(result.ok, true);
  const physical = result.targets.filter((t) => t.target_role === 'physical');
  assert.equal(physical.length, 2);
});
