'use strict';

const { URL } = require('url');

function normalizeUrl(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  try {
    const url = new URL(raw);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return '';
    url.hash = '';
    url.search = '';
    url.pathname = url.pathname.replace(/\/+$/, '');
    return url.toString().replace(/\/$/, '');
  } catch {
    return '';
  }
}

function firstNonEmpty(env, keys) {
  for (const key of keys || []) {
    const raw = env && env[key];
    if (raw == null) continue;
    const value = String(raw).trim();
    if (value) return value;
  }
  return '';
}

function resolveServerUrl(env = process.env, options = {}) {
  const urlKeys = Array.isArray(options.urlKeys) && options.urlKeys.length > 0
    ? options.urlKeys
    : ['MC_SERVER_LAN_URL', 'MC_SERVER_URL'];
  const direct = normalizeUrl(firstNonEmpty(env, urlKeys));
  if (direct) return direct;
  return normalizeUrl(options.defaultUrl || '');
}

function collectAllowedHosts(...urls) {
  const hosts = new Set();
  for (const url of urls.flat()) {
    const normalized = normalizeUrl(url);
    if (!normalized) continue;
    try {
      hosts.add(new URL(normalized).host);
    } catch {
      continue;
    }
  }
  return [...hosts];
}

module.exports = {
  collectAllowedHosts,
  normalizeUrl,
  resolveServerUrl,
};
