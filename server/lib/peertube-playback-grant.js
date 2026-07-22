'use strict';

const crypto = require('node:crypto');
const config = require('../config');

function signature(payload) {
  return crypto.createHmac('sha256', String(config.jwtSecret)).update(payload).digest('base64url');
}

function issuePlaybackGrant({ replayId, workspaceId, userId, now = Math.floor(Date.now() / 1000), ttlSec = 300 } = {}) {
  if (!replayId || !workspaceId || !userId) throw new Error('Playback grant scope is required');
  const claims = {
    version: 1,
    replay_id: String(replayId),
    workspace_id: String(workspaceId),
    user_id: String(userId),
    expires_at: Number(now) + Math.min(Math.max(Number(ttlSec) || 300, 30), 900),
    nonce: crypto.randomBytes(12).toString('base64url'),
  };
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
  return `${payload}.${signature(payload)}`;
}

function verifyPlaybackGrant(token, { replayId, now = Math.floor(Date.now() / 1000) } = {}) {
  const [payload, suppliedSignature, extra] = String(token || '').split('.');
  if (!payload || !suppliedSignature || extra) throw new Error('Invalid playback grant');
  const expected = signature(payload);
  const suppliedBuffer = Buffer.from(suppliedSignature);
  const expectedBuffer = Buffer.from(expected);
  if (suppliedBuffer.length !== expectedBuffer.length || !crypto.timingSafeEqual(suppliedBuffer, expectedBuffer)) {
    throw new Error('Invalid playback grant');
  }
  let claims;
  try { claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')); }
  catch (_) { throw new Error('Invalid playback grant'); }
  if (claims.version !== 1 || claims.replay_id !== String(replayId || '')) throw new Error('Invalid playback grant');
  if (!claims.workspace_id || !claims.user_id || !Number.isFinite(Number(claims.expires_at))) throw new Error('Invalid playback grant');
  if (Number(claims.expires_at) < Number(now)) throw new Error('Playback grant expired');
  return claims;
}

module.exports = { issuePlaybackGrant, verifyPlaybackGrant };

