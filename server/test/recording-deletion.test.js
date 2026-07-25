'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

// Source-pattern tests for the recording-deletion safety contract.
// These verify that the camera-control-client exports the deletion methods
// and that the live-stream routes wire up the proxy endpoints correctly.

test('camera-control-client exports deletion methods', () => {
  const client = require('../lib/camera-control-client');
  assert.equal(typeof client.getDeletionImpact, 'function');
  assert.equal(typeof client.archiveRecording, 'function');
  assert.equal(typeof client.restoreRecording, 'function');
  assert.equal(typeof client.deleteRecording, 'function');
  assert.equal(typeof client.deletePeerTubeVideo, 'function');
});

test('live-stream router defines deletion proxy routes', () => {
  // Read the source to verify route definitions exist (source-pattern check).
  const fs = require('fs');
  const path = require('path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'routes', 'live-stream.js'), 'utf8');
  assert.match(src, /router\.get\('\/recordings\/:id\/deletion-impact'/);
  assert.match(src, /router\.post\('\/recordings\/:id\/archive'/);
  assert.match(src, /router\.post\('\/recordings\/:id\/restore'/);
  assert.match(src, /router\.delete\('\/recordings\/:id'/);
  assert.match(src, /router\.delete\('\/recordings\/:id\/peertube'/);
  // If-Match revision check is passed through.
  assert.match(src, /ifMatch/);
});

test('camera-edge server defines deletion endpoints with safety gates', () => {
  const fs = require('fs');
  const path = require('path');
  const edgeSrc = fs.readFileSync(
    path.join(__dirname, '..', '..', 'kamrui-media-edge', 'camera-api', 'server.js'), 'utf8'
  );
  // Endpoints exist.
  assert.match(edgeSrc, /app\.get\('\/api\/recordings\/:id\/deletion-impact'/);
  assert.match(edgeSrc, /app\.post\('\/api\/recordings\/:id\/archive'/);
  assert.match(edgeSrc, /app\.post\('\/api\/recordings\/:id\/restore'/);
  assert.match(edgeSrc, /app\.delete\('\/api\/recordings\/:id'/);
  assert.match(edgeSrc, /app\.delete\('\/api\/recordings\/:id\/peertube'/);
  // Safety: per-recording lock.
  assert.match(edgeSrc, /acquireDeletionLock/);
  assert.match(edgeSrc, /releaseDeletionLock/);
  // Safety: tombstone before deletion.
  assert.match(edgeSrc, /tombstone/);
  // Safety: revision check via If-Match.
  assert.match(edgeSrc, /if-match|ifMatch/i);
  // Safety: typed confirmation (session ID match).
  assert.match(edgeSrc, /confirm.*sessionId|confirmTyped/);
  // Safety: active recording block.
  assert.match(edgeSrc, /isActive/);
  // Safety: path traversal check (resolved starts with completed dir).
  assert.match(edgeSrc, /completedDir/);
  // PeerTube deletion is separate (does not touch local files).
  assert.match(edgeSrc, /Do NOT update local metadata.*PeerTube fails|separate explicit/i);
});

test('peertube-upload exports deleteVideo', () => {
  const peertube = require('../../kamrui-media-edge/camera-api/peertube-upload.js');
  assert.equal(typeof peertube.deleteVideo, 'function');
});

test('camera player has archive/restore/delete controls', () => {
  const fs = require('fs');
  const path = require('path');
  const player = fs.readFileSync(
    path.join(__dirname, '..', '..', 'cameras-proxy', 'html', 'index.html'), 'utf8'
  );
  assert.match(player, /archiveRecording/);
  assert.match(player, /restoreRecording/);
  assert.match(player, /showDeleteDialog/);
  assert.match(player, /deletion-impact/);
  assert.match(player, /If-Match/);
  assert.match(player, /peertube.*separate|separate.*PeerTube/i);
});
