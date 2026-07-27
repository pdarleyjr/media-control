'use strict';

const { execFile } = require('node:child_process');
const path = require('node:path');
const { promisify } = require('node:util');
const { hashCommand } = require('./recording-safety');

const execFileAsync = promisify(execFile);
const IMAGE_DIGEST_PATTERN = /(?:^|@)(sha256:[a-f0-9]{64})$/i;
const CONTAINER_ID_PATTERN = /^[a-f0-9]{64}$/i;
const SESSION_ID_PATTERN = /^ses_[A-Za-z0-9_-]+$/;
const NONCE_PATTERN = /^[a-f0-9]{64}$/i;
const RECORDING_LABEL = 'com.mbfd.camera.recording';
const SESSION_LABEL = 'com.mbfd.camera.session';
const NONCE_LABEL = 'com.mbfd.camera.nonce';

function immutableImageDigest(imageRef) {
  const match = String(imageRef || '').trim().match(IMAGE_DIGEST_PATTERN);
  if (!match) {
    throw new Error('Recording Docker image must be an immutable sha256 image reference');
  }
  return match[1].toLowerCase();
}

function containerNameForSession(sessionId) {
  if (!SESSION_ID_PATTERN.test(String(sessionId || ''))) {
    throw new Error('Invalid recording session ID');
  }
  return `mbfd-camera-recording-${sessionId}`;
}

function normalizedPath(value) {
  return path.resolve(String(value || ''));
}

function isInside(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative !== '' && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative);
}

function validateLaunchInput({
  sessionId,
  sessionNonce,
  sourceUrl,
  outputPattern,
  recordingRoot,
  ffmpegArgs,
}) {
  const containerName = containerNameForSession(sessionId);
  if (!NONCE_PATTERN.test(String(sessionNonce || ''))) {
    throw new Error('Invalid recording session nonce');
  }

  let source;
  try {
    source = new URL(String(sourceUrl || ''));
  } catch {
    throw new Error('Recording source must be credential-free loopback RTSP');
  }
  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(source.hostname);
  if (
    source.protocol !== 'rtsp:'
    || !loopback
    || source.username
    || source.password
  ) {
    throw new Error('Recording source must be credential-free loopback RTSP');
  }

  const root = normalizedPath(recordingRoot);
  const output = normalizedPath(outputPattern);
  const sessionDir = path.join(root, 'active', sessionId);
  if (!isInside(sessionDir, output)) {
    throw new Error('Recording output must remain inside the active session directory');
  }
  if (!Array.isArray(ffmpegArgs) || ffmpegArgs.length === 0) {
    throw new Error('FFmpeg arguments are required');
  }
  if (normalizedPath(ffmpegArgs.at(-1)) !== output) {
    throw new Error('FFmpeg output argument does not match the recording output pattern');
  }

  return {
    containerName,
    recordingRoot: root,
    outputPath: output,
    ffmpegArgs: ffmpegArgs.map(String),
  };
}

function parseInspect(stdout) {
  let parsed;
  try {
    parsed = JSON.parse(String(stdout || ''));
  } catch {
    throw new Error('Docker inspect returned invalid JSON');
  }
  const inspect = Array.isArray(parsed) ? parsed[0] : parsed;
  if (!inspect || typeof inspect !== 'object') {
    throw new Error('Docker inspect returned no container');
  }
  return inspect;
}

function resolveImageIdentity(stdout, imageRef, expectedDigest) {
  const text = String(stdout || '').trim();
  let record = null;
  try {
    const parsed = JSON.parse(text);
    record = Array.isArray(parsed) ? parsed[0] : parsed;
  } catch {
    // Backward-compatible with a direct Docker image ID returned by a custom
    // executor. The production command below returns the full inspect record.
    record = { Id: text, RepoDigests: [] };
  }
  const imageId = String(record?.Id || '').trim().toLowerCase();
  if (!CONTAINER_ID_PATTERN.test(imageId.replace(/^sha256:/, ''))) {
    throw new Error('Docker image inspect returned an invalid image ID');
  }
  const repositoryReference = String(imageRef).includes('@');
  if (repositoryReference) {
    const repoDigests = Array.isArray(record?.RepoDigests) ? record.RepoDigests : [];
    const digestPresent = repoDigests.some(
      value => immutableImageDigest(value) === expectedDigest,
    );
    if (!digestPresent) {
      throw new Error(`Recording Docker repository digest mismatch: expected ${expectedDigest}`);
    }
  } else if (imageId !== expectedDigest) {
    throw new Error(`Recording Docker image identity mismatch: expected ${expectedDigest}`);
  }
  return { imageId, imageDigest: expectedDigest };
}

