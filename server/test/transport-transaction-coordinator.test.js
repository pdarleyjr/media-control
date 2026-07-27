'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  canonicalizeTransportAction,
  createTransportTransactionCoordinator,
} = require('../lib/transport-transaction');

const PHYSICAL_DEVICES = [
  { id: 'front-left', name: 'Front Left', workspace_id: 'ws-classroom' },
  { id: 'front-center', name: 'Front Center', workspace_id: 'ws-classroom' },
  { id: 'front-right', name: 'Front Right', workspace_id: 'ws-classroom' },
  { id: 'side-left', name: 'Side Left', workspace_id: 'ws-classroom' },
  { id: 'side-right', name: 'Side Right', workspace_id: 'ws-classroom' },
];

function createHarness({ liveActive = true } = {}) {
  const devices = new Map(PHYSICAL_DEVICES.map((device) => [device.id, device]));
  devices.set('live-program', {
    id: 'live-program',
    name: 'Content for live stream',
    workspace_id: 'ws-classroom',
  });
  const emitted = [];
  const queued = [];
  const persisted = [];
  let sequence = 0;
  const coordinator = createTransportTransactionCoordinator({
    getDevice: (deviceId) => devices.get(deviceId) || null,
    listWorkspaceDevices: () => PHYSICAL_DEVICES,
    getDisplayState: () => ({
      current_content_id: 'deck-incident-briefing',
      current_asset_id: 'asset-deck-2026',
      slide_index: 3,
      slide_count: 10,
      paused: false,
      state_revision: 17,
    }),
    getLiveState: () => ({
      configured: true,
      content_active: liveActive,
      display_id: 'live-program',
    }),
    getRoomRevision: () => 41,
    getContentGeneration: () => 9,
    isDeviceOnline: () => true,
    emitToDevice: (deviceId, envelope) => emitted.push({ deviceId, envelope }),
    queueToDevice: (deviceId, envelope) => {
      queued.push({ deviceId, envelope });
      return true;
    },
    ingestCommand: (values) => {
      persisted.push(values);
      return { command_id: values.command_id };
    },
    createCommand: (values) => ({
      version: 1,
      type: 'device:command',
      command_id: values.command_id || `command-${++sequence}`,
      issued_at: '2026-07-26T12:00:00.000Z',
      device_id: values.device_id,
      target_scope: 'display',
      payload: { ...values.payload },
    }),
    resolveAudioAuthority: () => ({
      valid: true,
      authority_device_id: 'front-left',
    }),
    randomUUID: () => `uuid-${++sequence}`,
    now: () => 1_000_000,
  });
  return { coordinator, emitted, queued, persisted };
}

test('one five-display transaction emits once per physical target and once to active Live Program', () => {
  const { coordinator, emitted, queued, persisted } = createHarness();
  const result = coordinator.dispatch({
    workspaceId: 'ws-classroom',
    roomId: 'classroom-1',
    deviceIds: PHYSICAL_DEVICES.map((device) => device.id),
    action: 'next',
    payload: {},
    issuedBy: 'operator-1',
    idempotencyKey: 'operator-click-42', // gitleaks:allow - deterministic test-only value
  });

  assert.equal(result.ok, true);
  assert.equal(result.duplicate, false);
  assert.equal(result.targets.length, 6);
  assert.deepEqual(
    emitted.map((entry) => entry.deviceId).sort(),
    [...PHYSICAL_DEVICES.map((device) => device.id), 'live-program'].sort(),
  );
  assert.equal(queued.length, 0);
  assert.equal(persisted.length, 6);

  const payloads = emitted.map((entry) => entry.envelope.payload);
  assert.equal(new Set(payloads.map((payload) => payload.transport_transaction_id)).size, 1);
  assert.deepEqual(new Set(payloads.map((payload) => payload.idempotency_key)), new Set(['operator-click-42']));
  assert.deepEqual(new Set(payloads.map((payload) => payload.content_instance_id)), new Set(['asset-deck-2026']));
  assert.deepEqual(new Set(payloads.map((payload) => payload.expected_revision)), new Set([41]));
  assert.deepEqual(new Set(payloads.map((payload) => payload.expected_generation)), new Set([9]));
  assert.deepEqual(new Set(payloads.map((payload) => payload.action)), new Set(['go_to_slide']));
  assert.deepEqual(new Set(payloads.map((payload) => payload.slide_index)), new Set([4]));
  assert.equal(new Set(emitted.map((entry) => entry.envelope.command_id)).size, 6);

  const authority = emitted.find((entry) => entry.deviceId === 'front-left').envelope.payload;
  assert.equal(authority.audio_allowed, true);
  assert.equal(authority.force_muted, false);
  for (const entry of emitted.filter((candidate) => candidate.deviceId !== 'front-left')) {
    assert.equal(entry.envelope.payload.audio_allowed, false);
    assert.equal(entry.envelope.payload.force_muted, true);
  }
  const persistedByTarget = new Map(persisted.map(command => [command.target_id, command.payload]));
  assert.equal(persistedByTarget.get('front-left').audio_allowed, true);
  for (const follower of ['front-center', 'front-right', 'side-left', 'side-right']) {
    assert.equal(persistedByTarget.get(follower).audio_allowed, false);
    assert.equal(persistedByTarget.get(follower).force_muted, true);
  }
  assert.equal(persistedByTarget.get('live-program').audio_allowed, false);
  assert.equal(result.targets.find((target) => target.device_id === 'live-program').target_role, 'live-program');
});

