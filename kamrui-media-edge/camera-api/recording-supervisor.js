'use strict';

const crypto = require('crypto');
const fs = require('fs');
const net = require('net');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const { createDockerRecordingRuntime } = require('./docker-recording-runtime');

const execFileAsync = promisify(execFile);
const DEFAULT_ADMIN = '/usr/local/sbin/mbfd-recording-admin';
const DEFAULT_BROKER_SOCKET =
  process.env.MBFD_RECORDING_BROKER_SOCKET || '/run/mbfd-recording-broker/broker.sock';
const SESSION_PATTERN = /^ses_[A-Za-z0-9_-]+$/;

function safeSessionId(value) {
  const sessionId = String(value || '');
  if (!SESSION_PATTERN.test(sessionId)) throw new Error('Invalid recording session ID');
  return sessionId;
}

function assertLinuxAbsolute(value, field) {
  const text = String(value || '');
  if (!path.posix.isAbsolute(text) || path.posix.normalize(text) !== text) {
    throw new Error(`${field} must be a normalized absolute path`);
  }
  return text;
}

function buildSessionEnvironment({
  recordingRoot,
  sessionId,
  source,
  outputPattern,
  nonce,
  segmentSeconds = 1800,
}) {
  const safeId = safeSessionId(sessionId);
  const root = assertLinuxAbsolute(recordingRoot, 'Recording root').replace(/\/+$/, '');
  const sourceUrl = new URL(String(source || ''));
  if (
    sourceUrl.protocol !== 'rtsp:'
    || !['127.0.0.1', 'localhost'].includes(sourceUrl.hostname)
    || sourceUrl.username
    || sourceUrl.password
  ) {
    throw new Error('Recording source must be credential-free loopback RTSP');
  }
  const output = assertLinuxAbsolute(outputPattern, 'Recording output pattern');
  const expectedRoot = `${root}/active/${safeId}/`;
  if (!output.startsWith(expectedRoot) || !/%0?3d/.test(path.posix.basename(output))) {
    throw new Error('Recording output pattern must remain inside the fixed session directory');
  }
  const safeNonce = String(nonce || '');
  if (!/^[a-f0-9]{64}$/i.test(safeNonce)) throw new Error('Recording session nonce is invalid');
  const seconds = Number(segmentSeconds);
  if (!Number.isSafeInteger(seconds) || seconds < 1 || seconds > 86_400) {
    throw new Error('Recording segment duration is invalid');
  }
  return {
    MBFD_RECORDING_SESSION_ID: safeId,
    MBFD_RECORDING_SOURCE: sourceUrl.toString(),
    MBFD_RECORDING_OUTPUT_PATTERN: output,
    MBFD_RECORDING_NONCE: safeNonce,
    MBFD_RECORDING_SEGMENT_SECONDS: String(seconds),
  };
}

function environmentValue(value) {
  const text = String(value);
  if (!/^[A-Za-z0-9_./:%?&=+\-]+$/.test(text)) {
    throw new Error('Recording environment value contains unsupported characters');
  }
  return text;
}

function serializeEnvironment(environment) {
  return `${Object.entries(environment)
    .map(([key, value]) => `${key}=${environmentValue(value)}`)
    .join('\n')}\n`;
}

