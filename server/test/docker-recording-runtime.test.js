'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const {
  createDockerRecordingRuntime,
  dockerIdentityMatches,
  immutableImageDigest,
} = require('../../kamrui-media-edge/camera-api/docker-recording-runtime');
const { hashCommand } = require('../../kamrui-media-edge/camera-api/recording-safety');

const IMAGE_ID = 'sha256:8fe52acaf89b28e7c82a190a41c5829c8073299d90019b1db12805928c09cab3';
const CONTAINER_ID = 'a'.repeat(64);
const SESSION_ID = 'ses_123_fixture';
const NONCE = 'b'.repeat(64);
const RECORDING_ROOT = path.resolve('/mnt/data/recordings');
const OUTPUT_PATTERN = path.join(RECORDING_ROOT, 'active', SESSION_ID, 'recording_%03d.mp4');
const SOURCE = 'rtsp://127.0.0.1:8554/annke-main';
const FFMPEG_ARGS = ['-nostdin', '-i', SOURCE, OUTPUT_PATTERN];

function inspectFixture(overrides = {}) {
  return {
    Id: CONTAINER_ID,
    Image: IMAGE_ID,
    Name: `/mbfd-camera-recording-${SESSION_ID}`,
    Config: {
      Image: IMAGE_ID,
      Cmd: FFMPEG_ARGS,
      User: '1000:1000',
      Labels: {
        'com.mbfd.camera.recording': '1',
        'com.mbfd.camera.session': SESSION_ID,
        'com.mbfd.camera.nonce': NONCE,
      },
    },
    State: {
      Running: true,
      Status: 'running',
      StartedAt: '2026-07-26T18:00:00.000000000Z',
    },
    HostConfig: {
      NetworkMode: 'host',
      ReadonlyRootfs: true,
      CapDrop: ['ALL'],
      SecurityOpt: ['no-new-privileges'],
      PidsLimit: 128,
    },
    Mounts: [{
      Type: 'bind',
      Source: RECORDING_ROOT,
      Destination: RECORDING_ROOT,
      RW: true,
    }],
    ...overrides,
  };
}

function expectedIdentity() {
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
    commandHash: hashCommand(FFMPEG_ARGS),
    runAsUser: '1000:1000',
    startedAt: '2026-07-26T18:00:00.000000000Z',
  };
}

test('Docker recorder accepts only immutable sha256 image references', () => {
  assert.equal(immutableImageDigest(IMAGE_ID), IMAGE_ID);
  assert.equal(
    immutableImageDigest(`mbfd/camera-ffmpeg@${IMAGE_ID}`),
    IMAGE_ID
  );
  for (const invalid of [
    '',
    'mbfd/camera-ffmpeg:local',
    'latest',
    'sha256:not-a-digest',
    `mbfd/camera-ffmpeg:${IMAGE_ID}`,
  ]) {
    assert.throws(() => immutableImageDigest(invalid), /immutable.*sha256/i);
  }
});

test('Docker recorder launches a detached named least-privilege container and validates its identity', async () => {
  const calls = [];
  const execDocker = async (args) => {
    calls.push(args);
    if (args[0] === 'image') return { stdout: `${IMAGE_ID}\n`, stderr: '' };
    if (args[0] === 'run') return { stdout: `${CONTAINER_ID}\n`, stderr: '' };
    if (args[0] === 'inspect') return { stdout: JSON.stringify([inspectFixture()]), stderr: '' };
    throw new Error(`Unexpected docker call: ${args.join(' ')}`);
  };
  const runtime = createDockerRecordingRuntime({
    imageRef: IMAGE_ID,
    execDocker,
    uid: 1000,
    gid: 1000,
  });

  const identity = await runtime.start({
    sessionId: SESSION_ID,
    sessionNonce: NONCE,
    sourceUrl: SOURCE,
    outputPattern: OUTPUT_PATTERN,
    recordingRoot: RECORDING_ROOT,
    ffmpegArgs: FFMPEG_ARGS,
  });

  assert.deepEqual(identity, expectedIdentity());
  const run = calls.find((args) => args[0] === 'run');
  assert.ok(run);
  for (const required of [
    '--detach',
    '--rm',
    '--network=host',
    '--user=1000:1000',
    '--cap-drop=ALL',
    '--security-opt=no-new-privileges',
    '--read-only',
    '--pids-limit=128',
    `--name=mbfd-camera-recording-${SESSION_ID}`,
    `--label=com.mbfd.camera.session=${SESSION_ID}`,
    `--label=com.mbfd.camera.nonce=${NONCE}`,
    `--mount=type=bind,src=${RECORDING_ROOT},dst=${RECORDING_ROOT}`,
    '--entrypoint=ffmpeg',
    IMAGE_ID,
  ]) {
    assert.ok(run.includes(required), required);
  }
  assert.ok(
    !run.some((argument) => /^--mount=.*(?:^|,)rw(?:,|$)/.test(argument)),
    'Docker --mount does not accept a bare rw field; writable is the default',
  );
  assert.deepEqual(run.slice(-FFMPEG_ARGS.length), FFMPEG_ARGS);
});

