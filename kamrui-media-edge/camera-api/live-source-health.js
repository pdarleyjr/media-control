'use strict';

function finiteNumber(value) {
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

module.exports = {
  createSignalDebouncer,
  normalizeZowieInput,
};