function hasNoNewPrivileges(options) {
  return Array.isArray(options)
    && options.some((option) => String(option).toLowerCase().startsWith('no-new-privileges'));
}

function dockerIdentityMatches(expected, actual) {
  if (!expected || expected.backend !== 'docker' || !actual) {
    return { matches: false, reason: 'missing Docker identity' };
  }
  const labels = actual.Config?.Labels || {};
  const mount = (actual.Mounts || []).find(
    (candidate) => (
      candidate?.Type === 'bind'
      && normalizedPath(candidate.Source) === normalizedPath(expected.recordingRoot)
      && normalizedPath(candidate.Destination) === normalizedPath(expected.recordingRoot)
    )
  );
  const checks = [
    ['container id', actual.Id === expected.containerId],
    ['container name', String(actual.Name || '').replace(/^\//, '') === expected.containerName],
    ['image id', String(actual.Image || '').toLowerCase() === String(expected.imageId || '').toLowerCase()],
    ['configured image', actual.Config?.Image === expected.imageRef],
    ['session label', labels[SESSION_LABEL] === expected.sessionId],
    ['nonce label', labels[NONCE_LABEL] === expected.sessionNonce],
    ['recording label', labels[RECORDING_LABEL] === '1'],
    ['command', hashCommand(actual.Config?.Cmd || []) === expected.commandHash],
    ['user', String(actual.Config?.User || '') === String(expected.runAsUser || '')],
    ['host network', actual.HostConfig?.NetworkMode === 'host'],
    ['read-only root', actual.HostConfig?.ReadonlyRootfs === true],
    ['all capabilities dropped', (actual.HostConfig?.CapDrop || []).map(String).includes('ALL')],
    ['no-new-privileges', hasNoNewPrivileges(actual.HostConfig?.SecurityOpt)],
    ['PID limit', Number(actual.HostConfig?.PidsLimit) === 128],
    ['recording mount', !!mount && mount.RW === true],
  ];
  const failed = checks.find(([, passed]) => !passed);
  return failed ? { matches: false, reason: failed[0] } : { matches: true };
}

function isMissingContainerError(error) {
  const message = `${error?.message || ''}\n${error?.stderr || ''}`;
  return /no such (object|container)/i.test(message);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createDockerRecordingRuntime({
  imageRef,
  dockerCommand = 'docker',
  execDocker = async (args) => execFileAsync(dockerCommand, args, {
    encoding: 'utf8',
    maxBuffer: 1024 * 1024,
    windowsHide: true,
  }),
  uid = typeof process.getuid === 'function' ? process.getuid() : null,
  gid = typeof process.getgid === 'function' ? process.getgid() : null,
  pollIntervalMs = 250,
  gracefulTimeoutMs = 10_000,
  killTimeoutMs = 5_000,
} = {}) {
  const expectedImageDigest = immutableImageDigest(imageRef);
  const runAsUser = (
    Number.isSafeInteger(Number(uid))
    && Number(uid) > 0
    && Number.isSafeInteger(Number(gid))
    && Number(gid) > 0
  ) ? `${Number(uid)}:${Number(gid)}` : null;

  async function inspect(identity) {
    if (!identity || identity.backend !== 'docker' || !CONTAINER_ID_PATTERN.test(String(identity.containerId || ''))) {
      return { status: 'identity_mismatch', reason: 'invalid persisted Docker identity' };
    }
    if (
      identity.imageRef !== imageRef
      || identity.imageDigest !== expectedImageDigest
    ) {
      return { status: 'identity_mismatch', reason: 'persisted image reference changed' };
    }
    let result;
    try {
      result = await execDocker(['inspect', identity.containerId]);
    } catch (error) {
      if (isMissingContainerError(error)) return { status: 'stopped' };
      return { status: 'unavailable', error: error?.message || 'Docker inspect failed' };
    }
    let actual;
    try {
      actual = parseInspect(result.stdout);
    } catch (error) {
      return { status: 'unavailable', error: error.message };
    }
    const validation = dockerIdentityMatches(identity, actual);
    if (!validation.matches) {
      return { status: 'identity_mismatch', reason: validation.reason };
    }
    if (actual.State?.Running !== true) {
      return {
        status: 'stopped',
        exitCode: Number.isInteger(actual.State?.ExitCode) ? actual.State.ExitCode : null,
      };
    }
    return { status: 'running', actual };
  }

  async function start({
    sessionId,
    sessionNonce,
    sourceUrl,
    outputPattern,
    recordingRoot,
    ffmpegArgs,
  }) {
    if (!runAsUser) {
      throw new Error('Docker recording requires a non-root numeric UID and GID');
    }
    const validated = validateLaunchInput({
      sessionId,
      sessionNonce,
      sourceUrl,
      outputPattern,
      recordingRoot,
      ffmpegArgs,
    });

    const image = await execDocker(['image', 'inspect', imageRef]);
    const resolvedImage = resolveImageIdentity(
      image.stdout,
      imageRef,
      expectedImageDigest,
    );

    const runArgs = [
      'run',
      '--detach',
      '--rm',
      `--name=${validated.containerName}`,
      '--network=host',
      `--user=${runAsUser}`,
      '--cap-drop=ALL',
      '--security-opt=no-new-privileges',
      '--read-only',
      '--tmpfs=/tmp:rw,noexec,nosuid,nodev,size=64m',
      '--pids-limit=128',
      '--restart=no',
      `--label=${RECORDING_LABEL}=1`,
      `--label=${SESSION_LABEL}=${sessionId}`,
      `--label=${NONCE_LABEL}=${sessionNonce}`,
      `--mount=type=bind,src=${validated.recordingRoot},dst=${validated.recordingRoot},rw`,
      '--entrypoint=ffmpeg',
      imageRef,
      ...validated.ffmpegArgs,
    ];
    const launched = await execDocker(runArgs);
    const containerId = String(launched.stdout || '').trim();
    if (!CONTAINER_ID_PATTERN.test(containerId)) {
      throw new Error('Docker did not return a full recording container ID');
    }

    const provisional = {
      backend: 'docker',
      containerId,
      containerName: validated.containerName,
      imageRef,
      imageId: resolvedImage.imageId,
      imageDigest: resolvedImage.imageDigest,
      sessionId,
      sessionNonce,
      outputPath: validated.outputPath,
      recordingRoot: validated.recordingRoot,
      commandHash: hashCommand(validated.ffmpegArgs),
      runAsUser,
      startedAt: null,
    };
    const inspected = await inspect(provisional);
    if (inspected.status !== 'running') {
      throw new Error(
        `Unable to establish durable Docker recording identity: ${inspected.reason || inspected.error || inspected.status}`
      );
    }
    provisional.startedAt = inspected.actual.State?.StartedAt || null;
    return provisional;
  }

  async function signal(identity, signalName) {
    try {
      await execDocker(['kill', `--signal=${signalName}`, identity.containerId]);
    } catch (error) {
      const after = await inspect(identity);
      if (after.status === 'stopped') return;
      throw error;
    }
  }

  async function waitUntilStopped(identity, timeoutMs) {
    const deadline = Date.now() + Math.max(0, timeoutMs);
    do {
      const current = await inspect(identity);
      if (current.status === 'stopped') return true;
      if (current.status === 'identity_mismatch') {
        throw new Error(
          `Recording Docker identity changed before SIGKILL (${current.reason}); refusing to signal`
        );
      }
      if (current.status === 'unavailable') {
        throw new Error(`Docker recording status unavailable: ${current.error}`);
      }
      if (Date.now() >= deadline) return false;
      await delay(Math.max(0, pollIntervalMs));
    } while (true);
  }

  async function stop(identity) {
    const current = await inspect(identity);
    if (current.status === 'stopped') return { stopped: true, signal: null };
    if (current.status === 'identity_mismatch') {
      throw new Error(
        `Recording Docker identity mismatch (${current.reason}); refusing to signal`
      );
    }
    if (current.status === 'unavailable') {
      throw new Error(`Docker recording status unavailable: ${current.error}`);
    }

    await signal(identity, 'SIGINT');
    if (await waitUntilStopped(identity, gracefulTimeoutMs)) {
      return { stopped: true, signal: 'SIGINT' };
    }

    const beforeKill = await inspect(identity);
    if (beforeKill.status === 'identity_mismatch') {
      throw new Error(
        `Recording Docker identity changed before SIGKILL (${beforeKill.reason}); refusing to signal`
      );
    }
    if (beforeKill.status === 'unavailable') {
      throw new Error(`Docker recording status unavailable before SIGKILL: ${beforeKill.error}`);
    }
    if (beforeKill.status === 'stopped') return { stopped: true, signal: 'SIGINT' };

    await signal(identity, 'SIGKILL');
    if (!(await waitUntilStopped(identity, killTimeoutMs))) {
      throw new Error(`Recording Docker container ${identity.containerId} did not terminate`);
    }
    return { stopped: true, signal: 'SIGKILL' };
  }

  return {
    backend: 'docker',
    imageRef,
    imageDigest: expectedImageDigest,
    start,
    inspect,
    stop,
  };
}

module.exports = {
  createDockerRecordingRuntime,
  dockerIdentityMatches,
  immutableImageDigest,
};
