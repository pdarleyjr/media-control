'use strict';

const crypto = require('crypto');

const MAX_TTL_SECONDS = 24 * 60 * 60;

function signaturePayload(contentId, kind, expiresAt) {
  return `${String(contentId)}\n${String(kind)}\n${Number(expiresAt)}`;
}

function signContentAsset(contentId, kind, expiresAt, secret) {
  if (!secret) throw new Error('content asset signing secret is required');
  return crypto.createHmac('sha256', String(secret))
    .update(signaturePayload(contentId, kind, expiresAt))
    .digest('base64url');
}

function signedContentAssetUrl(contentId, kind, secret, options = {}) {
  if (!['file', 'thumbnail'].includes(kind)) throw new Error('invalid content asset kind');
  const now = Number.isFinite(options.now) ? Math.floor(options.now) : Math.floor(Date.now() / 1000);
  const ttl = Math.max(1, Math.min(MAX_TTL_SECONDS, Number(options.ttlSeconds) || 3600));
  const expiresAt = now + ttl;
  const signature = signContentAsset(contentId, kind, expiresAt, secret);
  return `/api/content/${encodeURIComponent(String(contentId))}/${kind}?asset_exp=${expiresAt}&asset_sig=${signature}`;
}

function verifyContentAssetSignature(contentId, kind, query, secret, now = Math.floor(Date.now() / 1000)) {
  if (!secret || !['file', 'thumbnail'].includes(kind)) return false;
  const expiresAt = Number(query?.asset_exp);
  const supplied = String(query?.asset_sig || '');
  if (!Number.isInteger(expiresAt) || !supplied || expiresAt < now || expiresAt > now + MAX_TTL_SECONDS) return false;
  const expected = signContentAsset(contentId, kind, expiresAt, secret);
  const suppliedBuffer = Buffer.from(supplied);
  const expectedBuffer = Buffer.from(expected);
  return suppliedBuffer.length === expectedBuffer.length
    && crypto.timingSafeEqual(suppliedBuffer, expectedBuffer);
}

module.exports = {
  MAX_TTL_SECONDS,
  signContentAsset,
  signedContentAssetUrl,
  verifyContentAssetSignature,
};