test('replaying one idempotency key returns the unified acknowledgement without another emit', () => {
  const { coordinator, emitted, persisted } = createHarness();
  const request = {
    workspaceId: 'ws-classroom',
    deviceIds: PHYSICAL_DEVICES.map((device) => device.id),
    action: 'pause',
    payload: { content_instance_id: 'video-instance-1', expected_generation: 12 },
    idempotencyKey: 'pause-click-1',
  };
  const first = coordinator.dispatch(request);
  const replay = coordinator.dispatch(request);

  assert.equal(first.targets.length, 6);
  assert.equal(replay.duplicate, true);
  assert.equal(replay.transaction_id, first.transaction_id);
  assert.deepEqual(replay.targets, first.targets);
  assert.equal(emitted.length, 6);
  assert.equal(persisted.length, 6);
});

test('removing composition content prevents all future live receiver transport commands', () => {
  const harness = createHarness({ liveActive: false });
  const result = harness.coordinator.dispatch({
    workspaceId: 'ws-classroom',
    deviceIds: PHYSICAL_DEVICES.map((device) => device.id),
    action: 'pause',
    payload: {},
    idempotencyKey: 'after-clear',
  });

  assert.equal(result.targets.length, 5);
  assert.equal(harness.emitted.length, 5);
  assert.ok(harness.emitted.every((entry) => entry.deviceId !== 'live-program'));
});

test('pause and absolute seek stay explicit and never toggle or resume playback', () => {
  assert.deepEqual(
    canonicalizeTransportAction('play_pause', {}, { paused: true }),
    { action: 'play', payload: { action: 'play' } },
  );
  assert.deepEqual(
    canonicalizeTransportAction('play_pause', {}, { paused: false }),
    { action: 'pause', payload: { action: 'pause' } },
  );
  assert.deepEqual(
    canonicalizeTransportAction('pause', {}, { paused: true }),
    { action: 'pause', payload: { action: 'pause' } },
  );
  assert.deepEqual(
    canonicalizeTransportAction('seek', { seconds: 87.5 }, { paused: true }),
    { action: 'seek', payload: { action: 'seek', seconds: 87.5 } },
  );
});

test('legacy per-display burst joins one shared transaction and mirrors Live Program once', () => {
  const { coordinator, emitted } = createHarness();
  const results = PHYSICAL_DEVICES.map((device) => coordinator.dispatchLegacyTarget({
    workspaceId: 'ws-classroom',
    roomId: 'classroom-1',
    deviceId: device.id,
    action: 'next',
    payload: {
      device_id: device.id,
      transport_transaction_id: 'shared-dashboard-transaction',
      idempotency_key: 'shared-dashboard-transaction',
    },
    issuedBy: 'operator-1',
  }));

  assert.equal(emitted.length, 6);
  assert.equal(emitted.filter((entry) => entry.deviceId === 'live-program').length, 1);
  assert.equal(new Set(emitted.map((entry) => entry.deviceId)).size, 6);
  assert.equal(new Set(results.map((result) => result.transaction_id)).size, 1);
  const payloads = emitted.map((entry) => entry.envelope.payload);
  assert.equal(new Set(payloads.map((payload) => payload.idempotency_key)).size, 1);
  assert.equal(new Set(payloads.map((payload) => payload.transport_transaction_id)).size, 1);
});
