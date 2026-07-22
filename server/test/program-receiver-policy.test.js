'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  isAllowedProgramReceiverEvent,
  isProgramReceiverId,
  programReceiverEventGuard,
  resolveProgramReceiverSnapshotTarget,
} = require('../lib/program-receiver-policy');

test('only managed live-program displays are limited program receivers', () => {
  assert.equal(isProgramReceiverId('live-stream-program-abc'), true);
  assert.equal(isProgramReceiverId('classroom-tv-1'), false);
  assert.equal(isProgramReceiverId(''), false);
});

test('program receiver may authenticate, report playback, and request an authoritative snapshot', () => {
  for (const event of [
    'device:register',
    'device:heartbeat',
    'device:playlist-sync',
    'device:screenshot',
    'device:ack',
    'device:state-report',
    'device:playback-state',
    'device:play-event',
    'display:viewport',
    'device:room-snapshot',
  ]) {
    assert.equal(isAllowedProgramReceiverEvent(event), true, event);
  }
});

test('program receiver cannot originate wall control, whiteboard writes, or node operations', () => {
  for (const event of [
    'wall:sync',
    'wall:sync-request',
    'device:wb-stroke',
    'device:wb-clear',
    'device:wb-undo',
    'device:wb-redo',
    'node:heartbeat',
    'join',
  ]) {
    assert.equal(isAllowedProgramReceiverEvent(event), false, event);
  }
});

test('socket guard activates after a program receiver authenticates', () => {
  let deviceId = null;
  const guard = programReceiverEventGuard(() => deviceId);
  let error = 'not-called';
  guard(['device:wb-clear', {}], (value) => { error = value || null; });
  assert.equal(error, null);

  deviceId = 'live-stream-program-abc';
  guard(['device:room-snapshot', {}], (value) => { error = value || null; });
  assert.equal(error, null);
  guard(['device:wb-clear', {}], (value) => { error = value || null; });
  assert.equal(error.code, 'PROGRAM_RECEIVER_EVENT_FORBIDDEN');
});

test('snapshot target is derived from the receiver tenancy and rejects mismatches', () => {
  const fakeDb = {
    prepare() {
      return { get: () => ({ workspace_id: 'workspace-1' }) };
    },
  };
  assert.deepEqual(resolveProgramReceiverSnapshotTarget({
    db: fakeDb,
    deviceId: 'live-stream-program-abc',
    configuredRoomId: 'classroom-1',
    requestedWorkspaceId: 'workspace-1',
    requestedRoomId: 'classroom-1',
  }), { workspaceId: 'workspace-1', roomId: 'classroom-1' });

  assert.throws(() => resolveProgramReceiverSnapshotTarget({
    db: fakeDb,
    deviceId: 'live-stream-program-abc',
    configuredRoomId: 'classroom-1',
    requestedWorkspaceId: 'other-workspace',
  }), { code: 'PROGRAM_RECEIVER_WORKSPACE_MISMATCH' });
  assert.throws(() => resolveProgramReceiverSnapshotTarget({
    db: fakeDb,
    deviceId: 'live-stream-program-abc',
    configuredRoomId: 'classroom-1',
    requestedRoomId: 'other-room',
  }), { code: 'PROGRAM_RECEIVER_ROOM_MISMATCH' });
});
