'use strict';

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  updateLiveProductionState,
  resetLiveProductionStateForTests,
} = require('../lib/live-production-state');

beforeEach(() => resetLiveProductionStateForTests());

test('room snapshot state defaults to the isolated cached production observation', () => {
  updateLiveProductionState('ws-one', {
    ok: true,
    data: { stream_active: true, recording_active: false, current_scene: 'PROGRAM' },
  }, { now: 100 });

  // Load after the cache setup so this checks the integration seam without
  // needing to construct the production SQLite singleton's entire fixture.
  const { resolveSnapshotState } = require('../lib/room-state-broadcaster');
  const resolved = resolveSnapshotState('ws-one', { classroomProgram: { targets: [] } });

  assert.equal(resolved.streamState.status, 'live');
  assert.equal(resolved.recordingState.status, 'stopped');
  assert.deepEqual(resolved.classroomProgram, { targets: [] });
  assert.equal(resolved.workspaceId, undefined);
  assert.equal(resolved.token, undefined);
});

test('explicit safe snapshot state overrides cached production defaults', () => {
  updateLiveProductionState('ws-one', {
    ok: true,
    data: { stream_active: true, recording_active: true },
  }, { now: 100 });
  const { resolveSnapshotState } = require('../lib/room-state-broadcaster');

  const resolved = resolveSnapshotState('ws-one', {
    streamState: { status: 'operator-override' },
    recordingState: { status: 'operator-override' },
  });
  assert.deepEqual(resolved.streamState, { status: 'operator-override' });
  assert.deepEqual(resolved.recordingState, { status: 'operator-override' });
});

test('live stream status, start verification, and stop verification update the authoritative cache', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'routes', 'live-stream.js'), 'utf8');

  assert.match(source, /updateLiveProductionState/);
  assert.match(source, /observeDirectorResult\(req, director, 'status:checked'\)/);
  assert.match(source, /observeDirectorResult\(req, statusAfterMode, 'stream:prepared'\)/);
  assert.match(source, /observeDirectorResult\(req, status, 'stream:start-verified'\)/);
  assert.match(source, /observeDirectorResult\(req, check, 'stream:stop-verification'\)/);
  assert.match(source, /publishRoomSnapshot/);
});
