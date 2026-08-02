'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.join(__dirname, '../..');

test('broadcast route dispatches a region-qualified source without collapsing typed routes to device ids', () => {
  const source = fs.readFileSync(path.join(root, 'server/routes/broadcast.js'), 'utf8');

  assert.match(source, /typedResolution\.routes/);
  assert.match(source, /regionId:\s*route\.region_id/);
  assert.match(source, /zoneId:\s*route\.zone_id/);
  assert.match(source, /region_id:\s*route\.region_id/);
});

test('scene engine replaces only the selected region assignment and preserves sibling regions', () => {
  const source = fs.readFileSync(path.join(root, 'server/services/scene-engine.js'), 'utf8');

  assert.match(source, /DELETE FROM playlist_items WHERE playlist_id = \? AND zone_id = \?/);
  assert.match(source, /INSERT INTO playlist_items \(playlist_id, content_id, zone_id, sort_order, duration_sec, fit_mode\)/);
  assert.match(source, /regionId/);
  assert.doesNotMatch(
    source,
    /if \(regionId\)[\s\S]{0,500}DELETE FROM playlist_items WHERE playlist_id = \?'\)/,
  );
});

test('playlist payload and player confirmation retain region-qualified layout and playback state', () => {
  const socketSource = fs.readFileSync(path.join(root, 'server/ws/deviceSocket.js'), 'utf8');
  const playerSource = fs.readFileSync(path.join(root, 'server/player/index.html'), 'utf8');

  assert.match(socketSource, /wallLayout\?\.regions/);
  assert.match(socketSource, /region_id:/);
  assert.match(playerSource, /region_states/);
  assert.match(playerSource, /expectedRegionId/);
  assert.match(playerSource, /pending\.expectedRegionId/);
});

test('region-qualified transport matches authoritative state by region and content instance', () => {
  const transportSource = fs.readFileSync(
    path.join(root, 'frontend/js/views/media-control/transport.js'),
    'utf8',
  );
  const confirmationSource = fs.readFileSync(
    path.join(root, 'frontend/js/views/media-control/transport-confirmation.js'),
    'utf8',
  );

  assert.match(confirmationSource, /entry\.regionId/);
  assert.match(confirmationSource, /state\.region_id/);
  assert.match(transportSource, /opts\.zoneId \? \{ zone_id: opts\.zoneId \}/);
});