function fsyncDirectory(dir) {
  let fd;
  try {
    fd = fs.openSync(dir, 'r');
    fs.fsyncSync(fd);
  } catch (error) {
    if (process.platform !== 'win32') throw error;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function atomicWriteEnvironment(target, environment) {
  const dir = path.dirname(target);
  fs.mkdirSync(dir, { recursive: true, mode: 0o770 });
  const temp = path.join(dir, `.${path.basename(target)}.${process.pid}.${crypto.randomUUID()}.tmp`);
  let fd;
  try {
    fd = fs.openSync(temp, 'wx', 0o640);
    fs.writeFileSync(fd, serializeEnvironment(environment), 'utf8');
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(temp, target);
    fs.chmodSync(target, 0o640);
    fsyncDirectory(dir);
  } catch (error) {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch {}
    }
    try { fs.rmSync(temp, { force: true }); } catch {}
    throw error;
  }
}

function parseAdminStatus(stdout) {
  const fields = {};
  for (const line of String(stdout || '').split(/\r?\n/)) {
    const separator = line.indexOf('=');
    if (separator > 0) fields[line.slice(0, separator)] = line.slice(separator + 1);
  }
  if (!fields.Validated) throw new Error('Recording unit status was not validated');
  const active = fields.ActiveState === 'active' && fields.SubState === 'running';
  if (active && fields.Validated !== 'yes') throw new Error('Recording unit identity was not validated');
  if (!active && !['inactive', 'failed'].includes(fields.Validated)) {
    throw new Error('Recording unit inactive status was not validated');
  }
  const mainPid = Number(fields.MainPID || 0);
  if (active && (!Number.isSafeInteger(mainPid) || mainPid <= 1)) {
    throw new Error('Recording unit returned an invalid MainPID');
  }
  return {
    unit: fields.Id || '',
    active,
    activeState: fields.ActiveState || '',
    subState: fields.SubState || '',
    mainPid,
    result: fields.Result || '',
    validated: fields.Validated,
    outputPath: fields.OutputPath || null,
  };
}

/**
 * Parse the broker's reconcile response into a classification result.
 * The broker returns text lines: Classification=, Unit=, ActiveState=, etc.
 */
function parseReconcileStatus(stdout) {
  const fields = {};
  for (const line of String(stdout || '').split(/\r?\n/)) {
    const separator = line.indexOf('=');
    if (separator > 0) fields[line.slice(0, separator)] = line.slice(separator + 1);
  }
  const classification = String(fields.Classification || '').trim();
  const valid = [
    'ACTIVE', 'FINALIZING', 'RECOVERABLE', 'ORPHANED_METADATA',
    'FAILED_WITH_MEDIA', 'FAILED_WITHOUT_MEDIA', 'UNKNOWN',
  ];
  if (!valid.includes(classification)) {
    throw new Error(`Recording reconcile returned an unknown classification: ${classification}`);
  }
  return {
    classification,
    unit: fields.Unit || '',
    activeState: fields.ActiveState || '',
    subState: fields.SubState || '',
    mainPid: Number(fields.MainPID || 0),
    fragmentCount: Number(fields.FragmentCount || 0),
    fragmentBytes: Number(fields.FragmentBytes || 0),
  };
}

function buildRecordingFfmpegArgs({
  source,
  outputPattern,
  segmentSeconds = 1800,
}) {
  const seconds = Number(segmentSeconds);
  if (!Number.isSafeInteger(seconds) || seconds < 1 || seconds > 86_400) {
    throw new Error('Recording segment duration is invalid');
  }
  return [
    '-nostdin', '-hide_banner', '-loglevel', 'warning', '-n',
    '-rtsp_transport', 'tcp', '-i', String(source),
    '-map', '0:v:0', '-map', '0:a:0?',
    '-c:v', 'copy', '-c:a', 'aac', '-ar', '48000', '-ac', '1', '-b:a', '96k',
    '-af', 'aresample=async=1:first_pts=0',
    '-max_muxing_queue_size', '1024',
    '-f', 'segment', '-segment_time', String(seconds),
    '-segment_format', 'mp4', '-reset_timestamps', '1',
    '-movflags', '+frag_keyframe+empty_moov+default_base_moof',
    String(outputPattern),
  ];
}

/**
 * Send a bounded JSON request to the root-owned recording broker over a
 * peer-verified Unix socket (SO_PEERCRED).  No sudo, no shell, no arbitrary
 * executable.  The broker validates the session ID, environment, systemd unit
 * identity, process executable, and nonce before performing any action.
 *
 * Returns a text response compatible with parseAdminStatus, or throws on error.
 */
function sendBrokerRequest(socketPath, { action, session_id, environment = null }) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(socketPath);
    let response = '';
    let connected = false;
    socket.setTimeout(10_000);
    socket.on('connect', () => {
      connected = true;
      const request = JSON.stringify({ action, session_id, environment }) + '\n';
      socket.write(request);
    });
    socket.on('data', (data) => {
      response += data.toString('utf8');
      if (response.includes('\n')) socket.end();
    });
    socket.on('timeout', () => {
      socket.destroy();
      reject(new Error('recording broker request timed out'));
    });
    socket.on('error', (err) => {
      if (!connected) reject(new Error(`recording broker unavailable: ${err.message}`));
      else reject(err);
    });
    socket.on('close', () => {
      if (response.startsWith('Error=')) {
        reject(new Error(response.slice('Error='.length).trim()));
      } else {
        resolve({ stdout: response });
      }
    });
  });
}

