'use strict';

const dns = require('dns').promises;
const http = require('http');
const https = require('https');
const net = require('net');
const { assertRemoteUrlSafe, isBlockedIp } = require('./ssrf-policy');
const {
  canonicalMime,
  detectMediaMime,
  isActiveContentMime,
} = require('./media-integrity');

function normalizedHeaders(headers) {
  if (!headers) return {};
  if (typeof headers.forEach === 'function') {
    const result = {};
    headers.forEach((value, key) => { result[String(key).toLowerCase()] = String(value); });
    return result;
  }
  return Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [
      String(key).toLowerCase(),
      Array.isArray(value) ? value.join(', ') : String(value),
    ]),
  );
}

async function resolvePinnedAddress(hostname, resolver) {
  if (net.isIP(hostname)) {
    if (isBlockedIp(hostname)) throw Object.assign(new Error('Internal URLs are not allowed'), { code: 'private_target' });
    return { address: hostname, family: net.isIP(hostname) };
  }
  let answers;
  try {
    answers = await (resolver || dns.lookup)(hostname, { all: true, verbatim: true });
  } catch {
    throw Object.assign(new Error('Could not resolve host'), { code: 'dns_failed' });
  }
  const list = Array.isArray(answers) ? answers : [answers];
  if (!list.length || list.some((entry) => isBlockedIp(entry && entry.address))) {
    throw Object.assign(new Error('Internal URLs are not allowed'), { code: 'private_target' });
  }
  return list[0];
}

async function requestPinnedPublicUrl(url, options = {}) {
  const parsed = new URL(url);
  const pinned = await resolvePinnedAddress(
    parsed.hostname.replace(/^\[|\]$/g, ''),
    options.resolver,
  );
  const transport = parsed.protocol === 'https:' ? https : http;
  const timeoutMs = Math.max(1000, Math.min(Number(options.timeoutMs) || 10000, 60000));
  const maxBodyBytes = Math.max(0, Math.min(Number(options.maxBodyBytes) || 64 * 1024, 1024 * 1024));
  return new Promise((resolve, reject) => {
    let settled = false;
    const request = transport.request(parsed, {
      method: options.method || 'HEAD',
      headers: options.headers || {},
      servername: parsed.hostname,
      lookup(_hostname, _lookupOptions, callback) {
        callback(null, pinned.address, pinned.family);
      },
    }, (response) => {
      const result = {
        statusCode: response.statusCode || 0,
        headers: normalizedHeaders(response.headers),
        body: Buffer.alloc(0),
      };
      if ((options.method || 'HEAD') === 'HEAD' || maxBodyBytes === 0) {
        response.resume();
        response.on('end', () => {
          settled = true;
          resolve(result);
        });
        return;
      }
      const chunks = [];
      let received = 0;
      const finish = () => {
        if (settled) return;
        settled = true;
        result.body = Buffer.concat(chunks, received);
        resolve(result);
      };
      response.on('data', (chunk) => {
        const remaining = maxBodyBytes - received;
        if (remaining <= 0) {
          response.destroy();
          finish();
          return;
        }
        const part = chunk.length > remaining ? chunk.subarray(0, remaining) : chunk;
        chunks.push(part);
        received += part.length;
        if (received >= maxBodyBytes) {
          response.destroy();
          finish();
        }
      });
      response.on('end', finish);
      response.on('close', finish);
      response.on('error', (error) => {
        if (!settled) reject(error);
      });
    });
    request.setTimeout(timeoutMs, () => {
      request.destroy(Object.assign(new Error('Remote request timed out'), { code: 'ETIMEDOUT' }));
    });
    request.on('error', (error) => {
      if (!settled) reject(error);
    });
    request.end();
  });
}

function failure(code, message, now) {
  return {
    ok: false,
    status: 'unhealthy',
    errorCode: code,
    error: message,
    lastValidatedAt: now,
  };
}

function totalLength(headers, statusCode) {
  const contentRange = String(headers['content-range'] || '');
  const rangeMatch = contentRange.match(/\/(\d+)\s*$/);
  if (rangeMatch) return Number(rangeMatch[1]);
  const length = Number(headers['content-length']);
  return Number.isFinite(length) && length >= 0 ? length : null;
}

