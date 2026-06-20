const crypto = require('crypto');

function payload(endpointId, contentId, workspaceId) {
  return `v1\n${String(endpointId)}\n${String(contentId)}\n${String(workspaceId)}`;
}

function signCanvasAsset({ endpointId, contentId, workspaceId, secret }) {
  if (!endpointId || !contentId || !workspaceId || !secret) return '';
  return crypto
    .createHmac('sha256', String(secret))
    .update(payload(endpointId, contentId, workspaceId))
    .digest('base64url');
}

function verifyCanvasAsset({ endpointId, contentId, workspaceId, secret, signature }) {
  const expected = signCanvasAsset({ endpointId, contentId, workspaceId, secret });
  const actual = String(signature || '');
  if (!expected || expected.length !== actual.length) return false;
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(actual));
}

function canvasAssetUrl({ publicBase, endpointId, contentId, workspaceId, secret }) {
  const signature = signCanvasAsset({ endpointId, contentId, workspaceId, secret });
  if (!signature) return '';
  const base = String(publicBase || '').replace(/\/+$/, '');
  return `${base}/player/canvas-asset/${encodeURIComponent(endpointId)}/${encodeURIComponent(contentId)}/${signature}`;
}

module.exports = { canvasAssetUrl, signCanvasAsset, verifyCanvasAsset };