function createRecordingSupervisor({
  recordingRoot = '/mnt/data/recordings',
  envRoot = '/run/mbfd-camera-recording',
  adminPath = DEFAULT_ADMIN,
  brokerSocket = DEFAULT_BROKER_SOCKET,
  runAdmin = async (action, sessionId, environment = null) =>
    sendBrokerRequest(brokerSocket, { action, session_id: sessionId, environment }),
  pollIntervalMs = 250,
  startTimeoutMs = 10_000,
  stopTimeoutMs = 25_000,
} = {}) {
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const envPathFor = (sessionId) => path.join(envRoot, `${safeSessionId(sessionId)}.env`);
  const unitFor = (sessionId) => `mbfd-camera-recording@${safeSessionId(sessionId)}.service`;

  async function status(sessionId) {
    const safeId = safeSessionId(sessionId);
    const result = await runAdmin('status', safeId);
    const parsed = parseAdminStatus(result?.stdout);
    if (parsed.unit !== unitFor(safeId)) throw new Error('Recording unit identity mismatch');
    return parsed;
  }

  async function waitFor(sessionId, predicate, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    let latest;
    do {
      latest = await status(sessionId);
      if (predicate(latest)) return latest;
      await wait(pollIntervalMs);
    } while (Date.now() < deadline);
    throw new Error(`Recording unit did not reach the required state (${latest?.activeState || 'unknown'})`);
  }

  function assertOutput(statusResult, outputPattern) {
    const expected = assertLinuxAbsolute(outputPattern, 'Recording output pattern');
    if (statusResult.outputPath !== expected) throw new Error('Recording unit output path mismatch');
  }

  async function startSession(options) {
    const environment = buildSessionEnvironment({ recordingRoot, ...options });
    const safeId = environment.MBFD_RECORDING_SESSION_ID;
    const envPath = envPathFor(safeId);
    try {
      // The broker validates the environment and atomically writes the root-owned
      // env file.  The unprivileged camera API never writes recording secrets.
      await runAdmin('start', safeId, environment);
      const running = await waitFor(safeId, (item) => item.active, startTimeoutMs);
      assertOutput(running, environment.MBFD_RECORDING_OUTPUT_PATTERN);
      return {
        supervisor: 'systemd',
        unit: running.unit,
        sessionId: safeId,
        mainPid: running.mainPid,
        outputPath: running.outputPath,
      };
    } catch (error) {
      let stopped = false;
      try {
        await runAdmin('stop', safeId);
        stopped = true;
      } catch {}
      if (stopped) {
        try { await runAdmin('finalize', safeId); } catch {}
      } else {
        // The broker could be unavailable while systemd accepted the start.
        // Preserve the validated environment so startup recovery can prove and
        // reconcile the exact unit instead of orphaning an unmanageable FFmpeg.
        error.recordingMayBeActive = true;
        error.recordingSessionId = safeId;
        error.recordingOutputPath = environment.MBFD_RECORDING_OUTPUT_PATTERN;
      }
      throw error;
    }
  }

  async function recoverSession({ sessionId, outputPattern }) {
    const safeId = safeSessionId(sessionId);
    const current = await status(safeId);
    if (!current.active) return { active: false, status: current };
    assertOutput(current, outputPattern);
    return {
      active: true,
      status: current,
      identity: {
        supervisor: 'systemd',
        unit: current.unit,
        sessionId: safeId,
        mainPid: current.mainPid,
        outputPath: current.outputPath,
      },
    };
  }

  async function stopSession({ sessionId, outputPattern }) {
    const safeId = safeSessionId(sessionId);
    const current = await status(safeId);
    if (!current.active) {
      try { await runAdmin('finalize', safeId); } catch {}
      return { stopped: true, alreadyStopped: true, status: current };
    }
    assertOutput(current, outputPattern);
    await runAdmin('stop', safeId);
    const stopped = await waitFor(safeId, (item) => !item.active, stopTimeoutMs);
    try { await runAdmin('finalize', safeId); } catch {}
    return { stopped: true, alreadyStopped: false, status: stopped };
  }

  async function cleanupSession(sessionId) {
    try { await runAdmin('finalize', safeSessionId(sessionId)); } catch {}
  }

  async function reconcile(sessionId) {
    const safeId = safeSessionId(sessionId);
    const result = await runAdmin('reconcile', safeId);
    return parseReconcileStatus(result?.stdout);
  }

  return {
    supervisor: 'systemd',
    startSession,
    recoverSession,
    stopSession,
    cleanupSession,
    status,
    reconcile,
  };
}

