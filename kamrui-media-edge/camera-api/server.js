'use strict';

const express = require('express');
const crypto = require('crypto');
const { execFile, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const {
  atomicWriteJson,
  acquireFilesystemLease,
  releaseFilesystemLease,
  readProcessIdentity,
  processIdentityMatches,
  validateFinalizedMedia,
  isInterruptedFinalization,
  acceptFilesystemNonce,
  revisionPrecondition,
  stopValidatedProcess,
} = require('./recording-safety');

const app = express();
app.use(express.json({ limit: '64kb' }));

const CONFIG = loadConfig();
const state = createInitialState();
const peertube = require('./peertube-upload');

function loadConfig() {
  const env = {};
  try {
    const lines = fs.readFileSync('/etc/mbfd/media-stack/camera.env', 'utf8').split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq > 0) env[trimmed.slice(0, eq)] = trimmed.slice(eq + 1);
    }
  } catch (e) {
    console.error('Failed to load camera.env:', e.message);
  }
  return {
    port: parseInt(env.CAMERA_API_PORT || '8200', 10),
    token: env.CAMERA_API_TOKEN || '',
    serviceSigningSecret: env.CAMERA_SERVICE_SIGNING_SECRET || '',
    recordingDir: env.RECORDING_DIR || '/mnt/data/recordings',
    peertubeRtmpUrl: env.PEERTUBE_RTMP_URL || '',
    peertubeStreamKey: env.PEERTUBE_STREAM_KEY || '',
    peertubeLiveVideoUuid: env.PEERTUBE_LIVE_VIDEO_UUID || '',
    peertubeBaseUrl: env.PEERTUBE_BASE_URL || 'https://videos.mbfdhub.com',
    peertubeAccessToken: env.PEERTUBE_ACCESS_TOKEN || '',
    annkeMainRtsp: env.ANNKE_MAIN_RTSP_URL || '',
    annkePreviewRtsp: env.ANNKE_PREVIEW_RTSP_URL || '',
    gmktecSyncDest: env.GMKTEC_SYNC_DEST || '',
    gmktecTailscaleIp: env.GMKTEC_TAILSCALE_IP || '',
    gmktecLanIp: env.GMKTEC_LAN_IP || '192.168.1.116',
    // Parse the canonical sync destination into user / host-independent path /
    // sync user, so we can target the LAN address first and fall back to
    // Tailscale without re-parsing on every call.
    ...(() => {
      const m = (env.GMKTEC_SYNC_DEST || '').match(/^([^@]+)@[^:]+:(.+)$/);
      return {
        gmktecSyncUser: m ? m[1] : 'mbfd',
        gmktecSyncPath: m ? m[2].replace(/\/+$/, '') : '/mnt/mbfd-storage/mbfd-broadcasts',
      };
    })(),
    mediamtxRtsp: 'rtsp://127.0.0.1:8554',
    mediamtxHls: 'http://127.0.0.1:8888',
    mediamtxApi: 'http://127.0.0.1:9997',
    allowedOrigins: ['https://cameras.mbfdhub.com', 'https://media-control.mbfdhub.com'],
    segmentDurationMin: 30,
    lowDiskThresholdBytes: 5 * 1024 * 1024 * 1024,
    criticalDiskThresholdBytes: 1 * 1024 * 1024 * 1024,
  };
}

function createInitialState() {
  return {
    recording: false,
    livestreaming: false,
    recordingSessionId: null,
    livestreamSessionId: null,
    recordingState: 'idle',
    streamState: 'idle',
    finalizationState: 'idle',
    synchronizationState: 'idle',
    uploadState: 'idle',
    recordingStartedAt: null,
    streamStartedAt: null,
    recordingPath: null,
    recordingProcess: null,
    recordingIdentity: null,
    streamProcess: null,
    lastRecording: null,
    errors: [],
    auditLog: [],
    idempotencyKeys: new Map(),
  };
}

function audit(action, details, operatorId) {
  const entry = {
    timestamp: new Date().toISOString(),
    action,
    details: typeof details === 'string' ? details : JSON.stringify(details),
    operatorId: operatorId || 'system',
    requestId: crypto.randomUUID(),
  };
  state.auditLog.push(entry);
  if (state.auditLog.length > 1000) state.auditLog.shift();
  return entry;
}

function addError(msg) {
  state.errors.push({ timestamp: new Date().toISOString(), message: msg });
  if (state.errors.length > 50) state.errors.shift();
}

