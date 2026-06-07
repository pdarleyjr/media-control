// socket-rate-limit.js — per-socket token-bucket rate limiter + queue-depth cap
// for display-control Socket.IO events.
//
// THREAT: the dashboard /dashboard namespace relays control events (remote
// touch/key, device-command play/load/screen-on-off, whiteboard strokes, scene
// triggers) straight to display devices. A malicious or buggy client can flood
// these and either DoS a display (decode/render storm) or saturate the server's
// event loop. Auth + workspace gates stop the WRONG user acting, but not the
// RIGHT user (or a hijacked socket) hammering control events.
//
// Two independent limits, both keyed per socket:
//   1. Token bucket  — smooths sustained rate to `ratePerSec` with a `burst`
//                      capacity for natural bursts (e.g. a fast stroke flurry).
//   2. Queue depth   — caps concurrent in-flight control events charged to the
//                      socket. Each accepted event increments depth; the caller
//                      releases it when the work completes (or it auto-expires
//                      after `depthTtlMs` so a missed release can't wedge a
//                      socket permanently).
//
// Pure/stateless API where possible: state lives in one Map keyed by a caller-
// supplied id (socket.id), pruned on disconnect and lazily on access. No timers
// in the hot path; an optional sweep prunes idle buckets.

const DEFAULTS = {
  ratePerSec: 20,   // sustained control events/sec per socket
  burst: 40,        // bucket capacity (allows short bursts above the sustained rate)
  maxDepth: 50,     // max concurrent in-flight control events charged to a socket
  depthTtlMs: 10000,// auto-release a charged slot after this long (missed-release guard)
};

function createLimiter(opts = {}) {
  const cfg = { ...DEFAULTS, ...opts };
  if (cfg.burst < 1) cfg.burst = 1;
  if (cfg.ratePerSec <= 0) cfg.ratePerSec = 1;
  const buckets = new Map(); // id -> { tokens, last, depth, inflight: [expiresAt...] }

  function getBucket(id, now) {
    let b = buckets.get(id);
    if (!b) {
      b = { tokens: cfg.burst, last: now, inflight: [] };
      buckets.set(id, b);
    }
    return b;
  }

  // Refill tokens based on elapsed time; expire stale in-flight slots.
  function refresh(b, now) {
    const elapsed = (now - b.last) / 1000;
    if (elapsed > 0) {
      b.tokens = Math.min(cfg.burst, b.tokens + elapsed * cfg.ratePerSec);
      b.last = now;
    }
    if (b.inflight.length) {
      b.inflight = b.inflight.filter((exp) => exp > now);
    }
  }

  // Try to admit one control event for `id`. Returns:
  //   { allowed:true,  release }            — caller MUST call release() when done
  //   { allowed:false, reason:'rate_limited' | 'queue_full' }
  function tryConsume(id, now = Date.now()) {
    const b = getBucket(id, now);
    refresh(b, now);

    if (b.inflight.length >= cfg.maxDepth) {
      return { allowed: false, reason: 'queue_full' };
    }
    if (b.tokens < 1) {
      return { allowed: false, reason: 'rate_limited' };
    }

    b.tokens -= 1;
    const slot = now + cfg.depthTtlMs;
    b.inflight.push(slot);

    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      const i = b.inflight.indexOf(slot);
      if (i !== -1) b.inflight.splice(i, 1);
    };
    return { allowed: true, release };
  }

  // Drop all state for a socket (call on disconnect).
  function forget(id) { buckets.delete(id); }

  // Inspect current depth (testing / metrics).
  function depth(id, now = Date.now()) {
    const b = buckets.get(id);
    if (!b) return 0;
    refresh(b, now);
    return b.inflight.length;
  }

  // Prune buckets that are full (idle) and have no in-flight work. Cheap to call
  // on a slow interval to keep the Map from growing under churn.
  function sweep(now = Date.now()) {
    for (const [id, b] of buckets) {
      refresh(b, now);
      if (b.inflight.length === 0 && b.tokens >= cfg.burst) buckets.delete(id);
    }
  }

  function size() { return buckets.size; }

  return { tryConsume, forget, depth, sweep, size, config: cfg };
}

module.exports = { createLimiter, DEFAULTS };
