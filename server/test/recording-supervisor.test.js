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

function inactiveStatus(sessionId) {
  return [
    `Id=mbfd-camera-recording@${sessionId}.service`,
    'ActiveState=inactive',
    'SubState=dead',
    'MainPID=0',
    'Result=success',
    'Validated=inactive',
  ].join('\n');
}

test('recording supervisor accepts only a credential-free loopback source and fixed session output', () => {
  const valid = buildSessionEnvironment({
    recordingRoot: '/mnt/data/recordings',
    sessionId: 'ses_fixture',
    source: 'rtsp://127.0.0.1:8554/anpviz-main',
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

test('recording supervisor passes validated environment to the broker and starts only a validated session unit', async (t) => {
  const envRoot = tempDir(t);
  const actions = [];
  const outputPattern = '/mnt/data/recordings/active/ses_fixture/recording_001_%03d.mp4';
  const supervisor = createRecordingSupervisor({
    recordingRoot: '/mnt/data/recordings',
    envRoot,
    runAdmin: async (action, sessionId, environment) => {
      actions.push([action, sessionId, environment ? Object.keys(environment).length : 0]);
      if (action === 'start' && environment) {
        // Simulate the broker writing the env file.
        fs.writeFileSync(path.join(envRoot, `${sessionId}.env`), 'test\n', { mode: 0o640 });
        return { stdout: '' };
      }
      if (action === 'finalize') return { stdout: '' };
      return { stdout: activeStatus(sessionId, outputPattern) };
    },
    pollIntervalMs: 1,
  });

  const identity = await supervisor.startSession({
    sessionId: 'ses_fixture',
    source: 'rtsp://127.0.0.1:8554/anpviz-main',
    outputPattern,
    nonce: 'b'.repeat(64),
    segmentSeconds: 1800,
  });

  // start passes the environment to the broker; status does not.
  assert.deepEqual(actions, [
    ['start', 'ses_fixture', 5],
    ['status', 'ses_fixture', 0],
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

test('stop validates the unit before signalling and cleans up via broker finalize', async (t) => {
  const envRoot = tempDir(t);
  const outputPattern = '/mnt/data/recordings/active/ses_fixture/recording_001_%03d.mp4';
  fs.writeFileSync(path.join(envRoot, 'ses_fixture.env'), 'secret fixture\n', { mode: 0o640 });
  const actions = [];
  let stopped = false;
  const supervisor = createRecordingSupervisor({
    recordingRoot: '/mnt/data/recordings',
    envRoot,
    runAdmin: async (action, sessionId) => {
      actions.push(action);
      if (action === 'stop') {
        stopped = true;
        return { stdout: '' };
      }
      if (action === 'finalize') return { stdout: '' };
      if (stopped) {
        return { stdout: inactiveStatus(sessionId) };
      }
      return { stdout: activeStatus(sessionId, outputPattern) };
    },
    pollIntervalMs: 1,
  });

  const result = await supervisor.stopSession({ sessionId: 'ses_fixture', outputPattern });
  assert.equal(result.stopped, true);
  assert.deepEqual(actions, ['status', 'stop', 'status', 'finalize']);
});

test('uncertain start failure preserves recordingMayBeActive for startup reconciliation', async (t) => {
  const envRoot = tempDir(t);
  const outputPattern = '/mnt/data/recordings/active/ses_fixture/recording_001_%03d.mp4';
  const supervisor = createRecordingSupervisor({
    recordingRoot: '/mnt/data/recordings',
    envRoot,
    runAdmin: async (action) => {
      throw new Error(`${action} broker unavailable`);
    },
    pollIntervalMs: 1,
  });

  await assert.rejects(
    supervisor.startSession({
      sessionId: 'ses_fixture',
      source: 'rtsp://127.0.0.1:8554/anpviz-main',
      outputPattern,
      nonce: 'c'.repeat(64),
      segmentSeconds: 1800,
    }),
    error => error.recordingMayBeActive === true
      && error.recordingSessionId === 'ses_fixture'
      && error.recordingOutputPath === outputPattern
  );
});

test('camera API, installer and unit use the recording broker contract', () => {
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
    path.join(__dirname, '..', '..', 'kamrui-media-edge', 'systemd', 'mbfd-camera-api.service'),
    'utf8'
  );
  const brokerService = fs.readFileSync(
    path.join(__dirname, '..', '..', 'kamrui-media-edge', 'systemd', 'mbfd-recording-broker.service'),
    'utf8'
  );
  const brokerSocket = fs.readFileSync(
    path.join(__dirname, '..', '..', 'kamrui-media-edge', 'systemd', 'mbfd-recording-broker.socket'),
    'utf8'
  );
  const brokerScript = fs.readFileSync(
    path.join(__dirname, '..', '..', 'kamrui-media-edge', 'recording-broker', 'mbfd-recording-broker.py'),
    'utf8'
  );
  const recordingUnit = fs.readFileSync(
    path.join(__dirname, '..', '..', 'kamrui-media-edge', 'systemd', 'mbfd-camera-recording@.service'),
    'utf8'
  );
  const lockfile = path.join(
    __dirname, '..', '..', 'kamrui-media-edge', 'camera-api', 'package-lock.json'
  );

  // The camera API uses the broker, not sudo.
  assert.match(edge, /createRecordingSupervisor/);
  assert.match(edge, /recordingSupervisor\.startSession/);
  assert.match(edge, /recordingSupervisor\.recoverSession/);
  assert.match(edge, /recordingSupervisor\.stopSession/);
  assert.match(
    edge,
    /recordingState = 'starting'[\s\S]*saveRecordingState\(\)[\s\S]*recordingSupervisor\.startSession/
  );
  const uncertainStart = edge.slice(
    edge.indexOf('if (error.recordingMayBeActive'),
    edge.indexOf("state.recording = false", edge.indexOf('if (error.recordingMayBeActive')),
  );
  assert.match(
    uncertainStart,
    /recordingState = 'recovery_required'[\s\S]*saveRecordingState\(\)[\s\S]*monitorSupervisedRecording/,
    'an uncertain start must durably replace the provisional starting state before reconciliation',
  );
  assert.doesNotMatch(edge, /async function startRecordingProcess/);

  // The supervisor uses a Unix-socket broker, never sudo.
  assert.match(install, /recording-broker/);
  assert.match(install, /mbfd-recording-broker\.py/);
  assert.match(install, /mbfd-recording-broker\.socket/);
  assert.match(install, /mbfd-camera-api/);
  assert.doesNotMatch(install, /curl.*get\.docker\.com.*\|.*sudo/);
  assert.doesNotMatch(install, /peter ALL=\(root\) NOPASSWD: \/usr\/local\/sbin\/mbfd-recording-admin/);

  assert.match(upgrade, /mbfd-recording-broker/);
  assert.match(upgrade, /mbfd-camera-api/);
  assert.match(upgrade, /mbfd-camera-recording@\.service/);
  assert.match(upgrade, /camera-api\/package-lock\.json/);
  assert.match(upgrade, /useradd --system/);
  assert.match(upgrade, /user-long-recording-test\.sh/);
  assert.doesNotMatch(upgrade, /peter ALL=\(root\) NOPASSWD: \/usr\/local\/sbin\/mbfd-recording-admin/);

  // No broad sudoers grant anywhere.
  assert.doesNotMatch(install, /NOPASSWD:\s*ALL/);
  assert.doesNotMatch(upgrade, /NOPASSWD:\s*ALL/);
  assert.doesNotMatch(install, /docker\.sock/);
  assert.doesNotMatch(upgrade, /docker\.sock/);
  // No wildcard sudoers rule for the camera API.
  assert.doesNotMatch(install, /mbfd-recording-admin \*/);
  assert.doesNotMatch(upgrade, /mbfd-recording-admin \*/);
  // The narrow operator-only rule allows status only, not start/stop.
  assert.match(install, /mbfd-recording-admin status ses_\*/);
  assert.match(upgrade, /mbfd-recording-admin status ses_\*/);

  // The camera API service keeps NoNewPrivileges and uses a dedicated user.
  assert.match(unit, /User=mbfd-camera-api/);
  assert.match(unit, /Group=mbfd-camera-api/);
  assert.match(unit, /^NoNewPrivileges=true$/m);
  assert.match(unit, /MBFD_RECORDING_BROKER_SOCKET/);
  assert.doesNotMatch(unit, /User=peter/);

  // The broker service is root-owned with peer verification.
  assert.match(brokerService, /ExecStart=.*mbfd-recording-broker/);
  assert.match(brokerService, /^NoNewPrivileges=true$/m);
  assert.match(brokerSocket, /SocketGroup=mbfd-camera-api/);
  assert.match(brokerSocket, /SocketMode=0660/);
  assert.match(brokerSocket, /ListenStream=.*broker\.sock/);

  // The broker script validates peer credentials and uses an allowlist.
  assert.match(brokerScript, /SO_PEERCRED/);
  assert.match(brokerScript, /get_peer_uid/);
  assert.match(brokerScript, /ALLOWED_ACTIONS/);
  assert.match(brokerScript, /reconcile/);
  assert.doesNotMatch(brokerScript, /os\.system|subprocess\.Popen\(.*shell=True/);

  // The recording unit retains NoNewPrivileges.
  assert.match(recordingUnit, /KillSignal=SIGINT/);
  assert.match(recordingUnit, /FinalKillSignal=SIGKILL/);
  assert.match(recordingUnit, /TimeoutStopSec=/);
  assert.match(recordingUnit, /ExecStart=\/usr\/local\/libexec\/mbfd-camera-recording-run %i/);
  assert.match(recordingUnit, /ProtectProc=invisible/);
  assert.match(recordingUnit, /^NoNewPrivileges=true$/m);

  assert.equal(fs.existsSync(lockfile), true);
});

test('recording supervisor exposes reconcile for stale-state classification', () => {
  const supervisor = createRecordingSupervisor({
    recordingRoot: '/mnt/data/recordings',
    runAdmin: async (action) => {
      if (action === 'reconcile') {
        return {
          stdout: [
            'Classification=ORPHANED_METADATA',
            'Unit=mbfd-camera-recording@ses_stale.service',
            'ActiveState=inactive',
            'SubState=dead',
            'MainPID=0',
            'FragmentCount=0',
            'FragmentBytes=0',
          ].join('\n'),
        };
      }
      throw new Error('unexpected action');
    },
  });
  assert.equal(typeof supervisor.reconcile, 'function');
});

test('sendBrokerRequest rejects an error response from the broker', async () => {
  const { sendBrokerRequest } = require('../../kamrui-media-edge/camera-api/recording-supervisor');
  // Use a non-existent socket to verify the error path.
  await assert.rejects(
    sendBrokerRequest('/run/nonexistent-broker-socket', { action: 'status', session_id: 'ses_test' }),
    /broker unavailable|connect|EACCES|ENOENT/i
  );
});
