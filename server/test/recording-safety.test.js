'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  atomicWriteJson,
  acquireFilesystemLease,
  releaseFilesystemLease,
  processIdentityMatches,
  readProcessIdentity,
  hashCommand,
  validateFinalizedMedia,
  isInterruptedFinalization,
  acceptFilesystemNonce,
  revisionPrecondition,
  stopValidatedProcess,
} = require('../../kamrui-media-edge/camera-api/recording-safety');
const cameraControl = require('../lib/camera-control-client');
const serverConfig = require('../config');

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mbfd-recording-safety-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('atomicWriteJson replaces a file without leaving a temporary file', (t) => {
  const dir = tempDir(t);
  const target = path.join(dir, 'metadata.json');
  atomicWriteJson(target, { revision: 1 });
  atomicWriteJson(target, { revision: 2 });
  assert.deepEqual(JSON.parse(fs.readFileSync(target, 'utf8')), { revision: 2 });
  assert.deepEqual(fs.readdirSync(dir), ['metadata.json']);
});

test('atomicWriteJson cleans up its temporary file when serialization fails', (t) => {
  const dir = tempDir(t);
  const target = path.join(dir, 'metadata.json');
  const circular = {};
  circular.self = circular;
  assert.throws(() => atomicWriteJson(target, circular), /circular/i);
  assert.deepEqual(fs.readdirSync(dir), []);
});

test('filesystem deletion lease survives process memory and rejects a second owner', (t) => {
  const root = tempDir(t);
  assert.equal(acquireFilesystemLease(root, 'ses_fixture', 'owner-a', 60_000, 1000).acquired, true);
  const conflict = acquireFilesystemLease(root, 'ses_fixture', 'owner-b', 60_000, 1001);
  assert.equal(conflict.acquired, false);
  assert.equal(conflict.lease.owner, 'owner-a');
  assert.equal(releaseFilesystemLease(root, 'ses_fixture', 'owner-b'), false);
  assert.equal(releaseFilesystemLease(root, 'ses_fixture', 'owner-a'), true);
});

test('expired filesystem deletion lease is recoverable by a new owner', (t) => {
  const root = tempDir(t);
  acquireFilesystemLease(root, 'ses_fixture', 'owner-a', 100, 1000);
  const recovered = acquireFilesystemLease(root, 'ses_fixture', 'owner-b', 100, 1200);
  assert.equal(recovered.acquired, true);
  assert.equal(recovered.lease.owner, 'owner-b');
});

test('filesystem lease rejects invalid input and recovers an unreadable stale lease', (t) => {
  const root = tempDir(t);
  assert.throws(() => acquireFilesystemLease(root, '../escape', 'owner'), /session/i);
  assert.throws(() => acquireFilesystemLease(root, 'ses_fixture', ''), /owner/i);
  assert.equal(releaseFilesystemLease(root, 'ses_missing', 'owner'), false);
  const lock = path.join(root, 'ses_fixture.lock');
  fs.mkdirSync(lock);
  fs.writeFileSync(path.join(lock, 'lease.json'), '{invalid');
  assert.equal(acquireFilesystemLease(root, 'ses_fixture', 'owner', 100, 1000).acquired, true);
});

test('process identity requires PID start time executable command output nonce and process group', () => {
  const expected = {
    pid: 42,
    startTime: '9981',
    executable: '/usr/bin/ffmpeg',
    commandHash: 'abc',
    outputPath: '/recordings/active/ses_fixture/out.mp4',
    sessionNonce: 'nonce',
    processGroup: 42,
  };
  assert.equal(processIdentityMatches(expected, { ...expected }), true);
  for (const key of ['pid', 'startTime', 'executable', 'commandHash', 'outputPath', 'sessionNonce', 'processGroup']) {
    assert.equal(processIdentityMatches(expected, { ...expected, [key]: `${expected[key]}-changed` }), false, key);
  }
});

