'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

function source(relative) {
  return fs.readFileSync(path.join(__dirname, '..', '..', relative), 'utf8');
}

test('dashboard exposes a routed PeerTube replay operator review panel', () => {
  const index = source('frontend/index.html');
  const app = source('frontend/js/app.js');
  assert.match(index, /href="#\/replays"[^>]+data-view="replays"/);
  assert.match(app, /views\/peertube-replays\.js/);
  assert.match(app, /hash === '#\/replays'/);
});

test('operator panel shows recording evidence and all required lifecycle actions', () => {
  const view = source('frontend/js/views/peertube-replays.js');
  for (const marker of [
    'recording_title', 'instructor_name', 'room_name', 'started_at', 'ended_at',
    'duration_sec', 'thumbnail_url', 'media_validation', 'processing_state',
    'playbackGrant', 'download', 'add', 'visibility', 'visibilityRequest',
    'discard', 'archive', 'retry',
  ]) assert.match(view, new RegExp(marker));
  assert.match(view, /dashboard:peertube-replays-changed|peertube-replays-changed/);
});

test('frontend API and dashboard socket use revisioned PeerTube replay events', () => {
  const api = source('frontend/js/api.js');
  const socket = source('frontend/js/socket.js');
  assert.match(api, /peertubeReplays:\s*\{/);
  assert.match(api, /playbackGrant/);
  assert.match(socket, /dashboard:peertube-replays-changed/);
  assert.match(socket, /emit\('peertube-replays-changed'/);
});

test('replay panel uses the i18n fallback architecture', () => {
  const view = source('frontend/js/views/peertube-replays.js');
  const en = source('frontend/js/i18n/en.js');
  assert.match(view, /t\('replays\.title'\)/);
  assert.match(en, /'nav\.replays'/);
  assert.match(en, /'replays\.title'/);
  assert.match(en, /'replays\.organization_request'/);
});