function classifyRemoteSource({ contentType, detectedMime, body }) {
  const claimed = canonicalMime(contentType);
  const detected = canonicalMime(detectedMime);
  const text = Buffer.isBuffer(body)
    ? body.subarray(0, 4096).toString('utf8').trimStart()
    : '';
  if (/^#EXTM3U\b/i.test(text)
      || ['application/vnd.apple.mpegurl', 'application/x-mpegurl'].includes(claimed)) {
    return { ok: true, sourceKind: 'live_stream', detectedMime: claimed || 'application/vnd.apple.mpegurl' };
  }
  if (claimed === 'text/html' || detected === 'text/html') {
    if (claimed && claimed !== 'text/html') {
      return { ok: false, code: 'remote_mime_mismatch', error: 'Remote bytes do not match the declared media type' };
    }
    return { ok: true, sourceKind: 'web_page', detectedMime: 'text/html' };
  }
  if (isActiveContentMime(detected)) {
    return { ok: false, code: 'remote_active_content', error: 'Remote active content cannot be used as direct media' };
  }
  const claimedSupported = /^(?:video|image|audio)\//.test(claimed)
    || claimed === 'application/pdf';
  const detectedSupported = /^(?:video|image|audio)\//.test(detected)
    || detected === 'application/pdf';
  if (!detectedSupported) {
    return {
      ok: false,
      code: claimedSupported ? 'remote_mime_unverified' : 'remote_mime_unsupported',
      error: 'Remote content is not a verifiable supported media type',
    };
  }
  const bmffFamily = new Set(['video/mp4', 'video/quicktime', 'audio/mp4']);
  if (claimed && claimed !== 'application/octet-stream' && claimed !== detected
      && !(bmffFamily.has(claimed) && bmffFamily.has(detected))) {
    return { ok: false, code: 'remote_mime_mismatch', error: 'Remote bytes do not match the declared media type' };
  }
  return {
    ok: true,
    sourceKind: 'direct_external',
    detectedMime: claimed === 'audio/mp4' ? claimed : detected,
  };
}

async function validateRemoteMedia(url, options = {}) {
  const now = (options.now || (() => Math.floor(Date.now() / 1000)))();
  const safetyCheck = options.safetyCheck || assertRemoteUrlSafe;
  const request = options.request || requestPinnedPublicUrl;
  const maxRedirects = Math.max(0, Math.min(Number(options.maxRedirects) || 3, 5));
  const maxBytes = Math.max(1, Number(options.maxBytes) || 4 * 1024 * 1024 * 1024);
  const timeoutMs = Math.max(1000, Math.min(Number(options.timeoutMs) || 10000, 60000));
  let currentUrl = String(url || '');

  for (let redirects = 0; redirects <= maxRedirects; redirects += 1) {
    const safe = await safetyCheck(currentUrl);
    if (!safe || !safe.ok) {
      return failure(safe?.reason || 'remote_url_unsafe', safe?.error || 'Remote URL is not safe', now);
    }
    let response;
    try {
      response = await request(currentUrl, {
        method: 'GET',
        timeoutMs,
        maxBodyBytes: 64 * 1024,
        headers: {
          Accept: '*/*',
          Range: 'bytes=0-65535',
          'User-Agent': 'MBFD-Media-Control-Validator/1.0',
        },
      });
    } catch (error) {
      return failure(
        error.code === 'ETIMEDOUT' ? 'remote_timeout' : (error.code || 'remote_request_failed'),
        error.message || 'Remote validation failed',
        now,
      );
    }
    const statusCode = Number(response.statusCode) || 0;
    const headers = normalizedHeaders(response.headers);
    if ([301, 302, 303, 307, 308].includes(statusCode)) {
      if (!headers.location) return failure('remote_redirect_invalid', 'Remote redirect had no location', now);
      if (redirects >= maxRedirects) return failure('remote_redirect_limit', 'Remote redirect limit exceeded', now);
      try { currentUrl = new URL(headers.location, currentUrl).toString(); }
      catch { return failure('remote_redirect_invalid', 'Remote redirect URL was invalid', now); }
      continue;
    }
    if (statusCode < 200 || statusCode >= 400) {
      return failure('remote_http_status', `Remote server returned HTTP ${statusCode}`, now);
    }
    const length = totalLength(headers, statusCode);
    if (length != null && length > maxBytes) {
      return failure('remote_too_large', 'Remote content exceeds the configured size limit', now);
    }
    const contentType = String(headers['content-type'] || '').split(';', 1)[0].trim().toLowerCase() || null;
    const body = Buffer.isBuffer(response.body) ? response.body : Buffer.from(response.body || '');
    const detectedMime = detectMediaMime(body, {
      filename: (() => {
        try { return new URL(currentUrl).pathname; } catch { return ''; }
      })(),
    });
    const source = classifyRemoteSource({ contentType, detectedMime, body });
    if (!source.ok) return failure(source.code, source.error, now);
    return {
      ok: true,
      status: 'healthy',
      sourceKind: source.sourceKind,
      finalUrl: currentUrl,
      detectedMime: source.detectedMime,
      contentLength: length,
      rangeSupported: statusCode === 206 || /\bbytes\b/i.test(headers['accept-ranges'] || ''),
      corsAllowed: Boolean(headers['access-control-allow-origin']),
      etag: headers.etag || null,
      lastModified: headers['last-modified'] || null,
      lastValidatedAt: now,
      redirects,
      externallyDependent: true,
    };
  }
  return failure('remote_redirect_limit', 'Remote redirect limit exceeded', now);
}

module.exports = {
  classifyRemoteSource,
  normalizedHeaders,
  requestPinnedPublicUrl,
  resolvePinnedAddress,
  validateRemoteMedia,
};
