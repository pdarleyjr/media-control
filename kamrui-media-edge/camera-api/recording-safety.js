'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

function fsyncDirectory(dir) {
  let fd;
  try {
    fd = fs.openSync(dir, 'r');
    fs.fsyncSync(fd);
  } catch (error) {
    // Windows does not consistently permit fsync on directory handles. File
    // fsync + rename is still used there; Linux production also fsyncs the dir.
    if (process.platform !== 'win32') throw error;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function atomicWriteJson(target, value, mode = 0o600) {
  const dir = path.dirname(target);
  fs.mkdirSync(dir, { recursive: true });
  const temp = path.join(dir, `.${path.basename(target)}.${process.pid}.${crypto.randomUUID()}.tmp`);
  let fd;
  try {
    fd = fs.openSync(temp, 'wx', mode);
    fs.writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(temp, target);
    fsyncDirectory(dir);
  } catch (error) {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch {}
    }
    try { fs.rmSync(temp, { force: true }); } catch {}
    throw error;
  }
}

function safeSessionId(sessionId) {
  if (!/^ses_[A-Za-z0-9_-]+$/.test(String(sessionId || ''))) {
    throw new Error('Invalid session ID');
  }
  return String(sessionId);
}

function leasePath(root, sessionId) {
  return path.join(root, `${safeSessionId(sessionId)}.lock`);
}

function readLease(lockDir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(lockDir, 'lease.json'), 'utf8'));
  } catch {
    return null;
  }
}

function acquireFilesystemLease(root, sessionId, owner, ttlMs = 120_000, now = Date.now()) {
  if (!owner) throw new Error('Lease owner is required');
  fs.mkdirSync(root, { recursive: true });
  const lockDir = leasePath(root, sessionId);
  const lease = {
    sessionId: safeSessionId(sessionId),
    owner: String(owner),
    acquiredAt: new Date(now).toISOString(),
    expiresAt: now + ttlMs,
  };

  const create = () => {
    fs.mkdirSync(lockDir);
    try {
      atomicWriteJson(path.join(lockDir, 'lease.json'), lease);
      fsyncDirectory(root);
      return { acquired: true, lease };
    } catch (error) {
      try { fs.rmSync(lockDir, { recursive: true, force: true }); } catch {}
      throw error;
    }
  };

  try {
    return create();
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }

  const existing = readLease(lockDir);
  if (existing && Number(existing.expiresAt) > now) {
    return { acquired: false, lease: existing };
  }

  // Rename is the atomic ownership decision. If another process wins the
  // rename/create race, return its lease instead of deleting its lock.
  const stale = `${lockDir}.expired.${process.pid}.${crypto.randomUUID()}`;
  try {
    fs.renameSync(lockDir, stale);
  } catch {
    return { acquired: false, lease: readLease(lockDir) };
  }
  try {
    return create();
  } finally {
    fs.rmSync(stale, { recursive: true, force: true });
  }
}

function releaseFilesystemLease(root, sessionId, owner) {
  const lockDir = leasePath(root, sessionId);
  const lease = readLease(lockDir);
  if (!lease || lease.owner !== String(owner)) return false;
  const released = `${lockDir}.released.${process.pid}.${crypto.randomUUID()}`;
  try {
    fs.renameSync(lockDir, released);
  } catch {
    return false;
  }
  fs.rmSync(released, { recursive: true, force: true });
  fsyncDirectory(root);
  return true;
}

function hashCommand(args) {
  return crypto.createHash('sha256').update(JSON.stringify(args)).digest('hex');
}

function parseProcStat(stat) {
  const close = stat.lastIndexOf(')');
  if (close < 0) throw new Error('Invalid proc stat');
  const fields = stat.slice(close + 2).trim().split(/\s+/);
  return {
    processGroup: Number(fields[2]), // field 5 overall; fields[0] is state (3)
    startTime: fields[19], // field 22 overall
  };
}

function readProcessIdentity(pid, {
  procRoot = '/proc',
  expectedOutputPath,
  readFile = fs.readFileSync,
  readlink = fs.readlinkSync,
} = {}) {
  const pidNumber = Number(pid);
  if (!Number.isSafeInteger(pidNumber) || pidNumber <= 1) throw new Error('Invalid PID');
  const base = path.join(procRoot, String(pidNumber));
  const stat = parseProcStat(readFile(path.join(base, 'stat'), 'utf8'));
  const executable = readlink(path.join(base, 'exe')).replace(/ \(deleted\)$/, '');
  const args = readFile(path.join(base, 'cmdline')).toString('utf8').split('\0').filter(Boolean);
  const environ = readFile(path.join(base, 'environ')).toString('utf8').split('\0');
  const nonceEntry = environ.find((item) => item.startsWith('MBFD_RECORDING_NONCE='));
  const outputPath = expectedOutputPath || args.at(-1) || null;
  return {
    pid: pidNumber,
    startTime: String(stat.startTime),
    executable,
    commandHash: hashCommand(args),
    outputPath: outputPath ? path.resolve(outputPath) : null,
    sessionNonce: nonceEntry ? nonceEntry.slice('MBFD_RECORDING_NONCE='.length) : null,
    processGroup: stat.processGroup,
  };
}

function processIdentityMatches(expected, actual) {
  if (!expected || !actual) return false;
  return ['pid', 'startTime', 'executable', 'commandHash', 'outputPath', 'sessionNonce', 'processGroup']
    .every((key) => String(expected[key]) === String(actual[key]));
}

