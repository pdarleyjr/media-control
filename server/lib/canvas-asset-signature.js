const crypto = require('crypto');

function payload(endpointId, contentId, workspaceId, width, height) {
  return `v1\n${String(endpointId)}\n${String(contentId)}\n${String(workspaceId)}\n${Number(width) || 0}x${Number(height) || 0}`;
}

function signCanvasAsset({ endpointId, contentId, workspaceId, width, height, secret }) {
  if (!endpointId || !contentId || !workspaceId || !secret) return '';
  return crypto
    .createHmac('sha256', String(secret))
    .update(payload(endpointId, contentId, workspaceId, width, height))
    .digest('base64url');
}

function verifyCanvasAsset({ endpointId, contentId, workspaceId, width, height, secret, signature }) {
  const expected = signCanvasAsset({ endpointId, contentId, workspaceId, width, height, secret });
  const actual = String(signature || '');
  if (!expected || expected.length !== actual.length) return false;
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(actual));
}

function canvasAssetUrl({ publicBase, endpointId, contentId, workspaceId, width, height, secret }) {
  const safeWidth = Math.max(1, Math.min(7680, Math.round(Number(width) || 1920)));
  const safeHeight = Math.max(1, Math.min(4320, Math.round(Number(height) || 1080)));
  const signature = signCanvasAsset({
    endpointId,
    contentId,
    workspaceId,
    width: safeWidth,
    height: safeHeight,
    secret,
  });
  if (!signature) return '';
  const base = String(publicBase || '').replace(/\/+$/, '');
  return `${base}/player/canvas-asset/${encodeURIComponent(endpointId)}/${encodeURIComponent(contentId)}/${safeWidth}/${safeHeight}/${signature}`;
}

module.exports = { canvasAssetUrl, signCanvasAsset, verifyCanvasAsset };