function constantTimeCompare(a, b) {
  if (!a || !b) return false;
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function authMiddleware(req, res, next) {
  const token = req.headers['x-api-token'] || req.headers['authorization']?.replace(/^Bearer\s+/i, '');
  if (!token || !constantTimeCompare(token, CONFIG.token)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  req.operatorId = 'api-client';
  next();
}

function requestSignature(req, timestamp) {
  const operatorId = String(req.headers['x-operator-id'] || 'media-control-service');
  const nonce = String(req.headers['x-service-nonce'] || '');
  const ifMatch = String(req.headers['if-match'] || '');
  const bodyHash = crypto.createHash('sha256')
    .update(JSON.stringify(req.body == null ? null : req.body))
    .digest('hex');
  return crypto.createHmac('sha256', CONFIG.serviceSigningSecret)
    .update(`${req.method}\n${req.originalUrl}\n${timestamp}\n${bodyHash}\n${operatorId}\n${nonce}\n${ifMatch}`)
    .digest('hex');
}

const SERVICE_NONCE_ROOT = path.join(CONFIG.recordingDir, 'metadata', '.service-nonces');

// Destructive camera-edge calls must originate from the authenticated Media
// Control service. Operator identity is accepted only inside this signed
// envelope; a browser-supplied X-Operator-Id is never trusted directly.
function requireServiceAuth(req, res, next) {
  if (!CONFIG.serviceSigningSecret) {
    return res.status(503).json({ error: 'Signed camera service identity is not configured' });
  }
  const timestamp = String(req.headers['x-service-timestamp'] || '');
  const nonce = String(req.headers['x-service-nonce'] || '');
  const signature = String(req.headers['x-service-signature'] || '');
  const parsed = Date.parse(timestamp);
  if (!Number.isFinite(parsed) || Math.abs(Date.now() - parsed) > 60_000) {
    return res.status(401).json({ error: 'Invalid or expired service timestamp' });
  }
  if (!/^[a-f0-9-]{36}$/i.test(nonce)) {
    return res.status(401).json({ error: 'Invalid service nonce' });
  }
  if (!constantTimeCompare(signature, requestSignature(req, timestamp))) {
    return res.status(401).json({ error: 'Invalid service signature' });
  }
  try {
    if (!acceptFilesystemNonce(SERVICE_NONCE_ROOT, nonce, 60_000)) {
      return res.status(409).json({ error: 'Replayed service nonce' });
    }
  } catch (error) {
    addError(`Service nonce cache unavailable: ${error.message}`);
    return res.status(503).json({ error: 'Service replay protection unavailable' });
  }
  req.operatorId = String(req.headers['x-operator-id'] || 'media-control-service').slice(0, 128);
  req.serviceAuthenticated = true;
  next();
}

function rateLimiter(maxRequests, windowMs) {
  const requests = new Map();
  return (req, res, next) => {
    const key = req.ip || req.operatorId || 'unknown';
    const now = Date.now();
    const window = requests.get(key) || [];
    const filtered = window.filter(t => now - t < windowMs);
    if (filtered.length >= maxRequests) {
      return res.status(429).json({ error: 'Rate limit exceeded' });
    }
    filtered.push(now);
    requests.set(key, filtered);
    next();
  };
}

const commandRateLimit = rateLimiter(10, 60000);

function getDiskInfo(dirPath) {
  try {
    const stats = fs.statfsSync(dirPath);
    return {
      totalBytes: stats.bsize * stats.blocks,
      freeBytes: stats.bsize * stats.bfree,
      availableBytes: stats.bsize * stats.bavail,
      usedBytes: stats.bsize * (stats.blocks - stats.bfree),
    };
  } catch {
    return { totalBytes: 0, freeBytes: 0, availableBytes: 0, usedBytes: 0 };
  }
}

// Fail-closed storage gate. /mnt/data is a dedicated 1.7 TB data drive mounted
// via fstab (UUID). If it is unmounted, the recording dir resolves to the root
// filesystem — recordings must NEVER silently land on the root SSD. This returns
// ok only when the data drive is mounted AND the recording directory is writable.
function isDataDriveMounted() {
  try {
    const mounts = fs.readFileSync('/proc/mounts', 'utf8');
    return mounts.split('\n').some((l) => {
      const parts = l.split(/\s+/);
      return parts[1] === CONFIG.recordingDir || parts[1] === '/mnt/data';
    });
  } catch {
    return false;
  }
}

function verifyRecordingStorage() {
  if (!isDataDriveMounted()) {
    return { ok: false, error: 'Recording data drive /mnt/data is not mounted; refusing to record to root filesystem' };
  }
  // Confirm the recording dir actually lives on the data drive by comparing
  // device ids of the recording dir and the root filesystem.
  try {
    const recDev = fs.statSync(CONFIG.recordingDir).dev;
    const rootDev = fs.statSync('/').dev;
    if (recDev === rootDev) {
      return { ok: false, error: 'Recording directory is on the root filesystem, not the data drive' };
    }
    // Writable-directory sentinel: create + remove a probe file.
    const probe = path.join(CONFIG.recordingDir, `.write-probe-${Date.now()}`);
    fs.writeFileSync(probe, 'ok');
    fs.unlinkSync(probe);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: `Recording directory is not writable: ${e.message}` };
  }
}

async function checkMediaMtxPath(pathName) {
  try {
    const res = await fetch(`${CONFIG.mediamtxApi}/v3/paths/get/${pathName}`);
    if (!res.ok) return false;
    const data = await res.json();
    return data?.ready === true && data?.online === true;
  } catch {
    return false;
  }
}

function generateSessionId() {
  return `ses_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
}

function getRecordingFilePath(sessionId) {
  const date = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const dir = path.join(CONFIG.recordingDir, 'active', sessionId);
  fs.mkdirSync(dir, { recursive: true });
  return {
    dir,
    pattern: path.join(dir, `recording_${date}_%03d.mp4`),
    metadataPath: path.join(CONFIG.recordingDir, 'metadata', `${sessionId}.json`),
  };
}

async function startRecordingProcess(rtspUrl, outputPattern, sessionNonce) {
  const args = [
    '-nostdin', '-hide_banner', '-loglevel', 'warning',
    '-y',
    '-rtsp_transport', 'tcp',
    '-i', rtspUrl,
    '-map', '0:v:0', '-map', '0:a:0?',
    '-c:v', 'copy',
    '-c:a', 'aac', '-ar', '48000', '-ac', '1', '-b:a', '96k',
    '-af', 'aresample=async=1:first_pts=0',
    '-max_muxing_queue_size', '1024',
    '-f', 'segment',
    '-segment_time', String(CONFIG.segmentDurationMin * 60),
    '-segment_format', 'mp4',
    '-reset_timestamps', '1',
    '-movflags', '+frag_keyframe+empty_moov+default_base_moof',
    outputPattern,
  ];
  // Detached FFmpeg must not retain pipes to Node. Production supervision can
  // use the systemd template/journal; the compatible Node path ignores stdio.
  const proc = spawn('ffmpeg', args, {
    stdio: ['ignore', 'ignore', 'ignore'],
    detached: true,
    env: { ...process.env, MBFD_RECORDING_NONCE: sessionNonce },
  });
  await new Promise((resolve, reject) => {
    proc.once('spawn', resolve);
    proc.once('error', reject);
  });
  proc.unref();
  const identity = readProcessIdentity(proc.pid, { expectedOutputPath: outputPattern });
  if (identity.sessionNonce !== sessionNonce || identity.processGroup !== proc.pid) {
    try { process.kill(-proc.pid, 'SIGKILL'); } catch {}
    throw new Error('Unable to establish durable recording process identity');
  }
  return { proc, identity };
}

function startStreamProcess(rtspUrl, rtmpUrl, streamKey) {
  const fullRtmp = `${rtmpUrl}/${streamKey}`;
  const args = [
    '-nostdin', '-hide_banner', '-loglevel', 'warning',
    '-y',
    '-rtsp_transport', 'tcp',
    '-i', rtspUrl,
    '-map', '0:v:0', '-map', '0:a:0?',
    '-c:v', 'copy',
    '-c:a', 'aac', '-ar', '48000', '-ac', '1', '-b:a', '96k',
    '-af', 'aresample=async=1:first_pts=0',
    '-max_muxing_queue_size', '1024',
    '-f', 'flv',
    fullRtmp,
  ];
  const proc = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
  proc.stderr.on('data', d => {
    const msg = d.toString().trim();
    if (msg) console.error('[livestream]', msg);
  });
  return proc;
}

function stopProcess(proc) {
  return new Promise((resolve) => {
    if (!proc || proc.killed) return resolve(null);
    let settled = false;
    const finish = (code) => {
      if (settled) return;
      settled = true;
      resolve(code);
    };
    proc.once('close', finish);
    proc.kill('SIGINT');
    setTimeout(() => {
      if (!settled) proc.kill('SIGKILL');
    }, 10000);
    setTimeout(() => finish(null), 15000);
  });
}

// ── Durable recording state ──────────────────────────────────────────────
// The recording session state is persisted to disk so the camera-api can
// re-adopt a running FFmpeg process after a restart. This prevents the
// 11-12 minute recording death caused by camera-api restarts killing the
// FFmpeg child process.
const RECORDING_STATE_FILE = path.join(CONFIG.recordingDir, '.recording-state.json');

function saveRecordingState() {
  try {
    const stateData = {
      recording: state.recording,
      recordingSessionId: state.recordingSessionId,
      recordingStartedAt: state.recordingStartedAt,
      recordingPath: state.recordingPath,
      recordingIdentity: state.recordingIdentity,
      recordingState: state.recordingState,
      finalizationState: state.finalizationState,
      savedAt: new Date().toISOString(),
    };
    atomicWriteJson(RECORDING_STATE_FILE, stateData);
  } catch (e) {
    console.error('[recording-state] Failed to save:', e.message);
    throw e;
  }
}

function clearRecordingState() {
  try { fs.rmSync(RECORDING_STATE_FILE, { force: true }); } catch {}
}

function pidIsAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function monitorReAdoptedRecording(sessionId, identity) {
  const pid = identity.pid;
  const exitPoll = setInterval(() => {
    if (!pidIsAlive(pid)) {
      clearInterval(exitPoll);
      if (state.recordingSessionId !== sessionId) return;
      console.log(`[recording-state] Re-adopted recording PID ${pid} exited — finalizing`);
      state.recording = false;
      state.recordingState = 'stopped';
      state.recordingProcess = null;
      state.recordingExitPoll = null;
      finalizeRecording(sessionId).catch(e => {
        addError(`Finalization of re-adopted session ${sessionId} failed: ${e.message}`);
      });
    }
  }, 5000);
  state.recordingExitPoll = exitPoll;
}

// On startup, check for a recording that was running before the restart.
// If the FFmpeg process is still alive, re-adopt it so it survives this
// camera-api session. If it died, finalize the recording.
function readoptRecording() {
  try {
    if (!fs.existsSync(RECORDING_STATE_FILE)) return;
    const data = JSON.parse(fs.readFileSync(RECORDING_STATE_FILE, 'utf8'));
    if (isInterruptedFinalization(data)) {
      state.recording = false;
      state.recordingSessionId = data.recordingSessionId;
      state.recordingStartedAt = data.recordingStartedAt || null;
      state.recordingPath = data.recordingPath || null;
      state.recordingIdentity = data.recordingIdentity || null;
      state.recordingState = 'finalizing';
      state.finalizationState = 'finalizing';
      console.log(`[recording-state] Resuming interrupted finalization for ${data.recordingSessionId}`);
      finalizeRecording(data.recordingSessionId).catch((error) => {
        addError(`Recovery finalization of ${data.recordingSessionId} failed: ${error.message}`);
      });
      return;
    }
    if (!data.recording) { clearRecordingState(); return; }
    if (!data.recordingSessionId || !data.recordingIdentity) {
      // A pre-hardening state file contains only sessionId/PID. A PID-only
      // record cannot be signalled safely. Preserve it, block a second
      // recording, and require explicit operator reconciliation.
      if (data.sessionId && data.recordingPid) {
        state.recording = true;
        state.recordingSessionId = data.sessionId;
        state.recordingStartedAt = data.recordingStartedAt || null;
        state.recordingPath = data.recordingPath || null;
        state.recordingState = 'unverified_legacy';
        addError(`Legacy recording state for ${data.sessionId} lacks process identity; refusing automatic adoption or signalling`);
        return;
      }
      clearRecordingState();
      return;
    }

    const actualIdentity = pidIsAlive(data.recordingIdentity.pid)
      ? readProcessIdentity(data.recordingIdentity.pid, { expectedOutputPath: data.recordingIdentity.outputPath })
      : null;
    const alive = processIdentityMatches(data.recordingIdentity, actualIdentity);
    if (alive) {
      console.log(`[recording-state] Re-adopting recording session ${data.recordingSessionId} (PID ${data.recordingIdentity.pid})`);
      // The process is detached and still running — we can't re-attach the
      // stdio streams, but we can track its PID for stop/finalize.
      // Create a minimal handle that lets us send signals.
      state.recording = true;
      state.recordingSessionId = data.recordingSessionId;
      state.recordingState = 'recording';
      state.finalizationState = data.finalizationState || 'idle';
      state.recordingStartedAt = data.recordingStartedAt;
      state.recordingPath = data.recordingPath;
      state.recordingIdentity = data.recordingIdentity;
      monitorReAdoptedRecording(data.recordingSessionId, data.recordingIdentity);
      // Re-adopted processes are stopped by validated identity + exit polling,
      // never by a fabricated ChildProcess close event.
      state.recordingProcess = null;
    } else {
      console.log(`[recording-state] Recording session ${data.recordingSessionId} is no longer running or failed identity validation — finalizing without signalling`);
      clearRecordingState();
      finalizeRecording(data.recordingSessionId).catch(e => {
        addError(`Finalization of orphaned session ${data.recordingSessionId} failed: ${e.message}`);
      });
    }
  } catch (e) {
    console.error('[recording-state] Failed to readopt:', e.message);
    clearRecordingState();
  }
}

async function finalizeRecording(sessionId) {
  const dir = path.join(CONFIG.recordingDir, 'active', sessionId);
  const completedDir = path.join(CONFIG.recordingDir, 'completed', sessionId);
  const finalPath = path.join(completedDir, `${sessionId}.mp4`);
  const finalTempPath = path.join(completedDir, `.${sessionId}.finalizing.mp4`);
  state.recording = false;
  state.recordingSessionId = sessionId;
  state.finalizationState = 'finalizing';
  state.recordingState = 'finalizing';
  saveRecordingState();

  try {
    fs.mkdirSync(completedDir, { recursive: true });
    const files = fs.existsSync(dir)
      ? fs.readdirSync(dir).filter(f => f.endsWith('.mp4')).sort()
      : [];

    if (!fs.existsSync(finalPath) && files.length === 0) {
      throw new Error(`No recording segments found for session ${sessionId}`);
    }

    // Recovery is idempotent: a crash may happen after the final file is
    // atomically renamed/concatenated but before metadata is committed.
    if (!fs.existsSync(finalPath) && files.length === 1) {
      fs.renameSync(path.join(dir, files[0]), finalPath);
    } else if (!fs.existsSync(finalPath)) {
      // FFmpeg writes a recoverable temporary output. A crash can never leave a
      // partial file at the authoritative final path.
      fs.rmSync(finalTempPath, { force: true });
      const concatList = path.join(dir, 'concat.txt');
      const concatContent = files.map(f => `file '${path.join(dir, f)}'`).join('\n');
      fs.writeFileSync(concatList, concatContent);
      await new Promise((resolve, reject) => {
        execFile('ffmpeg', [
          '-nostdin', '-hide_banner', '-loglevel', 'warning', '-y',
          '-f', 'concat', '-safe', '0', '-i', concatList,
          '-c', 'copy', finalTempPath
        ], (err) => err ? reject(err) : resolve());
      });
      const finalFd = fs.openSync(finalTempPath, 'r');
      try { fs.fsyncSync(finalFd); } finally { fs.closeSync(finalFd); }
      fs.renameSync(finalTempPath, finalPath);
    }

    const probeResult = await new Promise((resolve) => {
      execFile('ffprobe', [
        '-v', 'error', '-show_entries', 'format=duration,size',
        '-show_entries', 'stream=codec_type,codec_name,width,height,r_frame_rate',
        '-of', 'json', finalPath
      ], (err, stdout) => {
        if (err) return resolve({ ok: false });
        try { return resolve({ ok: true, data: JSON.parse(stdout) }); }
        catch { return resolve({ ok: false }); }
      });
    });

    const fileHash = await new Promise((resolve) => {
      execFile('sha256sum', [finalPath], (err, stdout) => {
        resolve(err ? null : stdout.split(' ')[0]);
      });
    });

    const validation = validateFinalizedMedia({
      probe: probeResult.ok ? probeResult.data : null,
      sha256: fileHash,
    });
    if (!validation.ok) throw new Error(validation.error);
    const videoStream = validation.video;
    const audioStream = validation.audio;

    const metadata = {
      sessionId,
      finalizedAt: new Date().toISOString(),
      filePath: finalPath,
      duration: validation.duration,
      sizeBytes: validation.sizeBytes,
      sha256: validation.sha256,
      segments: Math.max(files.length, 1),
      validated: true,
      videoCodec: videoStream?.codec_name || null,
      audioCodec: audioStream?.codec_name || null,
      resolution: videoStream ? `${videoStream.width}x${videoStream.height}` : null,
      synced: false,
      syncedAt: null,
      synchronizationState: 'idle',
      uploaded: false,
      uploadedAt: null,
      uploadState: 'idle',
      peertubeVideoId: null,
      peertubeVideoUuid: null,
      peertubeWatchUrl: null,
      peertubePrivacy: null,
      published: false,
      publishedAt: null,
      error: null,
    };

    atomicWriteJson(path.join(CONFIG.recordingDir, 'metadata', `${sessionId}.json`), metadata);

    fs.rmSync(dir, { recursive: true, force: true });

    state.lastRecording = metadata;
    state.finalizationState = 'complete';
    state.recordingState = 'idle';
    state.recordingSessionId = null;
    state.recordingIdentity = null;
    state.recordingPath = null;
    clearRecordingState();
    return { ok: true, metadata };
  } catch (e) {
    state.finalizationState = 'failed';
    state.recordingState = 'failed';
    saveRecordingState();
    addError(`Finalization failed: ${e.message}`);
    try {
      const failedDir = path.join(CONFIG.recordingDir, 'failed', sessionId);
      fs.mkdirSync(failedDir, { recursive: true });
      if (fs.existsSync(dir)) fs.cpSync(dir, failedDir, { recursive: true });
      if (fs.existsSync(finalPath)) fs.copyFileSync(finalPath, path.join(failedDir, `${sessionId}.mp4`));
    } catch {}
    return { ok: false, error: e.message };
  }
}

// Run a shell command (rsync / ssh) and resolve {ok, stdout, stderr, code}.
function runCmd(file, args, timeoutMs) {
  return new Promise((resolve) => {
    execFile(file, args, { timeout: timeoutMs || 600000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ ok: !err, stdout: stdout || '', stderr: stderr || '', code: err ? (err.code || 1) : 0, err });
    });
  });
}

// Synchronize one recording to the GMKtec over LAN (primary) with Tailscale
// fallback. A recording is classified as synchronized ONLY when the remote
// SHA-256 matches the local checksum; syncVerified is set true and remoteChecksum
// is stored only on a confirmed match. On any transfer/verify failure the
// Kamrui copy is preserved and a verification failure is reported. Retrying a
// fully-synchronized recording is idempotent (rsync --checksum + early return).
async function syncToGmktec(sessionId) {
  const metadataPath = path.join(CONFIG.recordingDir, 'metadata', `${sessionId}.json`);
  let metadata;
  try {
    metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
  } catch {
    return { ok: false, error: 'Metadata not found' };
  }

  // Idempotent: already verified-synchronized.
  if (metadata.synced && metadata.syncVerified) {
    return { ok: true, message: 'Already synchronized and verified', destination: metadata.syncDestination, remoteChecksum: metadata.remoteChecksum };
  }

  const srcFile = metadata.filePath;
  if (!srcFile || !fs.existsSync(srcFile)) {
    return { ok: false, error: 'Recording file not found' };
  }
  if (!metadata.sha256) {
    return { ok: false, error: 'Local SHA-256 missing; cannot verify synchronization' };
  }

  const syncUser = CONFIG.gmktecSyncUser || 'mbfd';
  const syncPath = CONFIG.gmktecSyncPath || '/mnt/mbfd-storage/mbfd-broadcasts';
  const hosts = [CONFIG.gmktecLanIp, CONFIG.gmktecTailscaleIp].filter(Boolean);
  if (hosts.length === 0) {
    return { ok: false, error: 'No sync destination configured' };
  }

  const sshOpts = ['-o', 'ConnectTimeout=10', '-o', 'StrictHostKeyChecking=accept-new', '-o', 'BatchMode=yes'];
  const fileName = path.basename(srcFile);
  const remoteRelPath = `${syncPath}/${fileName}`;
  const rsyncE = ['-avz', '--checksum', '--timeout=300', '-e', `ssh ${sshOpts.join(' ')}`];

  let lastError = null;
  let usedHost = null;
  let rsyncOk = false;
  state.synchronizationState = 'syncing';
  metadata.synchronizationState = 'syncing';
  atomicWriteJson(metadataPath, metadata);

  for (const host of hosts) {
    const dest = `${syncUser}@${host}:${remoteRelPath}`;
    const r = await runCmd('rsync', [...rsyncE, srcFile, dest], 600000);
    if (r.ok) {
      usedHost = host;
      rsyncOk = true;
      break;
    }
    lastError = r.stderr || r.err?.message || 'rsync failed';
    // Continue to the next (fallback) host.
  }

  if (!rsyncOk) {
    addError(`Sync failed for ${sessionId} on all hosts: ${lastError}`);
    metadata.synced = false;
    metadata.syncVerified = false;
    metadata.remoteChecksum = null;
    metadata.syncError = lastError;
    metadata.synchronizationState = 'failed';
    state.synchronizationState = 'failed';
    atomicWriteJson(metadataPath, metadata);
    return { ok: false, error: `Synchronization failed: ${lastError}`, attemptedHosts: hosts };
  }

  // Verify the remote SHA-256 matches the local checksum. Synced/syncVerified
  // are set true ONLY on a confirmed match.
  const verifyR = await runCmd('ssh', [...sshOpts, `${syncUser}@${usedHost}`, 'sha256sum', remoteRelPath], 60000);
  const remoteHash = verifyR.ok ? (verifyR.stdout.split(' ')[0] || null) : null;
  const verified = !!remoteHash && remoteHash === metadata.sha256;

  metadata.synced = verified;
  metadata.syncedAt = verified ? new Date().toISOString() : metadata.syncedAt || null;
  metadata.syncVerified = verified;
  metadata.remoteChecksum = remoteHash;
  metadata.syncDestination = `${syncUser}@${usedHost}:${remoteRelPath}`;
  metadata.syncHost = usedHost;
  metadata.syncPathIsLan = usedHost === CONFIG.gmktecLanIp;
  metadata.syncError = verified ? null : (verifyR.ok ? 'Remote checksum mismatch' : (verifyR.stderr || verifyR.err?.message || 'Remote checksum verification failed'));
  metadata.synchronizationState = verified ? 'complete' : 'failed';
  state.synchronizationState = metadata.synchronizationState;
  atomicWriteJson(metadataPath, metadata);

  if (!verified) {
    addError(`Sync verification failed for ${sessionId}: ${metadata.syncError} (local copy preserved)`);
    return {
      ok: false,
      error: `Synchronization verification failed: ${metadata.syncError}`,
      destination: metadata.syncDestination,
      localChecksum: metadata.sha256,
      remoteChecksum: remoteHash,
      localCopyPreserved: true,
    };
  }

  return {
    ok: true,
    destination: metadata.syncDestination,
    checksumVerified: true,
    localChecksum: metadata.sha256,
    remoteChecksum: remoteHash,
    usedHost,
    pathIsLan: metadata.syncPathIsLan,
  };
}

async function uploadToPeerTube(sessionId) {
  const metadataPath = path.join(CONFIG.recordingDir, 'metadata', `${sessionId}.json`);
  let metadata;
  try {
    metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
  } catch {
    return { ok: false, error: 'Metadata not found' };
  }

  if (metadata.uploaded && metadata.peertubeVideoUuid) {
    return { ok: true, message: 'Already uploaded', peertubeVideoUuid: metadata.peertubeVideoUuid };
  }

  if (!metadata.filePath || !fs.existsSync(metadata.filePath)) {
    return { ok: false, error: 'Recording file not found' };
  }

  if (!CONFIG.peertubeBaseUrl || !CONFIG.peertubeAccessToken) {
    return { ok: false, error: 'PeerTube not configured' };
  }

  process.env.PEERTUBE_BASE_URL = CONFIG.peertubeBaseUrl;
  process.env.PEERTUBE_ACCESS_TOKEN = CONFIG.peertubeAccessToken;
  metadata.uploadState = 'uploading';
  state.uploadState = 'uploading';
  atomicWriteJson(metadataPath, metadata);

  try {
    const result = await peertube.uploadRecording(metadata.filePath, {
      name: `MBFD Recording ${sessionId} - ${new Date(metadata.finalizedAt).toLocaleDateString()}`,
      description: `Recorded: ${metadata.finalizedAt}\nDuration: ${metadata.duration}s\nSession: ${sessionId}\nSHA-256: ${metadata.sha256}`,
      channelId: 2,
      privacy: 3,
      tags: ['mbfd', 'recording', 'annke'],
      language: 'en',
      recordingDate: metadata.finalizedAt,
    });

    if (result.ok) {
      metadata.uploaded = true;
      metadata.uploadedAt = new Date().toISOString();
      metadata.peertubeVideoId = result.videoId;
      metadata.peertubeVideoUuid = result.videoUuid;
      metadata.peertubeWatchUrl = result.watchUrl;
      metadata.peertubePrivacy = 3;
      metadata.uploadState = 'complete';
      state.uploadState = 'complete';
      atomicWriteJson(metadataPath, metadata);
    } else {
      metadata.error = result.error || 'Upload failed';
      metadata.uploadState = 'failed';
      state.uploadState = 'failed';
      atomicWriteJson(metadataPath, metadata);
    }

    return result;
  } catch (e) {
    const errorMsg = e.message || 'Upload crashed';
    addError(`PeerTube upload failed: ${errorMsg}`);
    metadata.error = errorMsg;
    metadata.uploadState = 'failed';
    state.uploadState = 'failed';
    atomicWriteJson(metadataPath, metadata);
    return { ok: false, error: errorMsg };
  }
}

async function publishRecording(sessionId, privacy) {
  const metadataPath = path.join(CONFIG.recordingDir, 'metadata', `${sessionId}.json`);
  let metadata;
  try {
    metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
  } catch {
    return { ok: false, error: 'Metadata not found' };
  }

  if (!metadata.peertubeVideoUuid) {
    return { ok: false, error: 'Recording not uploaded to PeerTube' };
  }

  if (!CONFIG.peertubeBaseUrl || !CONFIG.peertubeAccessToken) {
    return { ok: false, error: 'PeerTube not configured' };
  }

  process.env.PEERTUBE_BASE_URL = CONFIG.peertubeBaseUrl;
  process.env.PEERTUBE_ACCESS_TOKEN = CONFIG.peertubeAccessToken;

  const confirmPublic = privacy === 1;
  try {
    const result = await peertube.updatePrivacy(metadata.peertubeVideoUuid, privacy, { confirmPublic });

    if (result.ok) {
      metadata.peertubePrivacy = privacy;
      metadata.published = privacy !== 3;
      metadata.publishedAt = privacy !== 3 ? new Date().toISOString() : null;
      atomicWriteJson(metadataPath, metadata);
    }

    return result;
  } catch (e) {
    const errorMsg = e.message || 'Publish crashed';
    addError(`PeerTube publish failed: ${errorMsg}`);
    return { ok: false, error: errorMsg };
  }
}

app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && CONFIG.allowedOrigins.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Api-Token, Authorization, X-Idempotency-Key');
    res.setHeader('Access-Control-Max-Age', '86400');
  }
  if (req.method === 'OPTIONS') return res.status(204).end();
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-Request-Id', crypto.randomUUID());
  next();
});

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', uptime: process.uptime(), timestamp: new Date().toISOString() });
});

app.get('/api/status', authMiddleware, async (req, res) => {
  const [cameraOnline, previewOnline] = await Promise.all([
    checkMediaMtxPath('annke-main'),
    checkMediaMtxPath('annke-preview'),
  ]);

  const disk = getDiskInfo(CONFIG.recordingDir);

  res.json({
    camera_online: cameraOnline,
    preview_online: previewOnline,
    recording: state.recording,
    livestreaming: state.livestreaming,
    session_id: state.recordingSessionId || state.livestreamSessionId,
    recording_session_id: state.recordingSessionId,
    livestream_session_id: state.livestreamSessionId,
    recording_state: state.recordingState,
    stream_state: state.streamState,
    finalization_state: state.finalizationState,
    synchronization_state: state.synchronizationState,
    upload_state: state.uploadState,
    recording_started_at: state.recordingStartedAt,
    stream_started_at: state.streamStartedAt,
    recording_path: state.recordingPath,
    last_recording: state.lastRecording,
    peertube_video_id: state.lastRecording?.peertubeVideoId || null,
    peertube_privacy: state.lastRecording?.peertubePrivacy || null,
    disk_free_bytes: disk.freeBytes,
    disk_total_bytes: disk.totalBytes,
    disk_low: disk.freeBytes < CONFIG.lowDiskThresholdBytes,
    disk_critical: disk.freeBytes < CONFIG.criticalDiskThresholdBytes,
    errors: state.errors,
    uptime_seconds: Math.floor(process.uptime()),
  });
});

app.get('/api/storage', authMiddleware, (req, res) => {
  const recordingDisk = getDiskInfo(CONFIG.recordingDir);
  res.json({ recording_disk: recordingDisk });
});

app.get('/api/session/current', authMiddleware, (req, res) => {
  if (!state.recordingSessionId && !state.livestreamSessionId) return res.json({ active: false });
  res.json({
    active: true,
    session_id: state.recordingSessionId || state.livestreamSessionId,
    recording_session_id: state.recordingSessionId,
    livestream_session_id: state.livestreamSessionId,
    recording: state.recording,
    livestreaming: state.livestreaming,
    recording_started_at: state.recordingStartedAt,
    stream_started_at: state.streamStartedAt,
  });
});

app.post('/api/record/start', authMiddleware, commandRateLimit, async (req, res) => {
  const idempotencyKey = req.headers['x-idempotency-key'];
  if (idempotencyKey && state.idempotencyKeys.has(idempotencyKey)) {
    return res.json(state.idempotencyKeys.get(idempotencyKey));
  }

  if (state.recording) {
    return res.status(409).json({ ok: false, error: 'Already recording', session_id: state.recordingSessionId });
  }

  const mainOnline = await checkMediaMtxPath('annke-main');
  if (!mainOnline) {
    addError('Cannot start recording: annke-main stream not available');
    return res.status(503).json({ ok: false, error: 'Camera stream not available' });
  }

  // Fail-closed storage gate: never record to the root filesystem.
  const storage = verifyRecordingStorage();
  if (!storage.ok) {
    addError(`Cannot start recording: ${storage.error}`);
    return res.status(507).json({ ok: false, error: storage.error });
  }

  const disk = getDiskInfo(CONFIG.recordingDir);
  if (disk.freeBytes < CONFIG.criticalDiskThresholdBytes) {
    addError('Cannot start recording: disk critically low');
    return res.status(507).json({ ok: false, error: 'Disk space critically low' });
  }
  if (disk.freeBytes < CONFIG.lowDiskThresholdBytes) {
    addError('Cannot start recording: disk space low');
    return res.status(507).json({ ok: false, error: 'Disk space low' });
  }

  const sessionId = generateSessionId();
  const { dir, pattern } = getRecordingFilePath(sessionId);
  const sessionNonce = crypto.randomBytes(32).toString('hex');

  const rtspSource = `${CONFIG.mediamtxRtsp}/annke-main`;
  const { proc, identity } = await startRecordingProcess(rtspSource, pattern, sessionNonce);

  state.recording = true;
  state.recordingSessionId = sessionId;
  state.recordingState = 'recording';
  state.finalizationState = 'idle';
  state.recordingStartedAt = new Date().toISOString();
  state.recordingPath = dir;
  state.recordingProcess = proc;
  state.recordingIdentity = identity;

  // Persist state so the recording survives camera-api restarts.
  try {
    saveRecordingState();
  } catch (error) {
    try { await stopValidatedProcess(identity); } catch {}
    state.recording = false;
    state.recordingState = 'failed';
    state.recordingSessionId = null;
    state.recordingProcess = null;
    state.recordingIdentity = null;
    state.recordingStartedAt = null;
    state.recordingPath = null;
    clearRecordingState();
    throw error;
  }

  proc.on('close', (code) => {
    if (state.recordingProcess === proc) {
      state.recording = false;
      state.recordingState = 'stopped';
      state.recordingProcess = null;
      if (code !== 0 && code !== null) {
        addError(`Recording process exited with code ${code}`);
      }
      // Auto-finalize when the recording process exits unexpectedly.
      finalizeRecording(sessionId).catch(e => {
        addError(`Auto-finalization of session ${sessionId} failed: ${e.message}`);
      });
    }
  });

  const entry = audit('record.start', { sessionId }, req.operatorId);

  const response = {
    ok: true,
    session_id: sessionId,
    started_at: state.recordingStartedAt,
    request_id: entry.requestId,
  };

  if (idempotencyKey) {
    state.idempotencyKeys.set(idempotencyKey, response);
    setTimeout(() => state.idempotencyKeys.delete(idempotencyKey), 300000);
  }

  res.json(response);
});

app.post('/api/record/stop', authMiddleware, commandRateLimit, async (req, res) => {
  const idempotencyKey = req.headers['x-idempotency-key'];
  if (idempotencyKey && state.idempotencyKeys.has(idempotencyKey)) {
    const cached = state.idempotencyKeys.get(idempotencyKey);
    return res.status(cached.ok ? 200 : 422).json(cached);
  }

  if (!state.recording) {
    return res.status(409).json({ ok: false, error: 'Not recording' });
  }

  const sessionId = state.recordingSessionId;
  const identity = state.recordingIdentity;
  const proc = state.recordingProcess;
  const recordingStartedAt = state.recordingStartedAt;
  if (!identity) {
    return res.status(409).json({
      ok: false,
      error: 'Recording process identity is unavailable; refusing to signal. Reconcile the legacy session manually.',
      session_id: sessionId,
    });
  }

  state.recording = false;
  state.recordingState = 'stopping';
  state.recordingProcess = null;
  state.recordingStartedAt = null;
  if (state.recordingExitPoll) { clearInterval(state.recordingExitPoll); state.recordingExitPoll = null; }

  try {
    await stopValidatedProcess(identity);
  } catch (error) {
    // Fail closed: identity validation errors signal nothing. Restore the
    // active in-memory view so an operator can retry without an API restart.
    state.recording = true;
    state.recordingState = 'recording';
    state.recordingProcess = proc;
    state.recordingStartedAt = recordingStartedAt;
    if (!proc) monitorReAdoptedRecording(sessionId, identity);
    throw error;
  }

  const finalizeResult = await finalizeRecording(sessionId);
  state.recordingPath = null;

  const entry = audit('record.stop', { sessionId, finalizeResult }, req.operatorId);

  const response = {
    ok: finalizeResult.ok,
    session_id: sessionId,
    stopped_at: new Date().toISOString(),
    recording: finalizeResult.metadata || null,
    request_id: entry.requestId,
  };

  if (idempotencyKey) {
    state.idempotencyKeys.set(idempotencyKey, response);
    setTimeout(() => state.idempotencyKeys.delete(idempotencyKey), 300000);
  }

  res.status(finalizeResult.ok ? 200 : 422).json(response);
});

app.post('/api/stream/start', authMiddleware, commandRateLimit, async (req, res) => {
  const idempotencyKey = req.headers['x-idempotency-key'];
  if (idempotencyKey && state.idempotencyKeys.has(idempotencyKey)) {
    return res.json(state.idempotencyKeys.get(idempotencyKey));
  }

  if (state.livestreaming) {
    return res.status(409).json({ ok: false, error: 'Already livestreaming' });
  }

  if (!CONFIG.peertubeRtmpUrl || !CONFIG.peertubeStreamKey) {
    return res.status(503).json({ ok: false, error: 'PeerTube RTMP not configured' });
  }

  const mainOnline = await checkMediaMtxPath('annke-main');
  if (!mainOnline) {
    addError('Cannot start livestream: annke-main stream not available');
    return res.status(503).json({ ok: false, error: 'Camera stream not available' });
  }

  const rtspSource = `${CONFIG.mediamtxRtsp}/annke-main`;
  const proc = startStreamProcess(rtspSource, CONFIG.peertubeRtmpUrl, CONFIG.peertubeStreamKey);

  state.livestreaming = true;
  state.streamState = 'streaming';
  state.livestreamSessionId = generateSessionId();
  state.streamStartedAt = new Date().toISOString();
  state.streamProcess = proc;

  proc.on('close', (code) => {
    if (state.streamProcess === proc) {
      state.livestreaming = false;
      state.streamState = code === 0 || code === null ? 'idle' : 'failed';
      state.streamProcess = null;
      state.livestreamSessionId = null;
      state.streamStartedAt = null;
      if (code !== 0 && code !== null) {
        addError(`Livestream process exited with code ${code}`);
      }
    }
  });

  const entry = audit('stream.start', { sessionId: state.livestreamSessionId }, req.operatorId);

  const response = {
    ok: true,
    session_id: state.livestreamSessionId,
    started_at: state.streamStartedAt,
    peertube_watch_url: `https://videos.mbfdhub.com/videos/watch/${CONFIG.peertubeLiveVideoUuid}`,
    request_id: entry.requestId,
  };

  if (idempotencyKey) {
    state.idempotencyKeys.set(idempotencyKey, response);
    setTimeout(() => state.idempotencyKeys.delete(idempotencyKey), 300000);
  }

  res.json(response);
});

