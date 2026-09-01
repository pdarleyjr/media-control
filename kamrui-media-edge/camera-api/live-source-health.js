'use strict';

function finiteNumber(value) {
  if ((typeof value !== 'number' && typeof value !== 'string') || String(value).trim() === '') return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function normalizeZowieInput(value) {
  const data = value && typeof value === 'object' ? value : {};
  const width = finiteNumber(data.width ?? data.gsv2001?.width);
  const height = finiteNumber(data.height ?? data.gsv2001?.height);
  const frameRate = finiteNumber(data.framerate ?? data.gsv2001?.fps);
  const signalPresent = data.hdmi_signal === 1 && data.gsv2001?.input_exist === 1;
  return {
    signalPresent,
    audioDetected: signalPresent && data.audio_signal === 1,
    width,
    height,
    frameRate,
    resolution: width && height ? `${width}x${height}` : null,
  };
}

function createSignalDebouncer({ signalOnMs = 2_000, signalOffMs = 5_000 } = {}) {
  if (!Number.isFinite(signalOnMs) || signalOnMs < 0) throw new Error('signalOnMs must be nonnegative');
  if (!Number.isFinite(signalOffMs) || signalOffMs < 0) throw new Error('signalOffMs must be nonnegative');

  let available = false;
  let observed = false;
  let pendingSince = null;
  let lastUpdatedAt = null;
  let lastChangedAt = null;
  let transitionCount = 0;

  function snapshot() {
    return {
      available,
      observed,
      pendingSince,
      lastUpdatedAt,
      lastChangedAt,
      transitionCount,
    };
  }

  function update(nextObserved, now = Date.now()) {
    const next = nextObserved === true;
    if (next !== observed) {
      observed = next;
      pendingSince = now;
    } else if (pendingSince === null && next !== available) {
      pendingSince = now;
    }
    lastUpdatedAt = now;

    if (next !== available) {
      const threshold = next ? signalOnMs : signalOffMs;
      if (pendingSince !== null && now - pendingSince >= threshold) {
        available = next;
        pendingSince = null;
        lastChangedAt = now;
        transitionCount += 1;
      }
    } else {
      pendingSince = null;
    }
    return snapshot();
  }

  return { update, snapshot };
}

function hasH264Video(pathInfo) {
  return pathInfo?.ready === true
    && Array.isArray(pathInfo.tracks)
    && pathInfo.tracks.some((track) => /H264/i.test(String(track)));
}

function hasEmbeddedAudio(pathInfo) {
  return Array.isArray(pathInfo?.tracks)
    && pathInfo.tracks.some((track) => /MPEG-4 Audio|AAC/i.test(String(track)));
}

// The Podium Computer can be declared available only when its physical HDMI
// signal has survived debounce and its independently-observed H.264/AAC path
// is ready. Audio is reported only when both physical and stream observations
// agree; it is not invented from an HDMI lock alone.
function buildPodiumSourceHealth(physical, pathInfo) {
  const source = physical && typeof physical === 'object' ? physical : {};
  const input = source.input && typeof source.input === 'object' ? source.input : {};
  const streamReady = hasH264Video(pathInfo);
  const embeddedAudioDetected = streamReady && hasEmbeddedAudio(pathInfo);
  return {
    deviceOnline: source.deviceOnline === true ? true : source.deviceOnline === false ? false : null,
    signalPresent: input.signalPresent === true,
    streamReady,
    available: source.available === true && streamReady && embeddedAudioDetected,
    resolution: input.resolution || null,
    frameRate: finiteNumber(input.frameRate),
    embeddedAudioDetected: input.audioDetected === true && embeddedAudioDetected,
    lastUpdate: source.lastUpdate || null,
    model: source.model || null,
    firmware: source.firmware || null,
  };
}

// Guest laptop reachability is not observable from this appliance. Only a
// ready H.264 path is a publisher/signal fact; only H.264 plus AAC is healthy
// enough to become an available/routable source.
function buildGuestPublisherHealth(pathInfo) {
  const streamReady = hasH264Video(pathInfo);
  const embeddedAudioDetected = streamReady && hasEmbeddedAudio(pathInfo);
  return {
    deviceOnline: null,
    deviceObservable: false,
    publisherOnline: streamReady,
    signalPresent: streamReady,
    streamReady,
    available: streamReady && embeddedAudioDetected,
    resolution: null,
    frameRate: null,
    embeddedAudioDetected,
    lastUpdate: streamReady ? pathInfo.readyTime || null : null,
  };
}

module.exports = {
  buildGuestPublisherHealth,
  buildPodiumSourceHealth,
  createSignalDebouncer,
  normalizeZowieInput,
};
