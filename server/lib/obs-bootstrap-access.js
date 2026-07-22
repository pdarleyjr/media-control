'use strict';

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);

function normalizeHostname(value) {
  const input = String(value || '').trim().toLowerCase();
  if (!input || /[\s,\\/]/.test(input)) return '';
  const ipv6 = input.match(/^\[([^\]]+)\](?::\d+)?$/);
  if (ipv6) return ipv6[1];
  return input.replace(/:\d+$/, '');
}

function normalizeRemoteAddress(value) {
  const input = String(value || '').trim().toLowerCase();
  if (input.startsWith('::ffff:')) return input.slice(7);
  return input;
}

function values(input) {
  if (Array.isArray(input)) return input;
  return String(input || '').split(',');
}

function normalizedSet(input, normalizer) {
  return new Set(values(input).map(normalizer).filter(Boolean));
}

function isAllowedObsBootstrapRequest(req, options = {}) {
  const headers = req?.headers || {};
  // The public Cloudflare player bypass exists for signage. This OBS-only
  // bootstrap must never inherit that exposure, even if a proxy rewrites Host.
  if (headers['cf-connecting-ip'] || headers['cf-ray']) return false;

  const host = normalizeHostname(headers.host);
  const remoteAddress = normalizeRemoteAddress(req?.socket?.remoteAddress || req?.connection?.remoteAddress);
  const allowedHosts = normalizedSet(options.allowedHosts, normalizeHostname);
  const allowedRemoteAddresses = normalizedSet(options.allowedRemoteAddresses, normalizeRemoteAddress);
  const hostAllowed = LOOPBACK_HOSTS.has(host) || allowedHosts.has(host);
  const remoteAllowed = LOOPBACK_HOSTS.has(remoteAddress) || allowedRemoteAddresses.has(remoteAddress);
  return hostAllowed && remoteAllowed;
}

module.exports = {
  isAllowedObsBootstrapRequest,
  normalizeHostname,
  normalizeRemoteAddress,
};