app.post('/api/stream/stop', authMiddleware, commandRateLimit, async (req, res) => {
  const idempotencyKey = req.headers['x-idempotency-key'];
  if (idempotencyKey && state.idempotencyKeys.has(idempotencyKey)) {
    return res.json(state.idempotencyKeys.get(idempotencyKey));
  }

  if (!state.livestreaming) {
    return res.status(409).json({ ok: false, error: 'Not livestreaming' });
  }

  const proc = state.streamProcess;
  state.livestreaming = false;
  state.streamState = 'stopping';
  state.streamProcess = null;
  state.streamStartedAt = null;

  await stopProcess(proc);
  state.streamState = 'idle';
  state.livestreamSessionId = null;

  const entry = audit('stream.stop', {}, req.operatorId);

  const response = {
    ok: true,
    stopped_at: new Date().toISOString(),
    request_id: entry.requestId,
  };

  if (idempotencyKey) {
    state.idempotencyKeys.set(idempotencyKey, response);
    setTimeout(() => state.idempotencyKeys.delete(idempotencyKey), 300000);
  }

  res.json(response);
});

app.post('/api/emergency-stop', authMiddleware, async (req, res) => {
  const entry = audit('emergency.stop', {}, req.operatorId);

  const recordingProc = state.recordingProcess;
  const recordingIdentity = state.recordingIdentity;
  const recordingSessionId = state.recordingSessionId;
  const streamProc = state.streamProcess;

  state.recording = false;
  state.livestreaming = false;
  state.recordingProcess = null;
  state.streamProcess = null;
  state.recordingStartedAt = null;
  state.streamStartedAt = null;
  state.recordingPath = null;

  await Promise.all([
    recordingIdentity ? stopValidatedProcess(recordingIdentity) : stopProcess(recordingProc),
    stopProcess(streamProc),
  ]);

  if (recordingSessionId) {
    try { await finalizeRecording(recordingSessionId); } catch {}
  }

  state.recordingSessionId = null;
  state.livestreamSessionId = null;
  state.recordingState = 'idle';
  state.streamState = 'idle';

  res.json({
    ok: true,
    stopped_at: new Date().toISOString(),
    request_id: entry.requestId,
  });
});

