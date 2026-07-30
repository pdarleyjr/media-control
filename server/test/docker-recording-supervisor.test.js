'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  buildRecordingFfmpegArgs,
  createDockerRecordingSupervisor,
} = require('../../kamrui-media-edge/camera-api/recording-supervisor');

const IMAGE_ID = `sha256:${'8'.repeat(64)}`;
const CONTAINER_ID = 'a'.repeat(64);
const SESSION_ID = 'ses_fixture';
const NONCE = 'b'.repeat(64);
const RECORDING_ROOT = '/mnt/data/recordings';
const SOURCE = 'rtsp://127.0.0.1:8554/anpviz-main';
const OUTPUT_PATTERN = `${RECORDING_ROOT}/active/${SESSION_ID}/recording_001_%03d.mp4`;

function runtimeIdentity() {
  return {
    backend: 'docker',
    containerId: CONTAINER_ID,
    containerName: `mbfd-camera-recording-${SESSION_ID}`,
    imageRef: IMAGE_ID,
    imageId: IMAGE_ID,
    imageDigest: IMAGE_ID,
    sessionId: SESSION_ID,
    sessionNonce: NONCE,
    outputPath: OUTPUT_PATTERN,
    recordingRoot: RECORDING_ROOT,
    commandHash: 'fixture-command-hash',
    runAsUser: '1000:1000',
    startedAt: '2026-07-26T18:00:00.000000000Z',
  };
}

function persistedIdentity() {
  return {
    supervisor: 'docker',
    ...runtimeIdentity(),
  };
}

test('Docker supervisor constructs the same bounded FFmpeg recording command as the systemd runner', () => {
  assert.deepEqual(buildRecordingFfmpegArgs({
    source: SOURCE,
    outputPattern: OUTPUT_PATTERN,
    segmentSeconds: 1800,
  }), [
    '-nostdin', '-hide_banner', '-loglevel', 'warning', '-n',
    '-rtsp_transport', 'tcp', '-i', SOURCE,
    '-map', '0:v:0', '-map', '0:a:0?',
    '-c:v', 'copy', '-c:a', 'aac', '-ar', '48000', '-ac', '1', '-b:a', '96k',
    '-af', 'aresample=async=1:first_pts=0',
    '-max_muxing_queue_size', '1024',
    '-f', 'segment', '-segment_time', '1800',
    '-segment_format', 'mp4', '-reset_timestamps', '1',
    '-movflags', '+frag_keyframe+empty_moov+default_base_moof',
    OUTPUT_PATTERN,
  ]);
});

test('Docker supervisor starts through the runtime and returns a durable supervisor identity', async () => {
  const starts = [];
  const supervisor = createDockerRecordingSupervisor({
    recordingRoot: RECORDING_ROOT,
    imageRef: IMAGE_ID,
    runtime: {
      start: async (options) => {
        starts.push(options);
        return runtimeIdentity();
      },
    },
  });

  const identity = await supervisor.startSession({
    sessionId: SESSION_ID,
    source: SOURCE,
    outputPattern: OUTPUT_PATTERN,
    nonce: NONCE,
    segmentSeconds: 1800,
  });

  assert.equal(supervisor.supervisor, 'docker');
  assert.deepEqual(identity, persistedIdentity());
  assert.equal(starts.length, 1);
  assert.equal(starts[0].sessionId, SESSION_ID);
  assert.equal(starts[0].sessionNonce, NONCE);
  assert.equal(starts[0].sourceUrl, SOURCE);
  assert.equal(starts[0].outputPattern, OUTPUT_PATTERN);
  assert.equal(starts[0].recordingRoot, RECORDING_ROOT);
  assert.deepEqual(starts[0].ffmpegArgs, buildRecordingFfmpegArgs({
    source: SOURCE,
    outputPattern: OUTPUT_PATTERN,
    segmentSeconds: 1800,
  }));
});