function createDockerRecordingSupervisor({
  recordingRoot = '/mnt/data/recordings',
  imageRef,
  runtime = createDockerRecordingRuntime({ imageRef }),
} = {}) {
  function assertIdentity({ sessionId, outputPattern, identity }) {
    const safeId = safeSessionId(sessionId);
    const output = assertLinuxAbsolute(outputPattern, 'Recording output pattern');
    if (
      !identity
      || identity.supervisor !== 'docker'
      || identity.backend !== 'docker'
      || identity.sessionId !== safeId
      || identity.outputPath !== output
    ) {
      throw new Error('Docker recording supervisor identity mismatch');
    }
    return { safeId, output };
  }

  async function startSession(options) {
    const environment = buildSessionEnvironment({ recordingRoot, ...options });
    const runtimeIdentity = await runtime.start({
      sessionId: environment.MBFD_RECORDING_SESSION_ID,
      sessionNonce: environment.MBFD_RECORDING_NONCE,
      sourceUrl: environment.MBFD_RECORDING_SOURCE,
      outputPattern: environment.MBFD_RECORDING_OUTPUT_PATTERN,
      recordingRoot,
      ffmpegArgs: buildRecordingFfmpegArgs({
        source: environment.MBFD_RECORDING_SOURCE,
        outputPattern: environment.MBFD_RECORDING_OUTPUT_PATTERN,
        segmentSeconds: Number(environment.MBFD_RECORDING_SEGMENT_SECONDS),
      }),
    });
    return {
      supervisor: 'docker',
      ...runtimeIdentity,
    };
  }

  async function recoverSession({ sessionId, outputPattern, identity }) {
    assertIdentity({ sessionId, outputPattern, identity });
    const current = await runtime.inspect(identity);
    if (current.status === 'running') {
      return { active: true, status: current, identity };
    }
    if (current.status === 'stopped') {
      return { active: false, status: current };
    }
    throw new Error(
      `Docker recording ${current.status || 'unknown'} `
      + `(${current.reason || current.error || 'unknown reason'}); refusing automatic reconciliation`
    );
  }

  async function stopSession({ sessionId, outputPattern, identity }) {
    assertIdentity({ sessionId, outputPattern, identity });
    const result = await runtime.stop(identity);
    return {
      stopped: true,
      alreadyStopped: result.signal === null,
      status: result,
    };
  }

  async function reconcile(sessionId) {
    throw new Error('Docker recording supervisor does not support broker reconcile');
  }

  function cleanupSession() {
    // Docker uses --rm and keeps no supervisor environment file.
  }

  return {
    supervisor: 'docker',
    startSession,
    recoverSession,
    stopSession,
    cleanupSession,
    status: async () => { throw new Error('Docker supervisor has no broker status'); },
    reconcile,
  };
}

module.exports = {
  buildSessionEnvironment,
  buildRecordingFfmpegArgs,
  serializeEnvironment,
  parseAdminStatus,
  parseReconcileStatus,
  sendBrokerRequest,
  createRecordingSupervisor,
  createDockerRecordingSupervisor,
};
