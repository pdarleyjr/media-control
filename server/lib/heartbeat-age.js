'use strict';

// devices.last_heartbeat is stored as Unix epoch **seconds**
// (SQLite strftime('%s','now')). Callers accidentally passing Date.now() (ms)
// used to produce multi-decade "ages". Normalize once here for ops + API.

function toUnixSeconds(value) {
  if (value == null || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  // ms timestamps are ~1e12+; seconds for 2001–2286 sit under 1e10.
  if (n >= 1e12) return Math.floor(n / 1000);
  return Math.floor(n);
}

function nowUnixSeconds(now = Date.now()) {
  return toUnixSeconds(now) ?? Math.floor(Date.now() / 1000);
}

/** Age of a heartbeat in whole seconds, or null if unknown. */
function heartbeatAgeSeconds(lastHeartbeat, now = Date.now()) {
  const hb = toUnixSeconds(lastHeartbeat);
  if (hb == null) return null;
  const n = nowUnixSeconds(now);
  return Math.max(0, n - hb);
}

function isHeartbeatFresh(lastHeartbeat, now = Date.now(), windowSeconds = 60) {
  const age = heartbeatAgeSeconds(lastHeartbeat, now);
  if (age == null) return false;
  return age < windowSeconds;
}

module.exports = {
  toUnixSeconds,
  nowUnixSeconds,
  heartbeatAgeSeconds,
  isHeartbeatFresh,
};
