'use strict';

const crypto = require('node:crypto');

const PROTOCOL = 'MBFD-CAMERA-SERVICE-HMAC-SHA256-V1';
const SAFE_ID = /^[A-Za-z0-9._:@-]{1,128}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function headerValue(headers, name) {
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(headers || {})) {
    if (key.toLowerCase() === wanted) {
      return Array.isArray(value) ? String(value[0] ?? '') : String(value ?? '');
    }
  }
  return '';
}

function encodeQueryComponent(value) {
  return encodeURIComponent(value).replace(/[!'()*]/g, character =>
    `%${character.charCodeAt(0).toString(16).toUpperCase()}`
  );
}

function decodeQueryComponent(value) {
  return decodeURIComponent(value.replace(/\+/g, ' '));
}

function compareCanonical(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function canonicalizeRequestTarget(target) {
  const raw = String(target || '');
  if (!raw.startsWith('/') || raw.startsWith('//') || raw.includes('#') || /[\r\n\0]/.test(raw)) {
    throw new Error('Invalid signed request target');
  }
  const queryIndex = raw.indexOf('?');
  const pathname = queryIndex === -1 ? raw : raw.slice(0, queryIndex);
  const query = queryIndex === -1 ? '' : raw.slice(queryIndex + 1);
  if (!query) return pathname;

  const pairs = query.split('&').map((part, index) => {
    const equals = part.indexOf('=');
    const rawName = equals === -1 ? part : part.slice(0, equals);
    const rawValue = equals === -1 ? '' : part.slice(equals + 1);
    return {
      name: encodeQueryComponent(decodeQueryComponent(rawName)),
      value: encodeQueryComponent(decodeQueryComponent(rawValue)),
      index,
    };
  });
  pairs.sort((left, right) =>
    compareCanonical(left.name, right.name)
    || compareCanonical(left.value, right.value)
    || left.index - right.index
  );
  return `${pathname}?${pairs.map(pair => `${pair.name}=${pair.value}`).join('&')}`;
}

function normalizeContentType(value) {
  const parts = String(value || '').split(';').map(part => part.trim()).filter(Boolean);
  if (parts.length === 0) return '';
  const mediaType = parts.shift().toLowerCase();
  if (!/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(mediaType)) {
    throw new Error('Invalid Content-Type');
  }
  const parameters = parts.map(parameter => {
    const equals = parameter.indexOf('=');
    if (equals <= 0) throw new Error('Invalid Content-Type parameter');
    const name = parameter.slice(0, equals).trim().toLowerCase();
    const valuePart = parameter.slice(equals + 1).trim();
    if (!/^[a-z0-9!#$&^_.+-]+$/.test(name) || !valuePart || /[\r\n\0]/.test(valuePart)) {
      throw new Error('Invalid Content-Type parameter');
    }
    return { name, value: valuePart };
  }).sort((left, right) =>
    compareCanonical(left.name, right.name) || compareCanonical(left.value, right.value)
  );
  return [mediaType, ...parameters.map(parameter => `${parameter.name}=${parameter.value}`)].join(';');
}

function normalizeMethod(method) {
  const normalized = String(method || '').trim().toUpperCase();
  if (!/^[A-Z]+$/.test(normalized)) throw new Error('Invalid HTTP method');
  return normalized;
}

function normalizeRawBody(rawBody) {
  if (rawBody == null) return Buffer.alloc(0);
  if (Buffer.isBuffer(rawBody)) return rawBody;
  if (rawBody instanceof Uint8Array) return Buffer.from(rawBody);
  throw new Error('Signed body must be raw bytes');
}

function normalizeIdentifier(value, label) {
  const normalized = String(value || '').trim();
  if (!SAFE_ID.test(normalized)) throw new Error(`Invalid ${label}`);
  return normalized;
}

function normalizeTimestamp(timestampMs) {
  const normalized = String(timestampMs);
  if (!/^\d{13}$/.test(normalized) || !Number.isSafeInteger(Number(normalized))) {
    throw new Error('Invalid service timestamp');
  }
  return normalized;
}

function canonicalRequest(input) {
  const method = normalizeMethod(input.method);
  const target = canonicalizeRequestTarget(input.target);
  const bodyHash = crypto.createHash('sha256').update(normalizeRawBody(input.rawBody)).digest('hex');
  const timestamp = normalizeTimestamp(input.timestampMs);
  const nonce = String(input.nonce || '').trim().toLowerCase();
  if (!UUID.test(nonce)) throw new Error('Invalid service nonce');
  const ifMatch = String(input.ifMatch || '').trim();
  if (/[\r\n\0]/.test(ifMatch)) throw new Error('Invalid If-Match');
  const contentType = normalizeContentType(input.contentType);
  const operatorId = normalizeIdentifier(input.operatorId, 'operator ID');
  const keyId = normalizeIdentifier(input.keyId, 'service key ID');
  const keyVersion = normalizeIdentifier(input.keyVersion, 'service key version');

  return [
    PROTOCOL,
    method,
    target,
    bodyHash,
    timestamp,
    nonce,
    ifMatch,
    contentType,
    operatorId,
    keyId,
    keyVersion,
  ].join('\n');
}

function signServiceRequest(input) {
  const key = input.key || {};
  const secret = String(key.secret || '');
  if (secret.length < 16) throw new Error('Camera service signing key is not configured');
  const normalized = {
    ...input,
    keyId: key.id,
    keyVersion: key.version,
  };
  const canonical = canonicalRequest(normalized);
  const signature = crypto.createHmac('sha256', secret).update(canonical).digest('hex');
  const ifMatch = String(input.ifMatch || '').trim();
  const contentType = normalizeContentType(input.contentType);
  const headers = {
    'X-Service-Timestamp': normalizeTimestamp(input.timestampMs),
    'X-Service-Nonce': String(input.nonce).trim().toLowerCase(),
    'X-Service-Signature': signature,
    'X-Service-Key-Id': normalizeIdentifier(key.id, 'service key ID'),
    'X-Service-Key-Version': normalizeIdentifier(key.version, 'service key version'),
    'X-Operator-Id': normalizeIdentifier(input.operatorId, 'operator ID'),
  };
  if (ifMatch) headers['If-Match'] = ifMatch;
  if (contentType) headers['Content-Type'] = contentType;
  return { headers, signature, canonicalRequest: canonical };
}

function signaturesMatch(actual, expected) {
  if (!/^[0-9a-f]{64}$/i.test(String(actual || ''))) return false;
  const actualBytes = Buffer.from(String(actual), 'hex');
  const expectedBytes = Buffer.from(String(expected), 'hex');
  return actualBytes.length === expectedBytes.length && crypto.timingSafeEqual(actualBytes, expectedBytes);
}

function unauthorized(error) {
  return { ok: false, status: 401, error };
}

function verifyServiceRequest(input) {
  try {
    const headers = input.headers || {};
    const timestamp = headerValue(headers, 'x-service-timestamp');
    const timestampMs = Number(normalizeTimestamp(timestamp));
    const nowMs = Number(input.nowMs == null ? Date.now() : input.nowMs);
    const maxSkewMs = Number(input.maxSkewMs == null ? 60_000 : input.maxSkewMs);
    if (!Number.isFinite(nowMs) || !Number.isFinite(maxSkewMs)
      || maxSkewMs < 1 || Math.abs(nowMs - timestampMs) > maxSkewMs) {
      return unauthorized('Invalid or expired service timestamp');
    }

    const nonce = headerValue(headers, 'x-service-nonce').trim().toLowerCase();
    if (!UUID.test(nonce)) return unauthorized('Invalid service nonce');
    const operatorId = normalizeIdentifier(headerValue(headers, 'x-operator-id'), 'operator ID');
    const keyId = normalizeIdentifier(headerValue(headers, 'x-service-key-id'), 'service key ID');
    const keyVersion = normalizeIdentifier(headerValue(headers, 'x-service-key-version'), 'service key version');
    const key = (input.keys || []).find(candidate =>
      candidate && String(candidate.id) === keyId && String(candidate.version) === keyVersion
    );
    if (!key || String(key.secret || '').length < 16) return unauthorized('Unknown service signing key');

    const canonical = canonicalRequest({
      method: input.method,
      target: input.target,
      rawBody: input.rawBody,
      timestampMs: timestamp,
      nonce,
      ifMatch: headerValue(headers, 'if-match'),
      contentType: headerValue(headers, 'content-type'),
      operatorId,
      keyId,
      keyVersion,
    });
    const expected = crypto.createHmac('sha256', String(key.secret)).update(canonical).digest('hex');
    if (!signaturesMatch(headerValue(headers, 'x-service-signature'), expected)) {
      return unauthorized('Invalid service signature');
    }

    if (typeof input.acceptNonce !== 'function') {
      return { ok: false, status: 503, error: 'Service replay protection unavailable' };
    }
    let accepted;
    try {
      accepted = input.acceptNonce(nonce, maxSkewMs, nowMs);
    } catch {
      return { ok: false, status: 503, error: 'Service replay protection unavailable' };
    }
    if (!accepted) {
      return { ok: false, status: 409, error: 'Replayed service nonce' };
    }
    return { ok: true, operatorId, keyId, keyVersion };
  } catch {
    return unauthorized('Invalid signed service request');
  }
}

module.exports = {
  PROTOCOL,
  canonicalizeRequestTarget,
  normalizeContentType,
  canonicalRequest,
  signServiceRequest,
  verifyServiceRequest,
};