test('readProcessIdentity derives start time command output nonce and process group from proc', () => {
  const args = ['/usr/bin/ffmpeg', '-i', 'rtsp://127.0.0.1/source', '/recordings/out.mp4'];
  // stat fields 3..22 after the parenthesized process name.
  const fields = ['S', '1', '42', '42', '0', '0', '0', '0', '0', '0', '0', '0', '0', '0', '0', '0', '0', '0', '0', '9981'];
  const actual = readProcessIdentity(42, {
    procRoot: '/fixture-proc',
    expectedOutputPath: '/recordings/out.mp4',
    readlink: () => '/usr/bin/ffmpeg (deleted)',
    readFile: (file) => {
      if (file.endsWith('stat')) return `42 (ffmpeg worker) ${fields.join(' ')}`;
      if (file.endsWith('cmdline')) return Buffer.from(`${args.join('\0')}\0`);
      if (file.endsWith('environ')) return Buffer.from('A=B\0MBFD_RECORDING_NONCE=nonce-fixture\0');
      throw new Error(`unexpected fixture file ${file}`);
    },
  });
  assert.deepEqual(actual, {
    pid: 42,
    startTime: '9981',
    executable: '/usr/bin/ffmpeg',
    commandHash: hashCommand(args),
    outputPath: path.resolve('/recordings/out.mp4'),
    sessionNonce: 'nonce-fixture',
    processGroup: 42,
  });
});

test('readProcessIdentity rejects invalid proc data and handles absent output and nonce', () => {
  assert.throws(() => readProcessIdentity(1), /PID/);
  assert.throws(() => readProcessIdentity(42, {
    readFile: () => 'not-a-stat',
    readlink: () => '/usr/bin/ffmpeg',
  }), /proc stat/);
  const fields = ['S', '1', '42', '42', '0', '0', '0', '0', '0', '0', '0', '0', '0', '0', '0', '0', '0', '0', '0', '1'];
  const identity = readProcessIdentity(42, {
    readlink: () => '/usr/bin/ffmpeg',
    readFile: (file) => {
      if (file.endsWith('stat')) return `42 (ffmpeg) ${fields.join(' ')}`;
      return Buffer.from('');
    },
  });
  assert.equal(identity.outputPath, null);
  assert.equal(identity.sessionNonce, null);
});

test('process identity comparison fails closed on absent descriptors', () => {
  assert.equal(processIdentityMatches(null, null), false);
});

test('permanent deletion precondition returns 428 absent and 412 stale', () => {
  assert.deepEqual(revisionPrecondition(undefined, 'rev-1'), {
    ok: false,
    status: 428,
    error: 'If-Match is required',
  });
  assert.equal(revisionPrecondition('rev-old', 'rev-1').status, 412);
  assert.equal(revisionPrecondition('rev-1', 'rev-1').ok, true);
  assert.equal(revisionPrecondition('"rev-1"', 'rev-1').ok, true);
});

test('finalized media validation fails closed on probe codecs dimensions duration size and checksum', () => {
  const valid = {
    probe: {
      format: { duration: '61.25', size: '4096' },
      streams: [
        { codec_type: 'video', codec_name: 'h264', width: 1920, height: 1080 },
        { codec_type: 'audio', codec_name: 'aac' },
      ],
    },
    sha256: 'a'.repeat(64),
  };
  assert.equal(validateFinalizedMedia(valid).ok, true);
  for (const invalid of [
    { ...valid, probe: null },
    { ...valid, probe: { ...valid.probe, streams: [valid.probe.streams[0]] } },
    { ...valid, probe: { ...valid.probe, streams: [{ ...valid.probe.streams[0], codec_name: 'hevc' }, valid.probe.streams[1]] } },
    { ...valid, probe: { ...valid.probe, format: { duration: '0', size: '4096' } } },
    { ...valid, sha256: null },
    { ...valid, sha256: 'not-a-checksum' },
  ]) {
    assert.equal(validateFinalizedMedia(invalid).ok, false);
  }
});

test('restart recovery recognizes a persisted finalization even when recording is false', () => {
  assert.equal(isInterruptedFinalization({
    recording: false,
    recordingSessionId: 'ses_fixture',
    recordingState: 'finalizing',
    finalizationState: 'finalizing',
  }), true);
  assert.equal(isInterruptedFinalization({
    recording: false,
    recordingSessionId: 'ses_fixture',
    recordingState: 'failed',
    finalizationState: 'failed',
  }), false);
});

test('service nonce replay cache survives process memory via the filesystem', (t) => {
  const root = tempDir(t);
  const nonce = '12345678-1234-1234-1234-123456789abc';
  assert.equal(acceptFilesystemNonce(root, nonce, 100, 1000), true);
  assert.equal(acceptFilesystemNonce(root, nonce, 100, 1050), false);
  assert.equal(acceptFilesystemNonce(root, nonce, 100, 1100), true);
  assert.throws(() => acceptFilesystemNonce(root, '../escape', 100, 1000), /nonce/i);
});

