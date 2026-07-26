'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  buildSessionEnvironment,
  createRecordingSupervisor,
  parseAdminStatus,
} = require('../../kamrui-media-edge/camera-api/recording-supervisor');

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mbfd-recording-supervisor-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function activeStatus(sessionId, outputPattern, mainPid = 4242) {
  return [
    `Id=mbfd-camera-recording@${sessionId}.service`,
    'ActiveState=active',
    'SubState=running',
    `MainPID=${mainPid}`,
    'Result=success',
    'Validated=yes',
    `OutputPath=${outputPattern}`,
  ].join('\n');
}

test('recording supervisor accepts only a credential-free loopback source and fixed session output', () => {
  const valid = buildSessionEnvironment({
    recordingRoot: '/mnt/data/recordings',
    sessionId: 'ses_fixture',
    source: 'rtsp://127.0.0.1:8554/annke-main',
    outputPattern: '/mnt/data/recordings/active/ses_fixture/recording_001_%03d.mp4',
    nonce: 'a'.repeat(64),
    segmentSeconds: 1800,
  });
  assert.equal(valid.MBFD_RECORDING_SESSION_ID, 'ses_fixture');
  assert.equal(valid.MBFD_RECORDING_SEGMENT_SECONDS, '1800');

  assert.throws(() => buildSessionEnvironment({
    recordingRoot: '/mnt/data/recordings',
    sessionId: '../escape',
    source: valid.MBFD_RECORDING_SOURCE,
    outputPattern: valid.MBFD_RECORDING_OUTPUT_PATTERN,
    nonce: valid.MBFD_RECORDING_NONCE,
  }), /session/i);
  assert.throws(() => buildSessionEnvironment({
    recordingRoot: '/mnt/data/recordings',
    sessionId: 'ses_fixture',
    source: 'rtsp://user:password@127.0.0.1/live',
    outputPattern: valid.MBFD_RECORDING_OUTPUT_PATTERN,
    nonce: valid.MBFD_RECORDING_NONCE,
  }), /credential-free loopback/i);
  assert.throws(() => buildSessionEnvironment({
    recordingRoot: '/mnt/data/recordings',
    sessionId: 'ses_fixture',
    source: valid.MBFD_RECORDING_SOURCE,
    outputPattern: '/mnt/data/recordings/active/other/out_%03d.mp4',
    nonce: valid.MBFD_RECORDING_NONCE,
  }), /session directory/i);
});

test('recording supervisor atomically prepares env and starts only a validated session unit', async (t) => {
  const envRoot = tempDir(t);
  const actions = [];
  const outputPattern = '/mnt/data/recordings/active/ses_fixture/recording_001_%03d.mp4';
  const supervisor = createRecordingSupervisor({
    recordingRoot: '/mnt/data/recordings',
    envRoot,
    runAdmin: async (action, sessionId) => {
      actions.push([action, sessionId]);
      if (action === 'start') return { stdout: '' };
      return { stdout: activeStatus(sessionId, outputPattern) };
    },
    pollIntervalMs: 1,
  });

  const identity = await supervisor.startSession({
    sessionId: 'ses_fixture',
    source: 'rtsp://127.0.0.1:8554/annke-main',
    outputPattern,
    nonce: 'b'.repeat(64),
    segmentSeconds: 1800,
  });

  assert.deepEqual(actions, [
    ['start', 'ses_fixture'],
    ['status', 'ses_fixture'],
  ]);
  assert.deepEqual(identity, {
    supervisor: 'systemd',
    unit: 'mbfd-camera-recording@ses_fixture.service',
    sessionId: 'ses_fixture',
    mainPid: 4242,
    outputPath: outputPattern,
  });
  const envPath = path.join(envRoot, 'ses_fixture.env');
  assert.equal(fs.existsSync(envPath), true);
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(envPath).mode & 0o777, 0o640);
  }
  assert.match(fs.readFileSync(envPath, 'utf8'), /MBFD_RECORDING_NONCE=/);
});

test('restart recovery trusts a validated unit and refuses PID-only or mismatched output state', async () => {
  const outputPattern = '/mnt/data/recordings/active/ses_fixture/recording_001_%03d.mp4';
  const supervisor = createRecordingSupervisor({
    recordingRoot: '/mnt/data/recordings',
    runAdmin: async () => ({ stdout: activeStatus('ses_fixture', outputPattern) }),
  });
  const recovered = await supervisor.recoverSession({
    sessionId: 'ses_fixture',
    outputPattern,
  });
  assert.equal(recovered.active, true);
  assert.equal(recovered.identity.supervisor, 'systemd');

  const mismatch = createRecordingSupervisor({
    recordingRoot: '/mnt/data/recordings',
    runAdmin: async () => ({ stdout: activeStatus(
      'ses_fixture',
      '/mnt/data/recordings/active/ses_fixture/unexpected_%03d.mp4'
    ) }),
  });
  await assert.rejects(
    mismatch.recoverSession({ sessionId: 'ses_fixture', outputPattern }),
    /output path/i
  );
  assert.throws(() => parseAdminStatus('MainPID=42\nActiveState=active'), /validated/i);
});