test('repository digest references bind the resolved image ID without equating manifest and config digests', async () => {
  const imageRef = `mbfd/camera-ffmpeg@${IMAGE_ID}`;
  const resolvedImageId = `sha256:${'9'.repeat(64)}`;
  const execDocker = async (args) => {
    if (args[0] === 'image') {
      return {
        stdout: JSON.stringify([{
          Id: resolvedImageId,
          RepoDigests: [imageRef],
        }]),
        stderr: '',
      };
    }
    if (args[0] === 'run') return { stdout: `${CONTAINER_ID}\n`, stderr: '' };
    if (args[0] === 'inspect') {
      return {
        stdout: JSON.stringify([inspectFixture({
          Image: resolvedImageId,
          Config: { ...inspectFixture().Config, Image: imageRef },
        })]),
        stderr: '',
      };
    }
    throw new Error(`Unexpected docker call: ${args.join(' ')}`);
  };
  const runtime = createDockerRecordingRuntime({
    imageRef,
    execDocker,
    uid: 1000,
    gid: 1000,
  });

  const identity = await runtime.start({
    sessionId: SESSION_ID,
    sessionNonce: NONCE,
    sourceUrl: SOURCE,
    outputPattern: OUTPUT_PATTERN,
    recordingRoot: RECORDING_ROOT,
    ffmpegArgs: FFMPEG_ARGS,
  });

  assert.equal(identity.imageRef, imageRef);
  assert.equal(identity.imageId, resolvedImageId);
  assert.equal(identity.imageDigest, IMAGE_ID);
});

test('Docker recorder refuses non-loopback sources and output paths outside the session directory', async () => {
  const runtime = createDockerRecordingRuntime({
    imageRef: IMAGE_ID,
    execDocker: async () => {
      throw new Error('Docker must not be called for invalid input');
    },
    uid: 1000,
    gid: 1000,
  });
  await assert.rejects(runtime.start({
    sessionId: SESSION_ID,
    sessionNonce: NONCE,
    sourceUrl: 'rtsp://camera-user:camera-pass@192.168.1.226/live',
    outputPattern: OUTPUT_PATTERN,
    recordingRoot: RECORDING_ROOT,
    ffmpegArgs: FFMPEG_ARGS,
  }), /credential-free loopback/i);
  await assert.rejects(runtime.start({
    sessionId: SESSION_ID,
    sessionNonce: NONCE,
    sourceUrl: SOURCE,
    outputPattern: path.join(RECORDING_ROOT, 'completed', 'escaped.mp4'),
    recordingRoot: RECORDING_ROOT,
    ffmpegArgs: FFMPEG_ARGS,
  }), /session directory/i);
});

test('Docker identity comparison covers container, image, command, nonce, mount, and confinement', () => {
  const expected = expectedIdentity();
  assert.equal(dockerIdentityMatches(expected, inspectFixture()).matches, true);
  const mutations = [
    { Id: 'c'.repeat(64) },
    { Image: 'sha256:' + 'd'.repeat(64) },
    { Name: '/unexpected-name' },
    { Config: { ...inspectFixture().Config, Cmd: ['different'] } },
    { Config: {
      ...inspectFixture().Config,
      Labels: { ...inspectFixture().Config.Labels, 'com.mbfd.camera.nonce': 'changed' },
    } },
    { HostConfig: { ...inspectFixture().HostConfig, NetworkMode: 'bridge' } },
    { HostConfig: { ...inspectFixture().HostConfig, ReadonlyRootfs: false } },
    { Config: { ...inspectFixture().Config, User: '0:0' } },
    { Mounts: [{ ...inspectFixture().Mounts[0], Source: '/tmp/recordings' }] },
  ];
  for (const mutation of mutations) {
    assert.equal(dockerIdentityMatches(expected, inspectFixture(mutation)).matches, false);
  }
});