test('Media Control signs service identity, If-Match, one-time nonce and authenticated operator', (t) => {
  const previous = {
    secret: serverConfig.cameraControl.signingSecret,
    id: serverConfig.cameraControl.signingKeyId,
    version: serverConfig.cameraControl.signingKeyVersion,
  };
  serverConfig.cameraControl.signingSecret = 'fixture-signing-secret';
  serverConfig.cameraControl.signingKeyId = 'media-control';
  serverConfig.cameraControl.signingKeyVersion = 'fixture-v1';
  t.after(() => {
    serverConfig.cameraControl.signingSecret = previous.secret;
    serverConfig.cameraControl.signingKeyId = previous.id;
    serverConfig.cameraControl.signingKeyVersion = previous.version;
  });
  const rawBody = Buffer.from(JSON.stringify({ confirm: 'ses_fixture' }));
  const timestampMs = 1785072600123;
  const nonce = '12345678-1234-4234-8234-123456789abc';
  const headers = cameraControl.serviceHeaders(
    'DELETE',
    '/api/recordings/ses_fixture',
    rawBody,
    'user-fixture',
    { 'If-Match': '"rev-fixture"', 'Content-Type': 'application/json' },
    timestampMs,
    nonce
  );
  assert.equal(headers['X-Service-Timestamp'], String(timestampMs));
  assert.match(headers['X-Service-Signature'], /^[a-f0-9]{64}$/);
  assert.equal(headers['X-Service-Nonce'], nonce);
  assert.equal(headers['X-Operator-Id'], 'user-fixture');
  assert.equal(headers['X-Service-Key-Id'], 'media-control');
  assert.equal(headers['X-Service-Key-Version'], 'fixture-v1');
  const bodyHash = crypto.createHash('sha256')
    .update(rawBody)
    .digest('hex');
  const expected = crypto.createHmac('sha256', 'fixture-signing-secret')
    .update([
      'MBFD-CAMERA-SERVICE-HMAC-SHA256-V1',
      'DELETE',
      '/api/recordings/ses_fixture',
      bodyHash,
      String(timestampMs),
      nonce,
      '"rev-fixture"',
      'application/json',
      'user-fixture',
      'media-control',
      'fixture-v1',
    ].join('\n'))
    .digest('hex');
  assert.equal(headers['X-Service-Signature'], expected);
});

test('stopValidatedProcess refuses to signal a PID whose identity changed', async () => {
  let signalled = false;
  await assert.rejects(
    stopValidatedProcess(
      { pid: 42, startTime: 'old', executable: '/usr/bin/ffmpeg', commandHash: 'a', outputPath: '/x', sessionNonce: 'n', processGroup: 42 },
      {
        readIdentity: async () => ({ pid: 42, startTime: 'new', executable: '/usr/bin/ffmpeg', commandHash: 'a', outputPath: '/x', sessionNonce: 'n', processGroup: 42 }),
        signalGroup: async () => { signalled = true; },
      }
    ),
    /identity/i
  );
  assert.equal(signalled, false);
});

test('stopValidatedProcess polls a re-adopted process instead of waiting for close', async () => {
  const expected = { pid: 42, startTime: '1', executable: '/usr/bin/ffmpeg', commandHash: 'a', outputPath: '/x', sessionNonce: 'n', processGroup: 42 };
  const signals = [];
  let aliveChecks = 0;
  const result = await stopValidatedProcess(expected, {
    readIdentity: async () => expected,
    signalGroup: async (_pgid, signal) => { signals.push(signal); },
    isAlive: async () => ++aliveChecks < 3,
    pollIntervalMs: 1,
    gracefulTimeoutMs: 50,
  });
  assert.equal(result.signal, 'SIGINT');
  assert.deepEqual(signals, ['SIGINT']);
});

test('stopValidatedProcess revalidates identity before bounded SIGKILL escalation', async () => {
  const expected = { pid: 42, startTime: '1', executable: '/usr/bin/ffmpeg', commandHash: 'a', outputPath: '/x', sessionNonce: 'n', processGroup: 42 };
  const signals = [];
  let aliveChecks = 0;
  const result = await stopValidatedProcess(expected, {
    readIdentity: async () => expected,
    signalGroup: async (_pgid, signal) => { signals.push(signal); },
    isAlive: async () => ++aliveChecks <= 2,
    pollIntervalMs: 1,
    gracefulTimeoutMs: 0,
    killTimeoutMs: 5,
  });
  assert.equal(result.signal, 'SIGKILL');
  assert.deepEqual(signals, ['SIGINT', 'SIGKILL']);
});

