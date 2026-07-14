'use strict';

function createLoginFailureRateLimit({
  getClientIp,
  windowMs = 60_000,
  maxAccountFailures = 10,
  maxIpFailures = 60,
  now = () => Date.now(),
} = {}) {
  if (typeof getClientIp !== 'function') throw new TypeError('getClientIp is required');

  const failures = new Map();
  let sequence = 0;

  function active(key, cutoff) {
    const entries = (failures.get(key) || []).filter((entry) => entry.at > cutoff);
    if (entries.length) failures.set(key, entries);
    else failures.delete(key);
    return entries;
  }

  function remove(key, id) {
    const entries = (failures.get(key) || []).filter((entry) => entry.id !== id);
    if (entries.length) failures.set(key, entries);
    else failures.delete(key);
  }

  return (req, res, next) => {
    const timestamp = now();
    const cutoff = timestamp - windowMs;
    const ip = String(getClientIp(req) || 'unknown');
    const email = String(req.body?.email || '').trim().toLowerCase().slice(0, 320) || '<missing>';
    const accountKey = `account:${ip}:${email}`;
    const ipKey = `ip:${ip}`;
    const accountFailures = active(accountKey, cutoff);
    const ipFailures = active(ipKey, cutoff);

    if (accountFailures.length >= maxAccountFailures || ipFailures.length >= maxIpFailures) {
      return res.status(429).json({ error: 'Too many failed login attempts, try again later' });
    }

    // Reserve this attempt before dispatch so parallel brute-force requests cannot
    // all pass the pre-check. Successful responses remove their reservation.
    const entry = { id: ++sequence, at: timestamp };
    accountFailures.push(entry);
    ipFailures.push(entry);
    failures.set(accountKey, accountFailures);
    failures.set(ipKey, ipFailures);

    res.once('finish', () => {
      if (res.statusCode !== 400 && res.statusCode !== 401 && res.statusCode !== 403) {
        remove(accountKey, entry.id);
        remove(ipKey, entry.id);
      }
    });
    next();
  };
}

module.exports = { createLoginFailureRateLimit };
