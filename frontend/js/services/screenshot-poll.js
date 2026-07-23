// Bounded screenshot polling with instrumentation for the Command Center.
// A request stays in-flight until screenshot-ready, rejection, offline, timeout,
// or view cancellation — never simply because the socket emit returned.

const DEFAULTS = {
  minIntervalMs: 750,
  activeIntervalMs: 4000,
  backgroundIntervalMs: 8000,
  freshSeconds: 12,
  maxBackoffMs: 60000,
  requestTimeoutMs: 12000,
};

const metrics = {
  activeTimers: 0,
  inFlight: 0,
  pollsLastMinute: 0,
  duplicateSuppressed: 0,
  socketListeners: 0,
  timeouts: 0,
  _pollBucket: [],
};

function pruneBucket(now) {
  const cut = now - 60000;
  metrics._pollBucket = metrics._pollBucket.filter((t) => t >= cut);
  metrics.pollsLastMinute = metrics._pollBucket.length;
}

export function getScreenshotPollMetrics() {
  pruneBucket(Date.now());
  return {
    activeScreenshotTimers: metrics.activeTimers,
    inFlightScreenshotRequests: metrics.inFlight,
    pollsPerMinute: metrics.pollsLastMinute,
    duplicateSuppressionCount: metrics.duplicateSuppressed,
    socketListenerCount: metrics.socketListeners,
    timeouts: metrics.timeouts,
  };
}

