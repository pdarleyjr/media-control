'use strict';

const { spawn } = require('child_process');

function parseVolumeDetect(output) {
  const text = String(output || '');
  const meanMatch = text.match(/\bmean_volume:\s*(-?\d+(?:\.\d+)?)\s*dB/i);
  const peakMatch = text.match(/\bmax_volume:\s*(-?\d+(?:\.\d+)?)\s*dB/i);
  if (!meanMatch || !peakMatch) return null;
  const meanDb = Number(meanMatch[1]);
  const peakDb = Number(peakMatch[1]);
  if (!Number.isFinite(meanDb) || !Number.isFinite(peakDb)) return null;
  return { meanDb, peakDb };
}

function classifyAudioLevel(level, {
  silenceThresholdDb = -55,
  clippingThresholdDb = -1,
} = {}) {
  if (!level || !Number.isFinite(level.meanDb) || !Number.isFinite(level.peakDb)) {
    return {
      status: 'unavailable',
      audioDetected: false,
      silenceDetected: false,
      clipping: false,
    };
  }
  if (level.peakDb >= clippingThresholdDb) {
    return {
      status: 'clipping',
      audioDetected: true,
      silenceDetected: false,
      clipping: true,
    };
  }
  if (level.peakDb < silenceThresholdDb) {
    return {
      status: 'silent',
      audioDetected: false,
      silenceDetected: true,
      clipping: false,
    };
  }
  return {
    status: 'detected',
    audioDetected: true,
    silenceDetected: false,
    clipping: false,
  };
}

function createAudioLevelMonitor({
  sourceUrl = 'rtsp://127.0.0.1:8554/anpviz-main',
  intervalMs = 10_000,
  sampleSeconds = 1,
  timeoutMs = 5_000,
  failuresBeforeUnavailable = 3,
  silenceThresholdDb = -55,
  clippingThresholdDb = -1,
  spawnFn = spawn,
  onUpdate = () => {},
} = {}) {
  let timer = null;
  let child = null;
  let polling = false;
  let consecutiveFailures = 0;
  let current = {
    status: 'unknown',
    audioDetected: false,
    silenceDetected: false,
    clipping: false,
    meanDb: null,
    peakDb: null,
    measuredAt: null,
    probeHealthy: false,
  };

  function publish(next) {
    current = Object.freeze({ ...next });
    onUpdate(current);
    return current;
  }

  function failProbe() {
    consecutiveFailures += 1;
    if (consecutiveFailures < failuresBeforeUnavailable) {
      return publish({ ...current, probeHealthy: false });
    }
    return publish({
      ...classifyAudioLevel(null),
      meanDb: null,
      peakDb: null,
      measuredAt: current.measuredAt,
      probeHealthy: false,
    });
  }

  function poll() {
    if (polling) return Promise.resolve(current);
    polling = true;
    return new Promise((resolve) => {
      let stderr = '';
      let settled = false;
      let killTimer = null;
      const args = [
        '-nostdin', '-hide_banner', '-loglevel', 'info',
        '-rtsp_transport', 'tcp',
        '-i', sourceUrl,
        '-map', '0:a:0',
        '-t', String(sampleSeconds),
        '-af', 'volumedetect',
        '-f', 'null', '-',
      ];

      const finish = (ok) => {
        if (settled) return;
        settled = true;
        polling = false;
        child = null;
        clearTimeout(killTimer);
        const level = ok ? parseVolumeDetect(stderr) : null;
        if (!level) {
          resolve(failProbe());
          return;
        }
        consecutiveFailures = 0;
        const classification = classifyAudioLevel(level, {
          silenceThresholdDb,
          clippingThresholdDb,
        });
        resolve(publish({
          ...classification,
          meanDb: level.meanDb,
          peakDb: level.peakDb,
          measuredAt: new Date().toISOString(),
          probeHealthy: true,
        }));
      };

      try {
        child = spawnFn('ffmpeg', args, {
          stdio: ['ignore', 'ignore', 'pipe'],
          windowsHide: true,
        });
      } catch {
        finish(false);
        return;
      }
      child.stderr?.on('data', (chunk) => {
        if (stderr.length < 64 * 1024) stderr += String(chunk);
      });
      child.once('error', () => finish(false));
      child.once('close', (code) => finish(code === 0));
      killTimer = setTimeout(() => {
        try { child?.kill('SIGKILL'); } catch { /* already exited */ }
        finish(false);
      }, timeoutMs);
      killTimer.unref?.();
    });
  }

  function start() {
    if (timer) return;
    poll();
    timer = setInterval(poll, intervalMs);
    timer.unref?.();
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
    try { child?.kill('SIGKILL'); } catch { /* already exited */ }
    child = null;
  }

  return {
    poll,
    start,
    stop,
    snapshot: () => current,
  };
}

module.exports = {
  classifyAudioLevel,
  createAudioLevelMonitor,
  parseVolumeDetect,
};