test('Docker inspection distinguishes stopped, identity mismatch, and runtime unavailable', async () => {
  const missing = createDockerRecordingRuntime({
    imageRef: IMAGE_ID,
    execDocker: async () => {
      const error = new Error('No such object');
      error.code = 1;
      error.stderr = `Error: No such object: ${CONTAINER_ID}`;
      throw error;
    },
  });
  assert.deepEqual(await missing.inspect(expectedIdentity()), { status: 'stopped' });

  const mismatched = createDockerRecordingRuntime({
    imageRef: IMAGE_ID,
    execDocker: async () => ({
      stdout: JSON.stringify([inspectFixture({ Image: `sha256:${'d'.repeat(64)}` })]),
      stderr: '',
    }),
  });
  assert.equal((await mismatched.inspect(expectedIdentity())).status, 'identity_mismatch');

  const unavailable = createDockerRecordingRuntime({
    imageRef: IMAGE_ID,
    execDocker: async () => {
      const error = new Error('connect permission denied');
      error.code = 1;
      error.stderr = 'permission denied while trying to connect to the Docker daemon socket';
      throw error;
    },
  });
  assert.equal((await unavailable.inspect(expectedIdentity())).status, 'unavailable');
});

test('Docker stop fails closed without signalling when durable identity changed', async () => {
  const calls = [];
  const runtime = createDockerRecordingRuntime({
    imageRef: IMAGE_ID,
    execDocker: async (args) => {
      calls.push(args);
      if (args[0] === 'inspect') {
        return {
          stdout: JSON.stringify([inspectFixture({
            Config: {
              ...inspectFixture().Config,
              Labels: { ...inspectFixture().Config.Labels, 'com.mbfd.camera.nonce': 'changed' },
            },
          })]),
          stderr: '',
        };
      }
      throw new Error('signal must not be called');
    },
  });
  await assert.rejects(runtime.stop(expectedIdentity()), /identity mismatch.*refusing to signal/i);
  assert.equal(calls.some((args) => args[0] === 'kill'), false);
});

test('Docker stop sends SIGINT to the exact container and observes a clean exit', async () => {
  const calls = [];
  let inspections = 0;
  const runtime = createDockerRecordingRuntime({
    imageRef: IMAGE_ID,
    pollIntervalMs: 0,
    gracefulTimeoutMs: 20,
    execDocker: async (args) => {
      calls.push(args);
      if (args[0] === 'inspect') {
        inspections += 1;
        if (inspections === 1) return { stdout: JSON.stringify([inspectFixture()]), stderr: '' };
        const error = new Error('No such object');
        error.code = 1;
        error.stderr = `No such object: ${CONTAINER_ID}`;
        throw error;
      }
      if (args[0] === 'kill') return { stdout: `${CONTAINER_ID}\n`, stderr: '' };
      throw new Error(`Unexpected docker call: ${args.join(' ')}`);
    },
  });

  assert.deepEqual(await runtime.stop(expectedIdentity()), { stopped: true, signal: 'SIGINT' });
  assert.deepEqual(
    calls.find((args) => args[0] === 'kill'),
    ['kill', '--signal=SIGINT', CONTAINER_ID]
  );
});

test('Docker stop revalidates identity before SIGKILL escalation', async () => {
  const signals = [];
  let inspections = 0;
  const runtime = createDockerRecordingRuntime({
    imageRef: IMAGE_ID,
    pollIntervalMs: 0,
    gracefulTimeoutMs: 0,
    killTimeoutMs: 0,
    execDocker: async (args) => {
      if (args[0] === 'inspect') {
        inspections += 1;
        const fixture = inspections === 1
          ? inspectFixture()
          : inspectFixture({ State: { Running: true }, Image: `sha256:${'e'.repeat(64)}` });
        return { stdout: JSON.stringify([fixture]), stderr: '' };
      }
      if (args[0] === 'kill') {
        signals.push(args[1]);
        return { stdout: `${CONTAINER_ID}\n`, stderr: '' };
      }
      throw new Error(`Unexpected docker call: ${args.join(' ')}`);
    },
  });

  await assert.rejects(runtime.stop(expectedIdentity()), /changed before SIGKILL.*refusing to signal/i);
  assert.deepEqual(signals, ['--signal=SIGINT']);
});