export function createScreenshotPoller(options = {}) {
  const cfg = { ...DEFAULTS, ...options };
  const requestFn = typeof cfg.requestScreenshot === 'function' ? cfg.requestScreenshot : () => {};
  const listVisibleIds = typeof cfg.listVisibleIds === 'function' ? cfg.listVisibleIds : () => [];
  const isFresh = typeof cfg.isFresh === 'function' ? cfg.isFresh : () => false;
  const isRetired = typeof cfg.isRetired === 'function' ? cfg.isRetired : () => false;
  const isOffline = typeof cfg.isOffline === 'function' ? cfg.isOffline : () => false;

  const lastAt = new Map();
  const inFlight = new Map(); // id -> { timer, corr }
  const backoffUntil = new Map();
  const failCount = new Map();
  let activeTimer = null;
  let backgroundTimer = null;
  let kickoff = null;
  let destroyed = false;
  let paused = false;
  let onVis = null;
  let corrSeq = 0;
  let timeoutCount = 0;

  function notePoll() {
    const now = Date.now();
    metrics._pollBucket.push(now);
    pruneBucket(now);
  }

  function bumpTimers() {
    metrics.activeTimers = (activeTimer ? 1 : 0) + (backgroundTimer ? 1 : 0) + (kickoff ? 1 : 0);
  }

  function syncInFlightMetric() {
    metrics.inFlight = inFlight.size;
  }

  function clearInFlight(id, correlationId = null) {
    const entry = inFlight.get(id);
    if (!entry) return false;
    if (correlationId && entry.corr !== correlationId) return false;
    if (entry.timer) clearTimeout(entry.timer);
    inFlight.delete(id);
    syncInFlightMetric();
    return true;
  }

  function applyBackoff(id) {
    const n = (failCount.get(id) || 0) + 1;
    failCount.set(id, n);
    const delay = Math.min(cfg.maxBackoffMs, cfg.minIntervalMs * (2 ** Math.min(n, 6)));
    backoffUntil.set(id, Date.now() + delay);
  }

  function canRequest(id, force) {
    if (!id || isRetired(id)) return false;
    if (isOffline(id) && !force) {
      metrics.duplicateSuppressed += 1;
      return false;
    }
    if (inFlight.has(id)) {
      metrics.duplicateSuppressed += 1;
      return false;
    }
    const now = Date.now();
    const until = backoffUntil.get(id) || 0;
    if (!force && now < until) {
      metrics.duplicateSuppressed += 1;
      return false;
    }
    const last = lastAt.get(id) || 0;
    if (!force && now - last < cfg.minIntervalMs) {
      metrics.duplicateSuppressed += 1;
      return false;
    }
    if (!force && isFresh(id, cfg.freshSeconds)) {
      metrics.duplicateSuppressed += 1;
      return false;
    }
    return true;
  }

  function isDocHidden() {
    try { return typeof document !== 'undefined' && !!document.hidden; } catch { return false; }
  }

  function requestOne(id, force = false) {
    if (destroyed || paused || isDocHidden()) return;
    if (!canRequest(id, force)) return;
    lastAt.set(id, Date.now());
    const corr = `ss-${Date.now().toString(36)}-${(++corrSeq).toString(36)}`;
    const timer = setTimeout(() => {
      if (!inFlight.has(id)) return;
      metrics.timeouts += 1;
      timeoutCount += 1;
      clearInFlight(id);
      applyBackoff(id);
    }, cfg.requestTimeoutMs);
    inFlight.set(id, { timer, corr });
    syncInFlightMetric();
    notePoll();
    try {
      const result = requestFn(id, { correlationId: corr });
      // Socket.IO emits are fire-and-forget: successful Promise resolution does
      // not mean a screenshot arrived. A rejection is an explicit request
      // failure, however, so release it into bounded backoff immediately.
      Promise.resolve(result).catch(() => {
        if (!clearInFlight(id, corr)) return;
        applyBackoff(id);
      });
    } catch {
      clearInFlight(id);
      applyBackoff(id);
    }
  }

  function requestIds(ids, force = false) {
    const unique = [...new Set((ids || []).filter(Boolean))];
    for (const id of unique) requestOne(id, force);
  }

  function tickActive() {
    if (destroyed || paused || isDocHidden()) return;
    requestIds(listVisibleIds({ activeOnly: true }), false);
  }

  function tickBackground() {
    if (destroyed || paused || isDocHidden()) return;
    requestIds(listVisibleIds({ activeOnly: false }), false);
  }

  function start() {
    stop();
    destroyed = false;
    paused = false;
    kickoff = setTimeout(() => {
      kickoff = null;
      tickActive();
      tickBackground();
      bumpTimers();
    }, 350);
    activeTimer = setInterval(tickActive, cfg.activeIntervalMs);
    backgroundTimer = setInterval(tickBackground, cfg.backgroundIntervalMs);
    onVis = () => {
      if (isDocHidden()) {
        paused = true;
      } else {
        paused = false;
        tickActive();
        tickBackground();
      }
    };
    try {
      if (typeof document !== 'undefined') {
        document.addEventListener('visibilitychange', onVis);
        metrics.socketListeners += 1;
      }
    } catch { /* node */ }
    bumpTimers();
  }

  function stop() {
    if (kickoff) { clearTimeout(kickoff); kickoff = null; }
    if (activeTimer) { clearInterval(activeTimer); activeTimer = null; }
    if (backgroundTimer) { clearInterval(backgroundTimer); backgroundTimer = null; }
    if (onVis) {
      try {
        if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVis);
      } catch { /* node */ }
      onVis = null;
      metrics.socketListeners = Math.max(0, metrics.socketListeners - 1);
    }
    for (const id of [...inFlight.keys()]) clearInFlight(id);
    destroyed = true;
    bumpTimers();
  }

  function markReady(id, correlationId = null) {
    if (!id) return;
    if (!clearInFlight(id, correlationId)) return;
    failCount.set(id, 0);
    backoffUntil.delete(id);
  }

  function markOffline(id) {
    if (!id) return;
    clearInFlight(id);
    applyBackoff(id);
  }

  function markFailed(id, correlationId = null) {
    if (!id || !clearInFlight(id, correlationId)) return;
    applyBackoff(id);
  }

  function getState() {
    return {
      inFlightIds: [...inFlight.keys()],
      correlations: Object.fromEntries(
        [...inFlight.entries()].map(([id, entry]) => [id, entry.corr]),
      ),
      backoffUntil: Object.fromEntries(backoffUntil),
      activeTimerCount: (activeTimer ? 1 : 0) + (backgroundTimer ? 1 : 0) + (kickoff ? 1 : 0),
      timeouts: timeoutCount,
      destroyed,
      paused,
    };
  }

  return {
    start,
    stop,
    requestIds,
    markReady,
    markOffline,
    markFailed,
    getState,
    getMetrics: getScreenshotPollMetrics,
  };
}
