const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { importModule } = require('./lib/esm-bundle.js');

const STORE = path.join(__dirname, '../../../frontend/js/state/operator-store.js');

function snapshot(revision, overrides = {}) {
  return {
    schemaVersion: 1,
    workspaceId: 'ws-1',
    roomId: 'classroom-1',
    revision,
    serverTimestamp: Date.now(),
    confirmedState: { displays: [{ id: 'd1', name: 'Display 1', status: 'online', contentId: 'c1', contentType: 'slides' }] },
    pendingCommands: [],
    lastCommandId: null,
    deviceStates: { displays: [{ id: 'd1', status: 'online', screenOn: true }], nodes: [] },
    layoutState: { walls: [], groups: [] },
    classroomProgram: { targets: [{ id: 'd1' }] },
    livestreamProgram: { id: 'live-stream-program-ws-1', content_active: true },
    recordingState: { active: true, reachable: true },
    streamState: { active: true, reachable: true },
    ...overrides,
  };
}

function makeRoomStore() {
  const subs = new Set();
  let snap = null;
  return {
    applySnapshot: (s) => { snap = s; subs.forEach((cb) => cb(s)); return { applied: true, revision: s.revision }; },
    getSnapshot: () => snap,
    getRevision: () => snap?.revision ?? 0,
    subscribe: (cb) => { subs.add(cb); return () => subs.delete(cb); },
    reset: () => { snap = null; subs.forEach((cb) => cb(null)); },
  };
}

test('operator store derives normalized projection from the room store', async () => {
  const { createOperatorStore } = await importModule(STORE);
  const rs = makeRoomStore();
  const store = createOperatorStore({ roomStore: rs });
  rs.applySnapshot(snapshot(5));
  store.connect();
  const state = store.get();
  assert.equal(state.schemaVersion, 1);
  assert.equal(state.workspace, 'ws-1');
  assert.equal(state.room, 'classroom-1');
  assert.equal(state.revision, 5);
  assert.equal(state.displays.length, 1);
  assert.equal(state.displays[0].name, 'Display 1');
  assert.equal(state.deviceHealth.total, 1);
  assert.equal(state.deviceHealth.online, 1);
});

test('pending commands keep a display visibly PENDING until acked', async () => {
  const { createOperatorStore } = await importModule(STORE);
  const rs = makeRoomStore();
  const store = createOperatorStore({ roomStore: rs });
  rs.applySnapshot(snapshot(1, { confirmedState: { displays: [{ id: 'd1', name: 'D1', status: 'online' }] }, pendingCommands: [{ command_id: 'cmd1', target_id: 'd1', command_type: 'transport', status: 'sent' }] }));
  store.connect();
  const state = store.get();
  assert.equal(state.displays[0].opState, 'pending');
  assert.equal(state.pendingCommands.length, 1);
});

test('failed command never appears confirmed', async () => {
  const { createOperatorStore } = await importModule(STORE);
  const rs = makeRoomStore();
  const store = createOperatorStore({ roomStore: rs });
  rs.applySnapshot(snapshot(2, { confirmedState: { displays: [{ id: 'd1', name: 'D1', status: 'online', contentId: 'c1' }] }, pendingCommands: [{ command_id: 'cmd1', target_id: 'd1', status: 'failed' }] }));
  store.connect();
  assert.equal(store.get().displays[0].opState, 'failed');
});

test('offline display is OFFLINE regardless of pending', async () => {
  const { createOperatorStore } = await importModule(STORE);
  const rs = makeRoomStore();
  const store = createOperatorStore({ roomStore: rs });
  rs.applySnapshot(snapshot(3, { confirmedState: { displays: [{ id: 'd1', name: 'D1', status: 'offline' }] }, deviceStates: { displays: [{ id: 'd1', status: 'offline' }], nodes: [] } }));
  store.connect();
  assert.equal(store.get().displays[0].opState, 'offline');
  assert.equal(store.get().deviceHealth.offline, 1);
});

test('local command tracking: PENDING then resolved to FAILED (no silent confirm)', async () => {
  const { createOperatorStore } = await importModule(STORE);
  const rs = makeRoomStore();
  const store = createOperatorStore({ roomStore: rs });
  rs.applySnapshot(snapshot(1, { confirmedState: { displays: [{ id: 'd1', name: 'D1', status: 'online' }] } }));
  store.connect();
  store.trackLocalCommand({ commandId: 'lc1', target: 'd1', type: 'transport' });
  assert.equal(store.get().displays[0].opState, 'pending');
  assert.equal(store.get().localPendingCount, 1);
  store.resolveLocalCommand('lc1', { ok: false, status: 'failed' });
  assert.equal(store.get().displays[0].opState, 'failed');
});

test('another user changes update subscribers immediately (shared room store)', async () => {
  const { createOperatorStore } = await importModule(STORE);
  const rs = makeRoomStore();
  const store = createOperatorStore({ roomStore: rs });
  let updates = 0;
  const unsub = store.subscribe(() => { updates++; });
  rs.applySnapshot(snapshot(1));
  store.connect();
  const before = updates;
  rs.applySnapshot(snapshot(2, { confirmedState: { displays: [{ id: 'd1', name: 'D1', status: 'online', contentId: 'c2' }] } }));
  assert.ok(updates > before, 'subscriber notified on external change');
  unsub();
});

test('stale detection flags old snapshots', async () => {
  const { createOperatorStore } = await importModule(STORE);
  const rs = makeRoomStore();
  const store = createOperatorStore({ roomStore: rs, staleToleranceMs: 0 });
  rs.applySnapshot(snapshot(1, { serverTimestamp: Date.now() - 60000 }));
  store.connect();
  assert.equal(store.get().stale, true);
});