test('stop validates the unit before signalling and removes the secret env after stop', async (t) => {
  const envRoot = tempDir(t);
  const outputPattern = '/mnt/data/recordings/active/ses_fixture/recording_001_%03d.mp4';
  fs.writeFileSync(path.join(envRoot, 'ses_fixture.env'), 'secret fixture\n', { mode: 0o640 });
  const actions = [];
  let stopped = false;
  const supervisor = createRecordingSupervisor({
    recordingRoot: '/mnt/data/recordings',
    envRoot,
    runAdmin: async (action, sessionId) => {
      actions.push([action, sessionId]);
      if (action === 'stop') {
        stopped = true;
        return { stdout: '' };
      }
      if (stopped) {
        return {
          stdout: [
            `Id=mbfd-camera-recording@${sessionId}.service`,
            'ActiveState=inactive',
            'SubState=dead',
            'MainPID=0',
            'Result=success',
            'Validated=inactive',
          ].join('\n'),
        };
      }
      return { stdout: activeStatus(sessionId, outputPattern) };
    },
    pollIntervalMs: 1,
  });

  const result = await supervisor.stopSession({ sessionId: 'ses_fixture', outputPattern });
  assert.equal(result.stopped, true);
  assert.deepEqual(actions, [
    ['status', 'ses_fixture'],
    ['stop', 'ses_fixture'],
    ['status', 'ses_fixture'],
  ]);
  assert.equal(fs.existsSync(path.join(envRoot, 'ses_fixture.env')), false);
});

test('uncertain start failure preserves the environment for startup reconciliation', async (t) => {
  const envRoot = tempDir(t);
  const outputPattern = '/mnt/data/recordings/active/ses_fixture/recording_001_%03d.mp4';
  const supervisor = createRecordingSupervisor({
    recordingRoot: '/mnt/data/recordings',
    envRoot,
    runAdmin: async (action) => {
      throw new Error(`${action} helper unavailable`);
    },
    pollIntervalMs: 1,
  });

  await assert.rejects(
    supervisor.startSession({
      sessionId: 'ses_fixture',
      source: 'rtsp://127.0.0.1:8554/annke-main',
      outputPattern,
      nonce: 'c'.repeat(64),
      segmentSeconds: 1800,
    }),
    error => error.recordingMayBeActive === true
  );
  assert.equal(fs.existsSync(path.join(envRoot, 'ses_fixture.env')), true);
});

test('camera API, installer and unit use the independent recording supervisor contract', () => {
  const edge = fs.readFileSync(
    path.join(__dirname, '..', '..', 'kamrui-media-edge', 'camera-api', 'server.js'),
    'utf8'
  );
  const install = fs.readFileSync(
    path.join(__dirname, '..', '..', 'kamrui-media-edge', 'scripts', 'install.sh'),
    'utf8'
  );
  const upgrade = fs.readFileSync(
    path.join(__dirname, '..', '..', 'kamrui-media-edge', 'scripts', 'upgrade.sh'),
    'utf8'
  );
  const unit = fs.readFileSync(
    path.join(__dirname, '..', '..', 'kamrui-media-edge', 'systemd', 'mbfd-camera-recording@.service'),
    'utf8'
  );
  const helper = fs.readFileSync(
    path.join(__dirname, '..', '..', 'kamrui-media-edge', 'mbfd-recording-admin'),
    'utf8'
  );

  assert.match(edge, /createRecordingSupervisor/);
  assert.match(edge, /recordingSupervisor\.startSession/);
  assert.match(edge, /recordingSupervisor\.recoverSession/);
  assert.match(edge, /recordingSupervisor\.stopSession/);
  assert.match(
    edge,
    /recordingState = 'starting'[\s\S]*saveRecordingState\(\)[\s\S]*recordingSupervisor\.startSession/
  );
  assert.doesNotMatch(edge, /async function startRecordingProcess/);
  assert.match(install, /recording-supervisor\.js/);
  assert.match(upgrade, /mbfd-camera-recording@\.service/);
  assert.match(upgrade, /useradd --system/);
  assert.match(upgrade, /user-long-recording-test\.sh/);
  assert.match(unit, /KillSignal=SIGINT/);
  assert.match(unit, /FinalKillSignal=SIGKILL/);
  assert.match(unit, /TimeoutStopSec=/);
  assert.match(unit, /ExecStart=\/usr\/local\/libexec\/mbfd-camera-recording-run %i/);
  assert.match(unit, /ProtectProc=invisible/);
  assert.match(helper, /Validated=yes/);
  assert.match(helper, /\/proc\/.*cmdline/);
  assert.doesNotMatch(install, /docker\.sock|NOPASSWD:\s*ALL/);
  assert.doesNotMatch(upgrade, /docker\.sock|NOPASSWD:\s*ALL/);
});
