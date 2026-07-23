// Bounded screenshot polling with instrumentation for the Command Center.
// Prefer socket screenshot-ready pushes; poll only active room visible devices.

const DEFAULTS = {
  minIntervalMs: 750,
  activeIntervalMs: 4000,
  backgroundIntervalMs: 60000,
  freshSeconds: 25,
  maxBackoffMs: 60000,
};

const metrics = {
  activeTimers: 0,
  inFlight: 0,
  pollsLastMinute: 0,
  duplicateSuppressed: 0,
  socketListeners: 0,
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
  };
}

export function createScreenshotPoller(options = {}) {
  const cfg = { ...DEFAULTS, ...options };
  const requestFn = typeof cfg.requestScreenshot === 'function' ? cfg.requestScreenshot : () => {};
  const listVisibleIds = typeof cfg.listVisibleIds === 'function' ? cfg.listVisibleIds : () => [];
  const isFresh = typeof cfg.isFresh === 'function'
    ? cfg.isFresh
    : () => false;
  const isRetired = typeof cfg.isRetired === 'function' ? cfg.isRetired : () => false;

  const lastAt = new Map();
  const inFlight = new Set();
  const backoffUntil = new Map();
  const failCount = new Map();
  let activeTimer = null;
  let backgroundTimer = null;
  let kickoff = null;
  let destroyed = false;
  let paused = false;
  let onVis = null;

  function notePoll() {
    const now = Date.now();
    metrics._pollBucket.push(now);
    pruneBucket(now);
  }

  function bumpTimers() {
    metrics.activeTimers = (activeTimer ? 1 : 0) + (backgroundTimer ? 1 : 0) + (kickoff ? 1 : 0);
  }

  function canRequest(id, force) {
    if (!id || isRetired(id)) return false;
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
    inFlight.add(id);
    metrics.inFlight = inFlight.size;
    notePoll();
    try {
      const result = requestFn(id);
      Promise.resolve(result)
        .then(() => {
          failCount.set(id, 0);
          backoffUntil.delete(id);
        })
        .catch(() => {
          const n = (failCount.get(id) || 0) + 1;
          failCount.set(id, n);
          const delay = Math.min(cfg.maxBackoffMs, cfg.minIntervalMs * (2 ** Math.min(n, 6)));
          backoffUntil.set(id, Date.now() + delay);
        })
        .finally(() => {
          inFlight.delete(id);
          metrics.inFlight = inFlight.size;
        });
    } catch {
      const n = (failCount.get(id) || 0) + 1;
      failCount.set(id, n);
      inFlight.delete(id);
      metrics.inFlight = inFlight.size;
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
    inFlight.clear();
    metrics.inFlight = 0;
    destroyed = true;
    bumpTimers();
  }

  function markReady(id) {
    if (!id) return;
    inFlight.delete(id);
    failCount.set(id, 0);
    backoffUntil.delete(id);
    metrics.inFlight = inFlight.size;
  }

  return {
    start,
    stop,
    requestIds,
    markReady,
    getMetrics: getScreenshotPollMetrics,
  };
}