test('stopValidatedProcess refuses a process that is not its group leader', async () => {
  const expected = { pid: 42, startTime: '1', executable: '/usr/bin/ffmpeg', commandHash: 'a', outputPath: '/x', sessionNonce: 'n', processGroup: 41 };
  await assert.rejects(
    stopValidatedProcess(expected, { readIdentity: async () => expected }),
    /process-group leader/
  );
});

test('stopValidatedProcess refuses SIGKILL when identity changes during grace period', async () => {
  const expected = { pid: 42, startTime: '1', executable: '/usr/bin/ffmpeg', commandHash: 'a', outputPath: '/x', sessionNonce: 'n', processGroup: 42 };
  let reads = 0;
  await assert.rejects(
    stopValidatedProcess(expected, {
      readIdentity: async () => (++reads === 1 ? expected : { ...expected, startTime: '2' }),
      signalGroup: async () => {},
      isAlive: async () => true,
      pollIntervalMs: 1,
      gracefulTimeoutMs: 0,
    }),
    /changed before SIGKILL/
  );
});

test('stopValidatedProcess reports a process group that survives SIGKILL', async () => {
  const expected = { pid: 42, startTime: '1', executable: '/usr/bin/ffmpeg', commandHash: 'a', outputPath: '/x', sessionNonce: 'n', processGroup: 42 };
  await assert.rejects(
    stopValidatedProcess(expected, {
      readIdentity: async () => expected,
      signalGroup: async () => {},
      isAlive: async () => true,
      pollIntervalMs: 1,
      gracefulTimeoutMs: 0,
      killTimeoutMs: 0,
    }),
    /did not terminate/
  );
});

test('camera edge source recovers finalization and serializes all recording metadata operations', () => {
  const src = fs.readFileSync(
    path.join(__dirname, '..', '..', 'kamrui-media-edge', 'camera-api', 'server.js'),
    'utf8'
  );
  assert.match(src, /recordingSessionId/);
  assert.match(src, /livestreamSessionId/);
  assert.match(src, /finalizationState/);
  assert.match(src, /status\(428\)/);
  assert.doesNotMatch(src, /const deletionLocks = new Map/);
  assert.match(src, /remote_deleted|remote_verified/);
  assert.match(src, /deletionState/);
  assert.match(src, /originalPeerTubeUuid/);
  assert.match(src, /requireServiceAuth/);
  assert.match(src, /finalizationState === 'finalizing'/);
  assert.match(src, /validateFinalizedMedia/);
  assert.match(src, /acquireRecordingOperationLease/);
  assert.match(src, /syncToGmktec[\s\S]*acquireRecordingOperationLease/);
  assert.match(src, /uploadToPeerTube[\s\S]*acquireRecordingOperationLease/);
  assert.match(src, /\/restore[\s\S]*acquireRecordingOperationLease/);
  assert.match(src, /\/peertube[\s\S]*acquireRecordingOperationLease/);
  assert.match(src, /verifyServiceRequest/);
  assert.match(src, /acceptFilesystemNonce/);
  assert.match(src, /res\.status\(finalizeResult\.ok \? 200 : 422\)\.json\(response\)/);
});

test('global camera recordings are platform-admin-only and edge requests bind If-Match', () => {
  const route = fs.readFileSync(path.join(__dirname, '..', 'routes', 'live-stream.js'), 'utf8');
  const client = fs.readFileSync(path.join(__dirname, '..', 'lib', 'camera-control-client.js'), 'utf8');
  assert.match(route, /requireGlobalCameraAdmin/);
  assert.match(route, /req\.user\.role !== 'platform_admin'/);
  assert.match(route, /get\('\/recordings', requireGlobalCameraAdmin/);
  assert.match(route, /post\('\/recordings\/:id\/archive', requireGlobalCameraAdmin/);
  assert.match(route, /post\('\/recordings\/:id\/restore', requireGlobalCameraAdmin/);
  assert.match(route, /delete\('\/recordings\/:id', requireGlobalCameraAdmin/);
  assert.match(route, /delete\('\/recordings\/:id\/peertube', requireGlobalCameraAdmin/);
  assert.match(route, /plan\.recording_requested === true && req\.user\?\.role !== 'platform_admin'/);
  assert.match(client, /signServiceRequest/);
  assert.match(client, /serviceHeaders/);
  assert.match(client, /headerValue\(signedHeaders, 'if-match'\)/);
  assert.match(client, /operatorId: String\(operatorId/);
});
