'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const test = require('node:test');
const {
  brokerRequestTimeoutMs,
} = require('../../kamrui-media-edge/camera-api/recording-supervisor');

const repoRoot = path.join(__dirname, '..', '..');
const runnerPath = path.join(
  repoRoot,
  'kamrui-media-edge',
  'scripts',
  'mbfd-camera-recording-run',
);
const unitPath = path.join(
  repoRoot,
  'kamrui-media-edge',
  'systemd',
  'mbfd-camera-recording@.service',
);

function commandAvailable(command) {
  const result = spawnSync(command, ['-version'], {
    encoding: 'utf8',
    windowsHide: true,
  });
  return !result.error && result.status === 0;
}

function totalBytes(directory) {
  return fs.readdirSync(directory)
    .filter((name) => name.endsWith('.mp4'))
    .reduce((sum, name) => sum + fs.statSync(path.join(directory, name)).size, 0);
}

async function waitFor(predicate, timeoutMs, message) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(message);
}

function waitForExit(child, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`FFmpeg did not finalize within ${timeoutMs}ms`));
    }, timeoutMs);
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });
}

function sha256(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

test('recording unit gives FFmpeg a bounded graceful SIGINT finalization contract', () => {
  const runner = fs.readFileSync(runnerPath, 'utf8');
  const unit = fs.readFileSync(unitPath, 'utf8');

  assert.doesNotMatch(runner, /^exec \/usr\/bin\/ffmpeg/m);
  assert.match(runner, /\/usr\/bin\/ffmpeg[\s\S]*&[\s\S]*ffmpeg_pid=\$!/);
  assert.match(runner, /trap request_stop INT TERM/);
  assert.match(runner, /kill -INT "\$ffmpeg_pid"/);
  assert.match(runner, /MBFD_RECORDING_FINALIZE_TIMEOUT_SECONDS/);
  assert.match(runner, /\/usr\/bin\/ffprobe/);
  assert.match(runner, /if \(\( stop_requested == 0 \)\); then\s+exit "\$child_status"/);
  assert.match(runner, /recording finalization deadline exceeded[\s\S]*exit 124/);
  assert.match(runner, /if ! validate_final_segment; then[\s\S]*exit 65/);
  assert.match(unit, /^KillMode=mixed$/m);
  assert.match(unit, /^KillSignal=SIGINT$/m);
  assert.match(unit, /^TimeoutStopSec=45$/m);
  assert.match(unit, /^TimeoutStopFailureMode=kill$/m);
  assert.match(unit, /^FinalKillSignal=SIGKILL$/m);
  assert.match(unit, /^SendSIGKILL=yes$/m);
  assert.match(unit, /^Environment=MBFD_RECORDING_FINALIZE_TIMEOUT_SECONDS=40$/m);
  assert.doesNotMatch(unit, /^SuccessExitStatus=.*255/m);
});

test('broker stop deadline exceeds the complete systemd finalization ceiling', () => {
  assert.equal(brokerRequestTimeoutMs('status'), 10_000);
  assert.equal(brokerRequestTimeoutMs('start'), 10_000);
  assert.equal(brokerRequestTimeoutMs('stop'), 60_000);
});

test('non-camera H.264/AAC fixture grows, stops gracefully, probes, and checksums', {
  skip: !commandAvailable('ffmpeg') || !commandAvailable('ffprobe')
    ? 'ffmpeg and ffprobe are required for the recording lifecycle fixture'
    : false,
  timeout: 30_000,
}, async (t) => {
  const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mbfd-recording-finalize-'));
  t.after(() => fs.rmSync(fixtureDir, { recursive: true, force: true }));
  const outputPattern = path.join(fixtureDir, 'recording_001_%03d.mp4');
  const args = [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-re', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=15',
    '-re', '-f', 'lavfi', '-i', 'sine=frequency=1000:sample_rate=48000',
    ...(process.platform === 'win32' ? ['-t', '4'] : []),
    '-map', '0:v:0', '-map', '1:a:0',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'zerolatency', '-g', '15',
    '-c:a', 'aac', '-ar', '48000', '-ac', '1', '-b:a', '96k',
    '-f', 'segment', '-segment_time', '1', '-segment_format', 'mp4',
    '-reset_timestamps', '1', '-movflags', '+frag_keyframe+empty_moov+default_base_moof',
    outputPattern,
  ];
  const child = spawn('ffmpeg', args, {
    detached: false,
    stdio: ['ignore', 'ignore', 'pipe'],
    windowsHide: true,
  });
  const exitPromise = waitForExit(child, 15_000);
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
  t.after(() => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    if (process.platform === 'win32') {
      spawnSync('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true });
    } else {
      child.kill('SIGKILL');
    }
  });

  const initialBytes = await waitFor(
    () => totalBytes(fixtureDir) >= 4_096 && totalBytes(fixtureDir),
    12_000,
    `recording fixture never started: ${stderr}`,
  );
  const grownBytes = await waitFor(
    () => totalBytes(fixtureDir) > initialBytes && totalBytes(fixtureDir),
    8_000,
    `recording fixture did not grow beyond ${initialBytes} bytes: ${stderr}`,
  );
  assert.ok(grownBytes > initialBytes);

  const stopStartedAt = Date.now();
  if (process.platform !== 'win32') {
    child.kill('SIGINT');
  }
  const exit = await exitPromise;
  const finalizationMs = Date.now() - stopStartedAt;
  assert.ok(finalizationMs < 10_000, `finalization took ${finalizationMs}ms`);
  if (process.platform === 'win32') assert.equal(exit.code, 0, stderr);
  else assert.equal(exit.code, 255, stderr);

  const segments = fs.readdirSync(fixtureDir)
    .filter((name) => name.endsWith('.mp4'))
    .sort()
    .map((name) => path.join(fixtureDir, name));
  assert.ok(segments.length >= 1);
  const finalSegment = segments.at(-1);
  const probe = spawnSync('ffprobe', [
    '-v', 'error',
    '-show_entries', 'format=duration,size',
    '-show_entries', 'stream=codec_type,codec_name',
    '-of', 'json',
    finalSegment,
  ], { encoding: 'utf8', windowsHide: true });
  assert.equal(probe.status, 0, probe.stderr);
  const metadata = JSON.parse(probe.stdout);
  assert.ok(Number(metadata.format?.duration) > 0);
  assert.ok(Number(metadata.format?.size) > 0);
  assert.ok(metadata.streams.some((stream) => (
    stream.codec_type === 'video' && stream.codec_name === 'h264'
  )));
  assert.ok(metadata.streams.some((stream) => (
    stream.codec_type === 'audio' && stream.codec_name === 'aac'
  )));

  const firstChecksum = sha256(finalSegment);
  const secondChecksum = sha256(finalSegment);
  assert.match(firstChecksum, /^[a-f0-9]{64}$/);
  assert.equal(secondChecksum, firstChecksum);
  t.diagnostic(JSON.stringify({
    stopMode: process.platform === 'win32' ? 'bounded-natural-eof' : 'SIGINT',
    initialBytes,
    grownBytes,
    finalizationMs,
    segmentCount: segments.length,
    finalChecksum: firstChecksum,
  }));
});
