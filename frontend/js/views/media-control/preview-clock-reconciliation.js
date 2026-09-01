function finiteNonNegative(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function epochMilliseconds(value) {
  const parsed = finiteNonNegative(value);
  if (parsed === null || parsed === 0) return 0;
  return parsed < 10_000_000_000 ? parsed * 1000 : parsed;
}

// A dashboard preview owns its local decoder clock between authoritative state
// changes. Reapplying the same stale receiver report on every room heartbeat
// creates a seek sawtooth: play forward, jump back, repeat. The stable anchor
// makes each distinct position/pause report eligible for correction exactly once.
export function reconcilePreviewClock({
  previousAnchor = null,
  currentTime,
  reportedTime,
  paused = false,
  updatedAt = 0,
  nowMs = Date.now(),
  duration,
  projectionLimitSeconds = 5,
  seekThresholdSeconds = 1.25,
} = {}) {
  const reported = finiteNonNegative(reportedTime);
  if (reported === null) {
    return {
      anchor: previousAnchor,
      stateChanged: false,
      targetTime: null,
      shouldSeek: false,
    };
  }

  const anchor = `${reported}|${paused ? 'paused' : 'playing'}`;
  const stateChanged = anchor !== previousAnchor;
  let targetTime = reported;
  const updatedAtMs = epochMilliseconds(updatedAt);
  if (!paused && updatedAtMs > 0) {
    const elapsed = Math.max(0, (Number(nowMs) - updatedAtMs) / 1000);
    targetTime += Math.min(projectionLimitSeconds, elapsed);
  }

  const finiteDuration = finiteNonNegative(duration);
  if (finiteDuration !== null && finiteDuration > 0) {
    targetTime = Math.min(targetTime, finiteDuration);
  }

  const current = finiteNonNegative(currentTime);
  return {
    anchor,
    stateChanged,
    targetTime,
    shouldSeek: stateChanged
      && current !== null
      && Math.abs(current - targetTime) > seekThresholdSeconds,
  };
}