// Rewrite /api/camera-recordings/* -> /api/recordings/* (suggested API surface alias)
app.use((req, res, next) => {
  if (req.url.startsWith('/api/camera-recordings')) {
    req.url = req.url.replace('/api/camera-recordings', '/api/recordings');
  }
  next();
});

app.get('/api/recordings', authMiddleware, (req, res) => {
  const metadataDir = path.join(CONFIG.recordingDir, 'metadata');
  try {
    const files = fs.readdirSync(metadataDir).filter(f => f.endsWith('.json'));
    const recordings = files.map(f => {
      try { return JSON.parse(fs.readFileSync(path.join(metadataDir, f), 'utf8')); }
      catch { return null; }
    }).filter(Boolean).sort((a, b) => (b.finalizedAt || '').localeCompare(a.finalizedAt || ''));
    res.json({ recordings });
  } catch {
    res.json({ recordings: [] });
  }
});

app.get('/api/recordings/:id', authMiddleware, (req, res) => {
  const metadataPath = path.join(CONFIG.recordingDir, 'metadata', `${req.params.id}.json`);
  try {
    const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
    res.json(metadata);
  } catch {
    res.status(404).json({ error: 'Recording not found' });
  }
});

app.post('/api/recordings/:id/upload', authMiddleware, commandRateLimit, async (req, res) => {
  if (!validateSessionId(req.params.id)) return res.status(400).json({ error: 'Invalid session ID' });
  const result = await withRecordingOperationLease(
    req.params.id,
    `upload:${crypto.randomUUID()}`,
    () => uploadToPeerTube(req.params.id),
  );
  audit('recording.upload', { sessionId: req.params.id, result }, req.operatorId);
  res.status(result.locked ? 409 : 200).json(result);
});