function revisionPrecondition(ifMatch, revision) {
  if (!ifMatch) return { ok: false, status: 428, error: 'If-Match is required' };
  if (ifMatch !== revision && ifMatch !== `"${revision}"`) {
    return { ok: false, status: 412, error: 'Revision mismatch' };
  }
  return { ok: true, status: 200 };
}

function validateFinalizedMedia({ probe, sha256 } = {}) {
  if (!probe || typeof probe !== 'object') return { ok: false, error: 'ffprobe did not return valid JSON' };
  const streams = Array.isArray(probe.streams) ? probe.streams : [];
  const video = streams.find((stream) => stream?.codec_type === 'video' && stream.codec_name === 'h264');
  const audio = streams.find((stream) => stream?.codec_type === 'audio' && stream.codec_name === 'aac');
  if (!video) return { ok: false, error: 'Final recording has no H.264 video track' };
  if (!audio) return { ok: false, error: 'Final recording has no AAC audio track' };
  if (!(Number(video.width) > 0) || !(Number(video.height) > 0)) {
    return { ok: false, error: 'Final recording has invalid video dimensions' };
  }
  const duration = Number(probe.format?.duration);
  const sizeBytes = Number(probe.format?.size);
  if (!Number.isFinite(duration) || duration <= 0) return { ok: false, error: 'Final recording has invalid duration' };
  if (!Number.isSafeInteger(sizeBytes) || sizeBytes <= 0) return { ok: false, error: 'Final recording has invalid size' };
  if (!/^[a-f0-9]{64}$/i.test(String(sha256 || ''))) {
    return { ok: false, error: 'Final recording SHA-256 is missing or invalid' };
  }
  return { ok: true, video, audio, duration, sizeBytes, sha256: String(sha256).toLowerCase() };
}

function isInterruptedFinalization(data) {
  return !!(
    data?.recordingSessionId
    && (data.finalizationState === 'finalizing' || data.recordingState === 'finalizing')
  );
}

function acceptFilesystemNonce(root, nonce, ttlMs = 60_000, now = Date.now()) {
  if (!/^[a-f0-9-]{36}$/i.test(String(nonce || ''))) throw new Error('Invalid service nonce');
  fs.mkdirSync(root, { recursive: true });
  // Bound disk usage while preserving nonces across camera-api restarts.
  for (const entry of fs.readdirSync(root).slice(0, 1024)) {
    const candidate = path.join(root, entry);
    try {
      if (Number(fs.readFileSync(candidate, 'utf8')) <= now) fs.rmSync(candidate, { force: true });
    } catch {}
  }
  const noncePath = path.join(root, String(nonce));
  let fd;
  try {
    fd = fs.openSync(noncePath, 'wx', 0o600);
    fs.writeFileSync(fd, String(now + ttlMs), 'utf8');
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fsyncDirectory(root);
    return true;
  } catch (error) {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch {}
      try { fs.rmSync(noncePath, { force: true }); } catch {}
    }
    if (error.code === 'EEXIST') return false;
    throw error;
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function stopValidatedProcess(expected, {
  readIdentity = (pid) => readProcessIdentity(pid, { expectedOutputPath: expected.outputPath }),
  signalGroup = (processGroup, signal) => process.kill(-Math.abs(Number(processGroup)), signal),
  isAlive = async (pid) => {
    try { process.kill(pid, 0); return true; } catch { return false; }
  },
  pollIntervalMs = 250,
  gracefulTimeoutMs = 10_000,
  killTimeoutMs = 5_000,
} = {}) {
  const actual = await readIdentity(expected.pid);
  if (!processIdentityMatches(expected, actual)) {
    throw new Error(`Recording process identity mismatch for PID ${expected.pid}; refusing to signal`);
  }
  if (Number(expected.processGroup) !== Number(expected.pid)) {
    throw new Error('Recording process is not its process-group leader; refusing to signal');
  }

  await signalGroup(expected.processGroup, 'SIGINT');
  const waitUntilGone = async (timeoutMs) => {
    const deadline = Date.now() + timeoutMs;
    do {
      if (!(await isAlive(expected.pid))) return true;
      await delay(pollIntervalMs);
    } while (Date.now() < deadline);
    return !(await isAlive(expected.pid));
  };

  if (await waitUntilGone(gracefulTimeoutMs)) return { stopped: true, signal: 'SIGINT' };

  const beforeKill = await readIdentity(expected.pid);
  if (!processIdentityMatches(expected, beforeKill)) {
    throw new Error(`Recording process identity changed before SIGKILL for PID ${expected.pid}; refusing to signal`);
  }
  await signalGroup(expected.processGroup, 'SIGKILL');
  if (!(await waitUntilGone(killTimeoutMs))) {
    throw new Error(`Recording process group ${expected.processGroup} did not terminate`);
  }
  return { stopped: true, signal: 'SIGKILL' };
}

module.exports = {
  atomicWriteJson,
  acquireFilesystemLease,
  releaseFilesystemLease,
  hashCommand,
  readProcessIdentity,
  processIdentityMatches,
  validateFinalizedMedia,
  isInterruptedFinalization,
  acceptFilesystemNonce,
  revisionPrecondition,
  stopValidatedProcess,
};
