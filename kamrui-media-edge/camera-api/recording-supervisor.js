'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);
const DEFAULT_ADMIN = '/usr/local/sbin/mbfd-recording-admin';
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

function createRecordingSupervisor({
  recordingRoot = '/mnt/data/recordings',
  envRoot = '/run/mbfd-camera-recording',
  adminPath = DEFAULT_ADMIN,
  runAdmin = async (action, sessionId) => execFileAsync(
    '/usr/bin/sudo',
    ['-n', adminPath, action, safeSessionId(sessionId)],
    { timeout: action === 'stop' ? 30_000 : 10_000, maxBuffer: 64 * 1024 }
  ),
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
    atomicWriteEnvironment(envPath, environment);
    try {
      await runAdmin('start', safeId);
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
        try { fs.rmSync(envPath, { force: true }); } catch {}
      } else {
        // The helper could be unavailable while systemd accepted the start.
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
      try { fs.rmSync(envPathFor(safeId), { force: true }); } catch {}
      return { stopped: true, alreadyStopped: true, status: current };
    }
    assertOutput(current, outputPattern);
    await runAdmin('stop', safeId);
    const stopped = await waitFor(safeId, (item) => !item.active, stopTimeoutMs);
    try { fs.rmSync(envPathFor(safeId), { force: true }); } catch {}
    return { stopped: true, alreadyStopped: false, status: stopped };
  }

  function cleanupSession(sessionId) {
    fs.rmSync(envPathFor(sessionId), { force: true });
  }

  return {
    startSession,
    recoverSession,
    stopSession,
    cleanupSession,
    status,
  };
}

module.exports = {
  buildSessionEnvironment,
  serializeEnvironment,
  parseAdminStatus,
  createRecordingSupervisor,
};