app.post('/api/recordings/:id/sync', authMiddleware, commandRateLimit, async (req, res) => {
  if (!validateSessionId(req.params.id)) return res.status(400).json({ error: 'Invalid session ID' });
  const result = await withRecordingOperationLease(
    req.params.id,
    `sync:${crypto.randomUUID()}`,
    () => syncToGmktec(req.params.id),
  );
  audit('recording.sync', { sessionId: req.params.id, result }, req.operatorId);
  res.status(result.locked ? 409 : 200).json(result);
});

app.post('/api/recordings/:id/publish', authMiddleware, commandRateLimit, async (req, res) => {
  if (!validateSessionId(req.params.id)) return res.status(400).json({ error: 'Invalid session ID' });
  const privacy = req.body?.privacy || 3;
  if (![1, 2, 3].includes(privacy)) {
    return res.status(400).json({ error: 'Invalid privacy value. Use 1=Public, 2=Unlisted, 3=Private' });
  }
  const result = await withRecordingOperationLease(
    req.params.id,
    `publish:${crypto.randomUUID()}`,
    () => publishRecording(req.params.id, privacy),
  );
  audit('recording.publish', { sessionId: req.params.id, privacy, result }, req.operatorId);
  res.status(result.locked ? 409 : 200).json(result);
});

