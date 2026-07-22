const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createReceiverHealth,
  normalizeHttpOrigin,
  resolveManagedServerUrl,
  validateRoomSnapshot,
} = require('../player/managed-bootstrap');

test('managed live-program players keep their explicit same-host control URL', () => {
  assert.equal(resolveManagedServerUrl({
    pageOrigin: 'https://media-control.example.test',
    managed: {
      connectionScope: 'obs-same-host',
      serverUrl: 'http://127.0.0.1:8096/',
    },
  }), 'http://127.0.0.1:8096');
});

test('ordinary managed displays prefer the HTTPS page origin', () => {
  assert.equal(resolveManagedServerUrl({
    pageOrigin: 'https://media-control.example.test/',
    managed: { serverUrl: 'http://100.81.154.123:8096' },
  }), 'https://media-control.example.test');
});

test('direct LAN managed displays use the configured server when page origin is HTTP', () => {
  assert.equal(resolveManagedServerUrl({
    pageOrigin: 'http://192.168.1.50:8096',
    managed: { serverUrl: 'http://192.168.1.10:8096/' },
  }), 'http://192.168.1.10:8096');
});

test('managed bootstrap rejects non-HTTP control-channel schemes', () => {
  assert.equal(normalizeHttpOrigin('javascript:alert(1)'), '');
  assert.equal(resolveManagedServerUrl({
    pageOrigin: 'https://media-control.example.test',
    managed: {
      connectionScope: 'obs-same-host',
      serverUrl: 'file:///etc/passwd',
    },
  }), 'https://media-control.example.test');
});

test('managed bootstrap resolves HTTP origins on embedded browsers without URL', () => {
  const nativeUrl = global.URL;
  try {
    global.URL = undefined;
    assert.equal(normalizeHttpOrigin('http://127.0.0.1:8096/player/live-stream?token=x'), 'http://127.0.0.1:8096');
  } finally {
    global.URL = nativeUrl;
  }
});

test('authoritative room snapshot validation requires complete matching state', () => {
  const snapshot = {
    schemaVersion: 1,
    workspaceId: 'workspace-1',
    roomId: 'classroom-1',
    revision: 7,
    serverTimestamp: 1234,
    confirmedState: {},
    pendingCommands: [],
    lastCommandId: null,
    deviceStates: {},
    layoutState: {},
    classroomProgram: {},
    livestreamProgram: {},
    recordingState: {},
    streamState: {},
  };
  assert.deepEqual(validateRoomSnapshot(snapshot, {
    workspaceId: 'workspace-1',
    roomId: 'classroom-1',
  }), { ok: true });
  assert.equal(validateRoomSnapshot({ ...snapshot, streamState: undefined }, {}).ok, false);
  assert.equal(validateRoomSnapshot({ ...snapshot, roomId: 'other-room' }, {
    roomId: 'classroom-1',
  }).code, 'ROOM_MISMATCH');
});

test('receiver health becomes connected on snapshot and stale after the deadline', () => {
  let now = 1000;
  const changes = [];
  const health = createReceiverHealth({
    workspaceId: 'workspace-1',
    roomId: 'classroom-1',
    staleAfterMs: 20000,
    now: () => now,
    onChange: (state) => changes.push(state),
  });
  const snapshot = {
    schemaVersion: 1,
    workspaceId: 'workspace-1', roomId: 'classroom-1', revision: 9,
    serverTimestamp: 1000, confirmedState: {}, pendingCommands: [],
    lastCommandId: null, deviceStates: {}, layoutState: {},
    classroomProgram: {}, livestreamProgram: {}, recordingState: {}, streamState: {},
  };
  assert.equal(health.acceptSnapshot(snapshot).state, 'connected');
  assert.equal(health.report().revision, 9);
  now += 20001;
  assert.equal(health.checkFreshness().state, 'stale');
  assert.equal(changes.at(-1).state, 'stale');
});

test('receiver health exposes disconnect and snapshot validation errors', () => {
  const health = createReceiverHealth({ workspaceId: 'workspace-1', roomId: 'classroom-1' });
  assert.equal(health.markStale('temporary disconnect').state, 'stale');
  assert.equal(health.acceptSnapshot({ workspaceId: 'wrong' }).state, 'error');
  assert.equal(health.report().code, 'INCOMPLETE_SNAPSHOT');
});
