const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const player = fs.readFileSync(path.join(__dirname, '..', 'player', 'classroom-camera.html'), 'utf8');

test('classroom camera player reconnects when video timestamps stop advancing', () => {
  assert.match(player, /lastProgressAt/);
  assert.match(player, /Date\.now\(\) - lastProgressAt > 10000/);
  assert.match(player, /freshSource = source \+ '\?fresh='/);
  assert.match(player, /liveMaxLatencyDurationCount: 3/);
});

test('Focus 210 top-level player exposes real digital PTZ controls and presets', () => {
  assert.match(player, /data-eptz="zoom-in"/);
  assert.match(player, /data-eptz="wall-1"/);
  assert.match(player, /data-eptz="wall-2"/);
  assert.match(player, /window\.top === window\.self/);
  assert.match(player, /video\.style\.transform/);
  assert.match(player, /params\.get\('preset'\)/);
  assert.match(player, /history\.replaceState/);
  assert.match(player, /preset-change/);
});

test('classroom camera player exposes the live ANNKE wall overview', () => {
  assert.match(player, /cameraParam === '3'/);
  assert.match(player, /camera === '1'/);
});

test('camera feed drawer exposes a same-origin Focus 210 control surface', () => {
  const feeds = fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', 'js', 'views', 'media-control', 'camera-feeds.js'), 'utf8');
  const catalog = fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', 'js', 'views', 'media-control', 'camera-feeds-catalog.js'), 'utf8');

  assert.match(feeds, /mc-cf-control-open/);
  assert.match(feeds, /openViewModal/);
  assert.match(feeds, /camera=1&controls=1&preset=wide/);
  assert.match(catalog, /url: `\/player\/classroom-camera\.html/);
  assert.doesNotMatch(catalog, /media-control\.mbfdhub\.com\/player\/classroom-camera/);
  assert.match(catalog, /ANNKE · Video Wall 1/);
  assert.match(catalog, /Focus 210 · Video Wall 2/);
});