// Alias: /api/recordings/:id/privacy (same as /publish)
app.post('/api/recordings/:id/privacy', authMiddleware, commandRateLimit, async (req, res) => {
  if (!validateSessionId(req.params.id)) return res.status(400).json({ error: 'Invalid session ID' });
  const privacy = req.body?.privacy || 3;
  if (![1, 2, 3].includes(privacy)) {
    return res.status(400).json({ error: 'Invalid privacy value. Use 1=Public, 2=Unlisted, 3=Private' });
  }
  if (privacy === 1 && req.body?.confirmPublic !== true) {
    return res.status(400).json({ error: 'Setting to Public requires confirmPublic: true' });
  }
  const result = await withRecordingOperationLease(
    req.params.id,
    `privacy:${crypto.randomUUID()}`,
    () => publishRecording(req.params.id, privacy),
  );
  audit('recording.privacy', { sessionId: req.params.id, privacy, result }, req.operatorId);
  res.status(result.locked ? 409 : 200).json(result);
});

// Helper: validate session ID (reject path traversal, allow only alnum + underscore)
function validateSessionId(id) {
  return /^ses_[A-Za-z0-9_-]+$/.test(String(id || ''));
}

// Helper: find recording file path from metadata
function getRecordingFile(sessionId) {
  if (!validateSessionId(sessionId)) return null;
  const metadataPath = path.join(CONFIG.recordingDir, 'metadata', `${sessionId}.json`);
  try {
    const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
    if (!metadata.filePath || !fs.existsSync(metadata.filePath)) return null;
    // Ensure the file path is inside the completed dir (no traversal)
    const completedDir = path.join(CONFIG.recordingDir, 'completed');
    const resolved = path.resolve(metadata.filePath);
    if (!resolved.startsWith(completedDir + path.sep)) return null;
    return metadata;
  } catch {
    return null;
  }
}

// Playback: stream the MP4 with HTTP Range support
app.get('/api/recordings/:id/play', authMiddleware, (req, res) => {
  const meta = getRecordingFile(req.params.id);
  if (!meta) return res.status(404).json({ error: 'Recording not found' });
  const filePath = meta.filePath;
  try {
    const stat = fs.statSync(filePath);
    const fileSize = stat.size;
    const range = req.headers.range;
    if (range) {
      const parts = /bytes=(\d*)-(\d*)/.exec(range);
      if (parts) {
        const start = parts[1] ? parseInt(parts[1], 10) : 0;
        const end = parts[2] ? parseInt(parts[2], 10) : fileSize - 1;
        if (start >= fileSize || end >= fileSize || start > end) {
          res.status(416).set('Content-Range', `bytes */${fileSize}`);
          return res.end();
        }
        const chunkSize = end - start + 1;
        const stream = fs.createReadStream(filePath, { start, end });
        res.status(206).set({
          'Content-Range': `bytes ${start}-${end}/${fileSize}`,
          'Accept-Ranges': 'bytes',
          'Content-Length': chunkSize,
          'Content-Type': 'video/mp4',
          'Content-Disposition': 'inline',
        });
        stream.pipe(res);
        stream.on('error', () => { if (!res.headersSent) res.status(500).json({ error: 'Stream error' }); });
        return;
      }
    }
    // No range: send entire file
    res.set({
      'Content-Type': 'video/mp4',
      'Content-Length': fileSize,
      'Accept-Ranges': 'bytes',
      'Content-Disposition': 'inline',
    });
    fs.createReadStream(filePath).pipe(res);
  } catch (e) {
    res.status(500).json({ error: 'Cannot read recording file' });
  }
});

// Download: serve the MP4 as an attachment (no RAM buffering)
app.get('/api/recordings/:id/download', authMiddleware, (req, res) => {
  const meta = getRecordingFile(req.params.id);
  if (!meta) return res.status(404).json({ error: 'Recording not found' });
  const filePath = meta.filePath;
  try {
    const stat = fs.statSync(filePath);
    const safeName = `${req.params.id}.mp4`;
    res.set({
      'Content-Type': 'video/mp4',
      'Content-Length': stat.size,
      'Content-Disposition': `attachment; filename="${safeName}"`,
      'Accept-Ranges': 'bytes',
    });
    fs.createReadStream(filePath).pipe(res);
  } catch (e) {
    res.status(500).json({ error: 'Cannot read recording file' });
  }
});

