const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

async function loadStoreModule() {
  const source = fs.readFileSync(
    path.join(__dirname, '../../frontend/js/services/room-state-store.js'),
    'utf8',
  );
  return import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
}

function snapshot(revision, displayId = 'display-a') {
  return {
    schemaVersion: 1,
    workspaceId: 'ws-1',
    roomId: 'classroom-1',
    revision,
    serverTimestamp: 1_700_000_000_000 + revision,
    confirmedState: { displays: [{ id: displayId, name: displayId }] },
    pendingCommands: [],
    lastCommandId: null,
    deviceStates: [],
    layoutState: [],
    classroomProgram: null,
    livestreamProgram: null,
    recordingState: { status: 'unknown' },
    streamState: { status: 'unknown' },
  };
}

test('room state store accepts a snapshot and indexes confirmed displays', async () => {
  const { createRoomStateStore } = await loadStoreModule();
  const store = createRoomStateStore();
  const result = store.applySnapshot(snapshot(4));
  assert.deepEqual(result, { applied: true, revision: 4 });
  assert.equal(store.getRevision(), 4);
  assert.equal(store.getDisplay('display-a').name, 'display-a');
});

test('room state store rejects older snapshots without regressing state', async () => {
  const { createRoomStateStore } = await loadStoreModule();
  const store = createRoomStateStore();
  store.applySnapshot(snapshot(8, 'current'));
  assert.deepEqual(store.applySnapshot(snapshot(7, 'stale')), {
    applied: false,
    reason: 'stale_revision',
    revision: 8,
  });
  assert.ok(store.getDisplay('current'));
  assert.equal(store.getDisplay('stale'), null);
});

test('room state store requests recovery when a delta skips a revision', async () => {
  const { createRoomStateStore } = await loadStoreModule();
  const gaps = [];
  const store = createRoomStateStore({ onGap: (gap) => gaps.push(gap) });
  store.applySnapshot(snapshot(2));
  assert.deepEqual(store.applyDelta({ workspaceId: 'ws-1', roomId: 'classroom-1', revision: 4, patch: { streamState: { status: 'live' } } }), {
    applied: false,
    reason: 'revision_gap',
    expectedRevision: 3,
    receivedRevision: 4,
  });
  assert.deepEqual(gaps, [{ expectedRevision: 3, receivedRevision: 4 }]);
  assert.equal(store.getRevision(), 2);
});

test('room state store applies the next normalized delta and notifies once', async () => {
  const { createRoomStateStore } = await loadStoreModule();
  const store = createRoomStateStore();
  store.applySnapshot(snapshot(10));
  let notified = 0;
  store.subscribe(() => { notified += 1; });
  assert.deepEqual(store.applyDelta({
    workspaceId: 'ws-1',
    roomId: 'classroom-1',
    revision: 11,
    patch: { recordingState: { status: 'recording' } },
  }), { applied: true, revision: 11 });
  assert.equal(store.getSnapshot().recordingState.status, 'recording');
  assert.equal(notified, 1);
});

test('room state store rejects cross-workspace snapshots and deltas', async () => {
  const { createRoomStateStore } = await loadStoreModule();
  const store = createRoomStateStore();
  store.applySnapshot(snapshot(3));
  assert.equal(store.applySnapshot({ ...snapshot(4), workspaceId: 'ws-other' }).reason, 'identity_mismatch');
  assert.equal(store.applyDelta({
    workspaceId: 'ws-other', roomId: 'classroom-1', revision: 4, patch: {},
  }).reason, 'identity_mismatch');
  assert.equal(store.getRevision(), 3);
});

test('delta-before-snapshot triggers full snapshot recovery', async () => {
  const { createRoomStateStore } = await loadStoreModule();
  const recoveries = [];
  const store = createRoomStateStore({ onGap: (value) => recoveries.push(value) });
  assert.equal(store.applyDelta({
    workspaceId: 'ws-1', roomId: 'classroom-1', revision: 1, patch: {},
  }).reason, 'snapshot_required');
  assert.deepEqual(recoveries, [{ expectedRevision: null, receivedRevision: 1 }]);
});

test('dashboard socket resumes by revision and routes snapshots through the normalized store', () => {
  const source = fs.readFileSync(path.join(__dirname, '../../frontend/js/socket.js'), 'utf8');
  assert.match(source, /createRoomStateStore/);
  assert.match(source, /dashboard:room-resume/);
  assert.match(source, /room:snapshot/);
  assert.match(source, /room:delta/);
  assert.match(source, /roomState\.applySnapshot/);
  assert.match(source, /roomState\.applyDelta/);
});

test('display state hydrates from authoritative room snapshots', () => {
  const source = fs.readFileSync(path.join(__dirname, '../../frontend/js/services/display-state.js'), 'utf8');
  assert.match(source, /room-snapshot/);
  assert.match(source, /projectRoomDisplays\(snapshot, displays/);
  assert.match(source, /roomState\.subscribe\(hydrateRoomSnapshot\)/);
  assert.doesNotMatch(source, /onSocket\('wall-changed',[\s\S]{0,120}refresh\(/);
});
