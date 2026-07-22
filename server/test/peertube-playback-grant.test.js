'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { issuePlaybackGrant, verifyPlaybackGrant } = require('../lib/peertube-playback-grant');

test('playback grant is replay/workspace/user scoped and expires', () => {
  const token = issuePlaybackGrant({ replayId: 'r1', workspaceId: 'ws1', userId: 'u1', now: 1000, ttlSec: 60 });
  const claims = verifyPlaybackGrant(token, { replayId: 'r1', now: 1059 });
  assert.equal(claims.workspace_id, 'ws1');
  assert.equal(claims.user_id, 'u1');
  assert.throws(() => verifyPlaybackGrant(token, { replayId: 'r2', now: 1059 }), /invalid/i);
  assert.throws(() => verifyPlaybackGrant(token, { replayId: 'r1', now: 1061 }), /expired/i);
});

test('tampered playback grants fail closed', () => {
  const token = issuePlaybackGrant({ replayId: 'r1', workspaceId: 'ws1', userId: 'u1', now: 1000 });
  const tampered = `${token.slice(0, -1)}${token.endsWith('a') ? 'b' : 'a'}`;
  assert.throws(() => verifyPlaybackGrant(tampered, { replayId: 'r1', now: 1001 }), /invalid/i);
});