// PeerTube status: check processing state of an uploaded recording
app.get('/api/recordings/:id/peertube-status', authMiddleware, async (req, res) => {
  if (!validateSessionId(req.params.id)) return res.status(400).json({ error: 'Invalid session ID' });
  const metadataPath = path.join(CONFIG.recordingDir, 'metadata', `${req.params.id}.json`);
  try {
    const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
    if (!metadata.peertubeVideoUuid) {
      return res.json({ uploaded: false, peertubeVideoUuid: null, message: 'Not uploaded to PeerTube' });
    }
    if (!CONFIG.peertubeBaseUrl || !CONFIG.peertubeAccessToken) {
      return res.json({ uploaded: true, peertubeVideoUuid: metadata.peertubeVideoUuid, peertubeVideoId: metadata.peertubeVideoId, watchUrl: metadata.peertubeWatchUrl, privacy: metadata.peertubePrivacy, message: 'PeerTube token not configured for status check' });
    }
    process.env.PEERTUBE_BASE_URL = CONFIG.peertubeBaseUrl;
    process.env.PEERTUBE_ACCESS_TOKEN = CONFIG.peertubeAccessToken;
    try {
      const status = await peertube.checkProcessingStatus(metadata.peertubeVideoUuid);
      res.json({
        uploaded: true,
        peertubeVideoUuid: metadata.peertubeVideoUuid,
        peertubeVideoId: metadata.peertubeVideoId,
        watchUrl: metadata.peertubeWatchUrl,
        privacy: metadata.peertubePrivacy,
        ...status,
      });
    } catch (e) {
      res.json({
        uploaded: true,
        peertubeVideoUuid: metadata.peertubeVideoUuid,
        peertubeVideoId: metadata.peertubeVideoId,
        watchUrl: metadata.peertubeWatchUrl,
        privacy: metadata.peertubePrivacy,
        error: e.message,
      });
    }
  } catch {
    res.status(404).json({ error: 'Recording not found' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// Recording deletion: impact preview, archive, restore, permanent delete.
// PeerTube deletion is a separate explicit endpoint.
// ═══════════════════════════════════════════════════════════════════════════

const RECORDING_OPERATION_LOCK_ROOT = path.join(CONFIG.recordingDir, 'metadata', '.operation-locks');
const DELETION_AUDIT_FILE = path.join(CONFIG.recordingDir, 'metadata', 'deletion-audit.jsonl');

function acquireRecordingOperationLease(sessionId, owner) {
  // Upload/sync may legitimately run for hours. A durable day-long lease
  // prevents another API process from taking over mid-operation; a crashed
  // worker's lease is recoverable on the following day without manual cleanup.
  return acquireFilesystemLease(RECORDING_OPERATION_LOCK_ROOT, sessionId, owner, 24 * 60 * 60 * 1000);
}

function releaseRecordingOperationLease(sessionId, owner) {
  return releaseFilesystemLease(RECORDING_OPERATION_LOCK_ROOT, sessionId, owner);
}

async function withRecordingOperationLease(sessionId, owner, operation) {
  const lock = acquireRecordingOperationLease(sessionId, owner);
  if (!lock.acquired) {
    return { ok: false, locked: true, error: 'Recording is locked by another operation' };
  }
  try {
    return await operation();
  } finally {
    releaseRecordingOperationLease(sessionId, owner);
  }
}

function appendDeletionAudit(event) {
  fs.mkdirSync(path.dirname(DELETION_AUDIT_FILE), { recursive: true });
  const fd = fs.openSync(DELETION_AUDIT_FILE, 'a', 0o600);
  try {
    fs.writeSync(fd, `${JSON.stringify(event)}\n`);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function metadataOperationStates(metadata) {
  return {
    isSyncing: metadata.synchronizationState === 'syncing',
    isUploading: metadata.uploadState === 'uploading',
  };
}

// Impact preview: return everything the operator needs to confirm deletion.
app.get('/api/recordings/:id/deletion-impact', authMiddleware, (req, res) => {
  if (!validateSessionId(req.params.id)) return res.status(400).json({ error: 'Invalid session ID' });
  const sessionId = req.params.id;
  const metadataPath = path.join(CONFIG.recordingDir, 'metadata', `${sessionId}.json`);
  try {
    const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
    const isActive = state.recording && state.recordingSessionId === sessionId;
    const isFinalizing = state.recordingSessionId === sessionId && state.finalizationState === 'finalizing';
    const { isSyncing, isUploading } = metadataOperationStates(metadata);
    const fileExists = metadata.filePath && fs.existsSync(metadata.filePath);
    const revision = metadata.sha256 || metadata.finalizedAt || sessionId;
    const impact = {
      recording_id: sessionId,
      title: `Recording ${new Date(metadata.finalizedAt || Date.now()).toLocaleString()}`,
      date: metadata.finalizedAt || null,
      duration: metadata.duration || null,
      size_bytes: metadata.sizeBytes || null,
      active: isActive,
      finalizing: isFinalizing,
      syncing: isSyncing,
      uploading: isUploading,
      kamrui_copy_exists: fileExists,
      kamrui_copy_path: fileExists ? metadata.filePath : null,
      gmktec_copy_synced: metadata.synced || false,
      gmktec_copy_verified: metadata.syncVerified || false,
      gmktec_sync_destination: metadata.syncDestination || null,
      checksum: metadata.sha256 || null,
      peertube_uploaded: !!metadata.peertubeVideoUuid,
      peertube_video_uuid: metadata.peertubeVideoUuid || null,
      peertube_watch_url: metadata.peertubeWatchUrl || null,
      peertube_privacy: metadata.peertubePrivacy || null,
      validated: metadata.validated || false,
      revision,
      can_delete: !isActive && !isFinalizing && !isSyncing && !isUploading,
      blocks: [
        ...(isActive ? ['Recording is active'] : []),
        ...(isFinalizing ? ['Finalization in progress'] : []),
        ...(isSyncing ? ['Synchronization in progress'] : []),
        ...(isUploading ? ['PeerTube upload in progress'] : []),
      ],
    };
    res.json(impact);
  } catch {
    res.status(404).json({ error: 'Recording not found' });
  }
});

// Archive (soft delete): mark as archived, keep files, create tombstone.
app.post('/api/recordings/:id/archive', authMiddleware, requireServiceAuth, commandRateLimit, async (req, res) => {
  if (!validateSessionId(req.params.id)) return res.status(400).json({ error: 'Invalid session ID' });
  const sessionId = req.params.id;
  const lockOwner = crypto.randomUUID();
  if (!acquireRecordingOperationLease(sessionId, lockOwner).acquired) {
    return res.status(409).json({ error: 'Recording is locked by another operation' });
  }
  try {
    const metadataPath = path.join(CONFIG.recordingDir, 'metadata', `${sessionId}.json`);
    const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
    if (state.recording && state.recordingSessionId === sessionId) {
      return res.status(409).json({ error: 'Cannot archive an active recording' });
    }
    metadata.archived = true;
    metadata.archivedAt = new Date().toISOString();
    metadata.archivedBy = req.operatorId;
    atomicWriteJson(metadataPath, metadata);
    audit('recording.archive', { sessionId, operatorId: req.operatorId }, req.operatorId);
    res.json({ ok: true, archived: true, sessionId });
  } catch {
    res.status(404).json({ error: 'Recording not found' });
  } finally {
    releaseRecordingOperationLease(sessionId, lockOwner);
  }
});

// Restore from archive.
app.post('/api/recordings/:id/restore', authMiddleware, requireServiceAuth, commandRateLimit, async (req, res) => {
  if (!validateSessionId(req.params.id)) return res.status(400).json({ error: 'Invalid session ID' });
  const sessionId = req.params.id;
  const lockOwner = `restore:${crypto.randomUUID()}`;
  if (!acquireRecordingOperationLease(sessionId, lockOwner).acquired) {
    return res.status(409).json({ error: 'Recording is locked by another operation' });
  }
  try {
    const metadataPath = path.join(CONFIG.recordingDir, 'metadata', `${sessionId}.json`);
    const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
    if (!metadata.archived) {
      return res.status(409).json({ error: 'Recording is not archived' });
    }
    metadata.archived = false;
    metadata.archivedAt = null;
    metadata.archivedBy = null;
    metadata.restoredAt = new Date().toISOString();
    atomicWriteJson(metadataPath, metadata);
    audit('recording.restore', { sessionId, operatorId: req.operatorId }, req.operatorId);
    res.json({ ok: true, restored: true, sessionId });
  } catch {
    res.status(404).json({ error: 'Recording not found' });
  } finally {
    releaseRecordingOperationLease(sessionId, lockOwner);
  }
});

// Permanent delete: remove Kamrui file + GMKtec synced copy + metadata.
// Requires If-Match revision check for optimistic concurrency.
app.delete('/api/recordings/:id', authMiddleware, requireServiceAuth, commandRateLimit, async (req, res) => {
  if (!validateSessionId(req.params.id)) return res.status(400).json({ error: 'Invalid session ID' });
  const sessionId = req.params.id;
  const ifMatch = req.headers['if-match'];
  const confirmTyped = req.body?.confirm;
  const requestId = crypto.randomUUID();
  const lockOwner = requestId;

  if (!ifMatch) return res.status(428).json({ error: 'If-Match is required for permanent deletion', request_id: requestId });
  if (!acquireRecordingOperationLease(sessionId, lockOwner).acquired) {
    return res.status(409).json({ error: 'Recording is locked by another operation', request_id: requestId });
  }

  const results = { request_id: requestId, sessionId, steps: [], errors: [] };
  try {
    const metadataPath = path.join(CONFIG.recordingDir, 'metadata', `${sessionId}.json`);
    const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));

    // Revalidate state.
    const isActive = state.recording && state.recordingSessionId === sessionId;
    const isFinalizing = state.recordingSessionId === sessionId && state.finalizationState === 'finalizing';
    const { isSyncing, isUploading } = metadataOperationStates(metadata);
    if (isActive || isFinalizing || isSyncing || isUploading) {
      return res.status(409).json({
        error: 'Cannot delete: recording is active or undergoing an operation',
        blocks: [
          ...(isActive ? ['active recording'] : []),
          ...(isFinalizing ? ['finalizing'] : []),
          ...(isSyncing ? ['syncing'] : []),
          ...(isUploading ? ['uploading'] : []),
        ],
        request_id: requestId,
      });
    }

    // Revision check (If-Match).
    const revision = metadata.sha256 || metadata.finalizedAt || sessionId;
    const precondition = revisionPrecondition(ifMatch, revision);
    if (!precondition.ok) {
      return res.status(precondition.status).json({ error: `${precondition.error} (stale request)`, request_id: requestId, expected: revision, provided: ifMatch });
    }

    // Typed confirmation (must include the session ID to prevent accidental delete).
    if (confirmTyped !== sessionId) {
      return res.status(400).json({ error: 'Typed confirmation required: { "confirm": "<sessionId>" }', request_id: requestId });
    }

    const originalPeerTubeUuid = metadata.peertubeVideoUuid || null;
    metadata.deletionState = {
      status: 'locked',
      requestId,
      requestedAt: metadata.deletionState?.requestedAt || new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      owner: req.operatorId,
      local_deleted: metadata.deletionState?.local_deleted === true,
      remote_deleted: metadata.deletionState?.remote_deleted === true,
      remote_verified: metadata.deletionState?.remote_verified === true,
      errors: [],
    };
    atomicWriteJson(metadataPath, metadata);
    results.steps.push('deletion_state_locked');

    // Durable tombstone/audit intent is written before any file mutation.
    const tombstone = {
      sessionId,
      finalizedAt: metadata.finalizedAt,
      duration: metadata.duration,
      sizeBytes: metadata.sizeBytes,
      sha256: metadata.sha256,
      deletedAt: new Date().toISOString(),
      deletedBy: req.operatorId,
      requestId,
      originalPeerTubeUuid,
      syncDestination: metadata.syncDestination || null,
      status: 'requested',
    };
    const tombstonePath = path.join(CONFIG.recordingDir, 'metadata', `${sessionId}.tombstone.json`);
    atomicWriteJson(tombstonePath, tombstone);
    appendDeletionAudit({ type: 'recording.delete.requested', ...tombstone });
    audit('recording.delete.tombstone', tombstone, req.operatorId);
    results.steps.push('tombstone_created');

    // Delete Kamrui file.
    if (!metadata.deletionState.local_deleted && metadata.filePath && fs.existsSync(metadata.filePath)) {
      try {
        const resolved = path.resolve(metadata.filePath);
        const completedDir = path.join(CONFIG.recordingDir, 'completed');
        if (resolved.startsWith(completedDir + path.sep)) {
          fs.rmSync(resolved, { force: true });
          if (fs.existsSync(resolved)) throw new Error('local file still exists after deletion');
          metadata.deletionState.local_deleted = true;
          metadata.deletionState.status = 'local_deleted';
          metadata.deletionState.updatedAt = new Date().toISOString();
          atomicWriteJson(metadataPath, metadata);
          results.steps.push('local_deleted');
        } else {
          results.errors.push('kamrui_file_path_traversal_blocked');
        }
      } catch (e) {
        results.errors.push(`kamrui_file_delete_failed: ${e.message}`);
      }
    } else if (!metadata.filePath || !fs.existsSync(metadata.filePath)) {
      metadata.deletionState.local_deleted = true;
    }

    // Delete and authoritatively verify the GMKtec copy. The destination was
    // persisted by the checksum-verified sync operation.
    const remoteRequired = metadata.synced === true || metadata.syncVerified === true;
    if (remoteRequired && !metadata.deletionState.remote_verified) {
      try {
        const m = String(metadata.syncDestination || '').match(/^([^@]+)@([^:]+):(.+)$/);
        const allowedHosts = [CONFIG.gmktecLanIp, CONFIG.gmktecTailscaleIp].filter(Boolean);
        if (
          !m
          || m[1] !== CONFIG.gmktecSyncUser
          || !allowedHosts.includes(m[2])
          || path.posix.dirname(m[3]) !== CONFIG.gmktecSyncPath
          || path.posix.basename(m[3]) !== `${sessionId}.mp4`
        ) throw new Error('invalid persisted sync destination');
        const remotePath = m[3];
        const quoted = `'${remotePath.replace(/'/g, `'\\''`)}'`;
        const remote = await runCmd('ssh', [
          '-o', 'ConnectTimeout=10', '-o', 'BatchMode=yes',
          `${m[1]}@${m[2]}`,
          `rm -f -- ${quoted} && test ! -e ${quoted}`,
        ], 30_000);
        if (!remote.ok) throw new Error(remote.stderr || remote.err?.message || 'remote delete/verify failed');
        metadata.deletionState.remote_deleted = true;
        metadata.deletionState.remote_verified = true;
        metadata.deletionState.status = 'remote_verified';
        metadata.deletionState.updatedAt = new Date().toISOString();
        atomicWriteJson(metadataPath, metadata);
        results.steps.push('remote_deleted', 'remote_verified');
      } catch (e) {
        results.errors.push(`gmktec_copy_delete_failed: ${e.message}`);
      }
    } else if (!remoteRequired) {
      metadata.deletionState.remote_deleted = true;
      metadata.deletionState.remote_verified = true;
    }

    const kamruiGone = !metadata.filePath || !fs.existsSync(metadata.filePath);
    results.kamrui_copy_exists = !kamruiGone;
    if (!kamruiGone) results.errors.push('kamrui_copy_delete_verification_failed');

    if (results.errors.length > 0 || !metadata.deletionState.remote_verified) {
      metadata.deletionState.status = 'partial_failure';
      metadata.deletionState.updatedAt = new Date().toISOString();
      metadata.deletionState.errors = results.errors;
      atomicWriteJson(metadataPath, metadata);
      appendDeletionAudit({
        type: 'recording.delete.partial_failure',
        sessionId,
        requestId,
        originalPeerTubeUuid,
        errors: results.errors,
        at: new Date().toISOString(),
      });
      results.ok = false;
      results.retryable = true;
      return res.status(502).json(results);
    }

    tombstone.status = 'complete';
    tombstone.completedAt = new Date().toISOString();
    tombstone.steps = [...results.steps];
    atomicWriteJson(tombstonePath, tombstone);
    appendDeletionAudit({ type: 'recording.delete.complete', ...tombstone });
    fs.rmSync(metadataPath);
    results.steps.push('catalog_tombstoned');
    audit('recording.delete.complete', { sessionId, results, requestId, originalPeerTubeUuid }, req.operatorId);
    results.ok = true;
    res.json(results);
  } catch (error) {
    res.status(error.code === 'ENOENT' ? 404 : 500).json({ error: error.message || 'Recording deletion failed', request_id: requestId });
  } finally {
    releaseRecordingOperationLease(sessionId, lockOwner);
  }
});

// Separate PeerTube deletion: does NOT touch local files.
app.delete('/api/recordings/:id/peertube', authMiddleware, requireServiceAuth, commandRateLimit, async (req, res) => {
  if (!validateSessionId(req.params.id)) return res.status(400).json({ error: 'Invalid session ID' });
  const sessionId = req.params.id;
  const requestId = crypto.randomUUID();
  const lockOwner = `peertube-delete:${requestId}`;
  if (!acquireRecordingOperationLease(sessionId, lockOwner).acquired) {
    return res.status(409).json({ error: 'Recording is locked by another operation', request_id: requestId });
  }
  try {
    const metadataPath = path.join(CONFIG.recordingDir, 'metadata', `${sessionId}.json`);
    const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
    if (!metadata.peertubeVideoUuid) {
      return res.status(404).json({ error: 'Recording not uploaded to PeerTube', request_id: requestId });
    }
    if (req.body?.confirm !== sessionId) {
      return res.status(400).json({ error: 'Typed confirmation required: { "confirm": "<sessionId>" }', request_id: requestId });
    }
    if (!CONFIG.peertubeAccessToken) {
      return res.status(503).json({ error: 'PeerTube access token not configured', request_id: requestId });
    }
    process.env.PEERTUBE_BASE_URL = CONFIG.peertubeBaseUrl;
    process.env.PEERTUBE_ACCESS_TOKEN = CONFIG.peertubeAccessToken;
    try {
      const originalPeerTubeUuid = metadata.peertubeVideoUuid;
      const del = await peertube.deleteVideo(originalPeerTubeUuid);
      // Update local metadata only after PeerTube confirms.
      metadata.peertubeVideoId = null;
      metadata.peertubeVideoUuid = null;
      metadata.peertubeWatchUrl = null;
      metadata.peertubePrivacy = null;
      metadata.peertubeDeletedAt = new Date().toISOString();
      atomicWriteJson(metadataPath, metadata);
      appendDeletionAudit({
        type: 'recording.peertube.delete',
        sessionId,
        originalPeerTubeUuid,
        requestId,
        operatorId: req.operatorId,
        at: metadata.peertubeDeletedAt,
      });
      audit('recording.peertube.delete', { sessionId, uuid: originalPeerTubeUuid, result: del, requestId }, req.operatorId);
      res.json({ ok: true, sessionId, peertube_deleted: true, request_id: requestId });
    } catch (e) {
      // Do NOT update local metadata if PeerTube fails.
      audit('recording.peertube.delete.failed', { sessionId, error: e.message, requestId }, req.operatorId);
      res.status(502).json({ error: `PeerTube deletion failed: ${e.message}`, request_id: requestId });
    }
  } catch {
    res.status(404).json({ error: 'Recording not found', request_id: requestId });
  } finally {
    releaseRecordingOperationLease(sessionId, lockOwner);
  }
});

app.use((err, req, res, _next) => {
  console.error('Unhandled error:', err);
  addError(`Unhandled: ${err.message}`);
  res.status(500).json({ error: 'Internal server error' });
});

app.listen(CONFIG.port, '0.0.0.0', () => {
  console.log(`MBFD Camera API listening on 0.0.0.0:${CONFIG.port}`);
  console.log(`Recording directory: ${CONFIG.recordingDir}`);
  // Re-adopt any recording that was running before this process started.
  readoptRecording();
});

process.on('SIGTERM', async () => {
  console.log('Shutting down gracefully...');
  // The recording FFmpeg process is detached and will survive this restart.
  // State is persisted to disk so the next camera-api instance re-adopts it.
  // Only stop the livestream (RTMP push) — recording must continue.
  if (state.streamProcess) await stopProcess(state.streamProcess);
  if (state.recordingExitPoll) clearInterval(state.recordingExitPoll);
  // Active recording state was fsync'd at start and is not mutated during an
  // API-only shutdown. Do not replace it here if storage is degraded.
  process.exit(0);
});
