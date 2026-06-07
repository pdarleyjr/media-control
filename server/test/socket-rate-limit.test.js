const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createLimiter } = require('../lib/socket-rate-limit');

test('allows up to burst capacity, then drops excess at the same instant', () => {
  const lim = createLimiter({ ratePerSec: 10, burst: 5, maxDepth: 1000 });
  const now = 1_000_000;
  const id = 'socketA';
  let allowed = 0, dropped = 0;
  for (let i = 0; i < 12; i++) {
    const v = lim.tryConsume(id, now); // same timestamp -> no refill
    if (v.allowed) { allowed++; v.release(); } else { dropped++; }
  }
  assert.equal(allowed, 5, 'exactly burst events admitted');
  assert.equal(dropped, 7, 'the rest are rate_limited');
});

test('drops are reported as rate_limited when the bucket is empty', () => {
  const lim = createLimiter({ ratePerSec: 10, burst: 2, maxDepth: 1000 });
  const now = 5000;
  lim.tryConsume('s', now).release();
  lim.tryConsume('s', now).release();
  const v = lim.tryConsume('s', now);
  assert.equal(v.allowed, false);
  assert.equal(v.reason, 'rate_limited');
});

test('refills tokens over elapsed time', () => {
  const lim = createLimiter({ ratePerSec: 10, burst: 5, maxDepth: 1000 });
  const t0 = 0;
  // Drain the bucket.
  for (let i = 0; i < 5; i++) lim.tryConsume('s', t0).release();
  assert.equal(lim.tryConsume('s', t0).allowed, false);
  // 500ms later at 10/s => 5 tokens refilled (capped at burst).
  const t1 = 500;
  let allowed = 0;
  for (let i = 0; i < 6; i++) {
    const v = lim.tryConsume('s', t1);
    if (v.allowed) { allowed++; v.release(); }
  }
  assert.equal(allowed, 5, 'bucket refilled up to burst, not beyond');
});

test('queue-depth cap rejects when too many events are in flight unreleased', () => {
  const lim = createLimiter({ ratePerSec: 1000, burst: 1000, maxDepth: 3 });
  const now = 10_000;
  const held = [];
  for (let i = 0; i < 3; i++) {
    const v = lim.tryConsume('s', now);
    assert.equal(v.allowed, true);
    held.push(v); // do NOT release -> stays in flight
  }
  assert.equal(lim.depth('s', now), 3);
  const over = lim.tryConsume('s', now);
  assert.equal(over.allowed, false);
  assert.equal(over.reason, 'queue_full');
  // Release one slot -> capacity frees up.
  held[0].release();
  assert.equal(lim.depth('s', now), 2);
  assert.equal(lim.tryConsume('s', now).allowed, true);
});

test('in-flight slots auto-expire after depthTtlMs (missed-release guard)', () => {
  const lim = createLimiter({ ratePerSec: 1000, burst: 1000, maxDepth: 2, depthTtlMs: 1000 });
  const t0 = 0;
  lim.tryConsume('s', t0); // never released
  lim.tryConsume('s', t0); // never released
  assert.equal(lim.tryConsume('s', t0).allowed, false, 'depth full');
  // After TTL, the stale slots expire and capacity returns.
  const t1 = t0 + 1001;
  assert.equal(lim.depth('s', t1), 0);
  assert.equal(lim.tryConsume('s', t1).allowed, true);
});

test('limits are per-socket (independent buckets)', () => {
  const lim = createLimiter({ ratePerSec: 10, burst: 2, maxDepth: 1000 });
  const now = 0;
  lim.tryConsume('a', now).release();
  lim.tryConsume('a', now).release();
  assert.equal(lim.tryConsume('a', now).allowed, false, 'socket a drained');
  // socket b has its own full bucket.
  assert.equal(lim.tryConsume('b', now).allowed, true);
});

test('forget() clears a socket\'s bucket (disconnect cleanup)', () => {
  const lim = createLimiter({ ratePerSec: 10, burst: 1, maxDepth: 1000 });
  const now = 0;
  lim.tryConsume('s', now).release();
  assert.equal(lim.tryConsume('s', now).allowed, false);
  lim.forget('s');
  // Fresh bucket after forget.
  assert.equal(lim.tryConsume('s', now).allowed, true);
});

test('sweep() prunes idle full buckets', () => {
  const lim = createLimiter({ ratePerSec: 10, burst: 3, maxDepth: 1000 });
  const t0 = 0;
  lim.tryConsume('s', t0).release(); // uses 1 token, then released
  assert.equal(lim.size(), 1);
  // After enough time the bucket refills to full + no inflight -> pruned.
  lim.sweep(t0 + 1000);
  assert.equal(lim.size(), 0);
});
