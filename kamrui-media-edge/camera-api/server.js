'use strict';

const express = require('express');
const crypto = require('crypto');
const { execFile, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

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
    sessionId: null,
    recordingStartedAt: null,
    streamStartedAt: null,
    recordingPath: null,
    recordingProcess: null,
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
  req.operatorId = req.headers['x-operator-id'] || 'api-client';
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

function startRecordingProcess(rtspUrl, outputPattern) {
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
  const proc = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
  proc.stderr.on('data', d => {
    const msg = d.toString().trim();
    if (msg) console.error('[recording]', msg);
  });
  return proc;
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
    proc.on('close', (code) => resolve(code));
    proc.kill('SIGINT');
    setTimeout(() => {
      if (!proc.killed) proc.kill('SIGKILL');
    }, 10000);
  });
}

async function finalizeRecording(sessionId) {
  const dir = path.join(CONFIG.recordingDir, 'active', sessionId);
  const completedDir = path.join(CONFIG.recordingDir, 'completed', sessionId);

  try {
    fs.mkdirSync(completedDir, { recursive: true });
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.mp4')).sort();

    if (files.length === 0) {
      addError(`No recording segments found for session ${sessionId}`);
      return { ok: false, error: 'No segments found' };
    }

    const finalPath = path.join(completedDir, `${sessionId}.mp4`);

    if (files.length === 1) {
      fs.renameSync(path.join(dir, files[0]), finalPath);
    } else {
      const concatList = path.join(dir, 'concat.txt');
      const concatContent = files.map(f => `file '${path.join(dir, f)}'`).join('\n');
      fs.writeFileSync(concatList, concatContent);
      await new Promise((resolve, reject) => {
        execFile('ffmpeg', [
          '-nostdin', '-hide_banner', '-loglevel', 'warning', '-y',
          '-f', 'concat', '-safe', '0', '-i', concatList,
          '-c', 'copy', finalPath
        ], (err) => err ? reject(err) : resolve());
      });
    }

    const probeResult = await new Promise((resolve) => {
      execFile('ffprobe', [
        '-v', 'error', '-show_entries', 'format=duration,size',
        '-show_entries', 'stream=codec_name,width,height,r_frame_rate',
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

    const streams = probeResult.data?.streams || [];
    const videoStream = streams.find(s => s.codec_name === 'h264');
    const audioStream = streams.find(s => s.codec_name === 'aac');

    const metadata = {
      sessionId,
      finalizedAt: new Date().toISOString(),
      filePath: finalPath,
      duration: probeResult.data?.format?.duration || null,
      sizeBytes: probeResult.data?.format?.size || null,
      sha256: fileHash,
      segments: files.length,
      validated: probeResult.ok && !!videoStream && !!audioStream,
      videoCodec: videoStream?.codec_name || null,
      audioCodec: audioStream?.codec_name || null,
      resolution: videoStream ? `${videoStream.width}x${videoStream.height}` : null,
      synced: false,
      syncedAt: null,
      uploaded: false,
      uploadedAt: null,
      peertubeVideoId: null,
      peertubeVideoUuid: null,
      peertubeWatchUrl: null,
      peertubePrivacy: null,
      published: false,
      publishedAt: null,
      error: null,
    };

    fs.writeFileSync(
      path.join(CONFIG.recordingDir, 'metadata', `${sessionId}.json`),
      JSON.stringify(metadata, null, 2)
    );

    fs.rmSync(dir, { recursive: true, force: true });

    state.lastRecording = metadata;
    return { ok: true, metadata };
  } catch (e) {
    addError(`Finalization failed: ${e.message}`);
    try {
      const failedDir = path.join(CONFIG.recordingDir, 'failed', sessionId);
      fs.mkdirSync(failedDir, { recursive: true });
      fs.cpSync(dir, failedDir, { recursive: true });
      fs.rmSync(dir, { recursive: true, force: true });
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
    fs.writeFileSync(metadataPath, JSON.stringify(metadata, null, 2));
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
  fs.writeFileSync(metadataPath, JSON.stringify(metadata, null, 2));

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
      fs.writeFileSync(metadataPath, JSON.stringify(metadata, null, 2));
    } else {
      metadata.error = result.error || 'Upload failed';
      fs.writeFileSync(metadataPath, JSON.stringify(metadata, null, 2));
    }

    return result;
  } catch (e) {
    const errorMsg = e.message || 'Upload crashed';
    addError(`PeerTube upload failed: ${errorMsg}`);
    metadata.error = errorMsg;
    fs.writeFileSync(metadataPath, JSON.stringify(metadata, null, 2));
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
      fs.writeFileSync(metadataPath, JSON.stringify(metadata, null, 2));
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
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Api-Token, Authorization, X-Operator-Id, X-Idempotency-Key');
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
    session_id: state.sessionId,
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
  if (!state.sessionId) return res.json({ active: false });
  res.json({
    active: true,
    session_id: state.sessionId,
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
    return res.status(409).json({ ok: false, error: 'Already recording', session_id: state.sessionId });
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
  const { dir, pattern, metadataPath } = getRecordingFilePath(sessionId);

  const rtspSource = `${CONFIG.mediamtxRtsp}/annke-main`;
  const proc = startRecordingProcess(rtspSource, pattern);

  state.recording = true;
  state.sessionId = sessionId;
  state.recordingStartedAt = new Date().toISOString();
  state.recordingPath = dir;
  state.recordingProcess = proc;

  proc.on('close', (code) => {
    if (state.recordingProcess === proc) {
      state.recording = false;
      state.recordingProcess = null;
      if (code !== 0 && code !== null) {
        addError(`Recording process exited with code ${code}`);
      }
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
    return res.json(state.idempotencyKeys.get(idempotencyKey));
  }

  if (!state.recording) {
    return res.status(409).json({ ok: false, error: 'Not recording' });
  }

  const sessionId = state.sessionId;
  const proc = state.recordingProcess;

  state.recording = false;
  state.recordingProcess = null;
  state.recordingStartedAt = null;
  state.recordingPath = null;

  await stopProcess(proc);

  const finalizeResult = await finalizeRecording(sessionId);

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

  res.json(response);
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
  state.streamStartedAt = new Date().toISOString();
  state.streamProcess = proc;

  proc.on('close', (code) => {
    if (state.streamProcess === proc) {
      state.livestreaming = false;
      state.streamProcess = null;
      state.streamStartedAt = null;
      if (code !== 0 && code !== null) {
        addError(`Livestream process exited with code ${code}`);
      }
    }
  });

  if (!state.sessionId) {
    state.sessionId = generateSessionId();
  }

  const entry = audit('stream.start', { sessionId: state.sessionId }, req.operatorId);

  const response = {
    ok: true,
    session_id: state.sessionId,
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
  state.streamProcess = null;
  state.streamStartedAt = null;

  await stopProcess(proc);

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
  const streamProc = state.streamProcess;

  state.recording = false;
  state.livestreaming = false;
  state.recordingProcess = null;
  state.streamProcess = null;
  state.recordingStartedAt = null;
  state.streamStartedAt = null;
  state.recordingPath = null;

  await Promise.all([stopProcess(recordingProc), stopProcess(streamProc)]);

  if (state.sessionId) {
    try { await finalizeRecording(state.sessionId); } catch {}
  }

  state.sessionId = null;

  res.json({
    ok: true,
    stopped_at: new Date().toISOString(),
    request_id: entry.requestId,
  });
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
  const result = await uploadToPeerTube(req.params.id);
  audit('recording.upload', { sessionId: req.params.id, result }, req.operatorId);
  res.json(result);
});

app.post('/api/recordings/:id/sync', authMiddleware, commandRateLimit, async (req, res) => {
  const result = await syncToGmktec(req.params.id);
  audit('recording.sync', { sessionId: req.params.id, result }, req.operatorId);
  res.json(result);
});

app.post('/api/recordings/:id/publish', authMiddleware, commandRateLimit, async (req, res) => {
  const privacy = req.body?.privacy || 3;
  if (![1, 2, 3].includes(privacy)) {
    return res.status(400).json({ error: 'Invalid privacy value. Use 1=Public, 2=Unlisted, 3=Private' });
  }
  const result = await publishRecording(req.params.id, privacy);
  audit('recording.publish', { sessionId: req.params.id, privacy, result }, req.operatorId);
  res.json(result);
});

app.use((err, req, res, _next) => {
  console.error('Unhandled error:', err);
  addError(`Unhandled: ${err.message}`);
  res.status(500).json({ error: 'Internal server error' });
});

app.listen(CONFIG.port, '0.0.0.0', () => {
  console.log(`MBFD Camera API listening on 0.0.0.0:${CONFIG.port}`);
  console.log(`Recording directory: ${CONFIG.recordingDir}`);
});

process.on('SIGTERM', async () => {
  console.log('Shutting down gracefully...');
  if (state.recordingProcess) await stopProcess(state.recordingProcess);
  if (state.streamProcess) await stopProcess(state.streamProcess);
  process.exit(0);
});