test('Docker supervisor re-adopts only the exact persisted running identity', async () => {
  const identity = persistedIdentity();
  const inspections = [];
  const supervisor = createDockerRecordingSupervisor({
    recordingRoot: RECORDING_ROOT,
    imageRef: IMAGE_ID,
    runtime: {
      inspect: async (candidate) => {
        inspections.push(candidate);
        return { status: 'running', actual: { State: { Running: true } } };
      },
    },
  });

  const recovered = await supervisor.recoverSession({
    sessionId: SESSION_ID,
    outputPattern: OUTPUT_PATTERN,
    identity,
  });
  assert.equal(recovered.active, true);
  assert.deepEqual(recovered.identity, identity);
  assert.deepEqual(inspections, [identity]);

  await assert.rejects(supervisor.recoverSession({
    sessionId: SESSION_ID,
    outputPattern: OUTPUT_PATTERN,
    identity: { ...identity, sessionId: 'ses_other' },
  }), /identity mismatch/i);
});

test('Docker supervisor distinguishes a stopped container from fail-closed runtime uncertainty', async () => {
  const identity = persistedIdentity();
  const stopped = createDockerRecordingSupervisor({
    recordingRoot: RECORDING_ROOT,
    imageRef: IMAGE_ID,
    runtime: { inspect: async () => ({ status: 'stopped', exitCode: 0 }) },
  });
  assert.deepEqual(await stopped.recoverSession({
    sessionId: SESSION_ID,
    outputPattern: OUTPUT_PATTERN,
    identity,
  }), {
    active: false,
    status: { status: 'stopped', exitCode: 0 },
  });

  for (const inspection of [
    { status: 'identity_mismatch', reason: 'nonce label' },
    { status: 'unavailable', error: 'Docker socket unavailable' },
  ]) {
    const uncertain = createDockerRecordingSupervisor({
      recordingRoot: RECORDING_ROOT,
      imageRef: IMAGE_ID,
      runtime: { inspect: async () => inspection },
    });
    await assert.rejects(uncertain.recoverSession({
      sessionId: SESSION_ID,
      outputPattern: OUTPUT_PATTERN,
      identity,
    }), /refusing automatic reconciliation/i);
  }
});

test('Docker supervisor stop passes the exact persisted identity to the fail-closed runtime', async () => {
  const identity = persistedIdentity();
  const stops = [];
  const supervisor = createDockerRecordingSupervisor({
    recordingRoot: RECORDING_ROOT,
    imageRef: IMAGE_ID,
    runtime: {
      stop: async (candidate) => {
        stops.push(candidate);
        return { stopped: true, signal: 'SIGINT' };
      },
    },
  });

  const result = await supervisor.stopSession({
    sessionId: SESSION_ID,
    outputPattern: OUTPUT_PATTERN,
    identity,
  });
  assert.deepEqual(stops, [identity]);
  assert.deepEqual(result, {
    stopped: true,
    alreadyStopped: false,
    status: { stopped: true, signal: 'SIGINT' },
  });
});

test('camera API selects the configured supervisor and supplies persisted identity for recovery and stop', () => {
  const edge = fs.readFileSync(
    path.join(__dirname, '..', '..', 'kamrui-media-edge', 'camera-api', 'server.js'),
    'utf8'
  );
  const environment = fs.readFileSync(
    path.join(__dirname, '..', '..', 'kamrui-media-edge', '.env.example'),
    'utf8'
  );

  assert.match(edge, /RECORDING_BACKEND/);
  assert.match(edge, /RECORDING_DOCKER_IMAGE/);
  assert.match(edge, /createDockerRecordingSupervisor/);
  assert.match(edge, /recordingSupervisor\.recoverSession\(\{[\s\S]*?identity[,}]/);
  assert.match(edge, /recordingSupervisor\.stopSession\(\{[\s\S]*?identity[,}]/);
  assert.match(environment, /^RECORDING_BACKEND=systemd$/m);
  assert.match(environment, /^RECORDING_DOCKER_IMAGE=$/m);
});
