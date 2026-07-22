'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  toUnixSeconds,
  nowUnixSeconds,
  heartbeatAgeSeconds,
  isHeartbeatFresh,
} = require('../lib/heartbeat-age');

test('toUnixSeconds keeps epoch seconds unchanged', () => {
  assert.equal(toUnixSeconds(1_700_000_000), 1_700_000_000);
  assert.equal(toUnixSeconds('1700000000'), 1_700_000_000);
});

test('toUnixSeconds converts millisecond timestamps', () => {
  assert.equal(toUnixSeconds(1_700_000_000_000), 1_700_000_000);
  assert.equal(toUnixSeconds(1_700_000_000_500), 1_700_000_000);
});

test('toUnixSeconds rejects empty/invalid', () => {
  assert.equal(toUnixSeconds(null), null);
  assert.equal(toUnixSeconds(''), null);
  assert.equal(toUnixSeconds(0), null);
  assert.equal(toUnixSeconds(-5), null);
  assert.equal(toUnixSeconds('nope'), null);
});

test('heartbeatAgeSeconds uses unix-seconds storage contract', () => {
  const hb = 1_700_000_000; // seconds
  const nowMs = hb * 1000 + 15_000; // Date.now()-style ms 15s later
  assert.equal(heartbeatAgeSeconds(hb, nowMs), 15);
  // Passing both as seconds also works
  assert.equal(heartbeatAgeSeconds(hb, hb + 9), 9);
});

test('heartbeatAgeSeconds does not invent multi-decade ages from ms misuse', () => {
  // Regression: new Date(last_heartbeat) treated seconds as ms from 1970.
  const hbSec = Math.floor(Date.now() / 1000) - 12;
  const age = heartbeatAgeSeconds(hbSec, Date.now());
  assert.ok(age >= 11 && age <= 14, `expected ~12s age, got ${age}`);
  assert.ok(age < 3600, 'age must not explode into hours/days');
});

test('isHeartbeatFresh window (60s default)', () => {
  const nowSec = 2_000_000_000;
  assert.equal(isHeartbeatFresh(nowSec - 10, nowSec * 1000), true);
  assert.equal(isHeartbeatFresh(nowSec - 90, nowSec * 1000), false);
  assert.equal(isHeartbeatFresh(null, nowSec * 1000), false);
});

test('nowUnixSeconds derives seconds from Date.now()', () => {
  const before = Math.floor(Date.now() / 1000);
  const n = nowUnixSeconds();
  const after = Math.floor(Date.now() / 1000);
  assert.ok(n >= before && n <= after);
});
