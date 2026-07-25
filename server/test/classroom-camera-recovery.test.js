const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const player = fs.readFileSync(path.join(__dirname, '..', 'player', 'classroom-camera.html'), 'utf8');

test('classroom camera player reconnects when video stalls', () => {
  assert.match(player, /lastOk/);
  assert.match(player, /Date\.now\(\)-lastOk\)>8000/);
  assert.match(player, /stallTO/);
  assert.match(player, /networkError.*setTimeout\(connect/);
});

test('classroom camera player has retry button and error display', () => {
  assert.match(player, /id="retry"/);
  assert.match(player, /addEventListener\('click',connect\)/);
  assert.match(player, /showErr/);
  assert.match(player, /clearErr/);
});

test('classroom camera player exposes the live ANNKE camera', () => {
  assert.match(player, /camera=params\.get\('camera'\)\|\|'3'/);
  assert.match(player, /\/player\/classroom-camera\/.*index\.m3u8/);
});

test('camera feed drawer exposes a same-origin Focus 210 control surface', () => {
  const feeds = fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', 'js', 'views', 'media-control', 'camera-feeds.js'), 'utf8');
  const catalog = fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', 'js', 'views', 'media-control', 'camera-feeds-catalog.js'), 'utf8');

  assert.match(feeds, /mc-cf-control-open/);
  assert.match(feeds, /openViewModal/);
  assert.match(catalog, /url: `\/player\/classroom-camera\.html/);
  assert.doesNotMatch(catalog, /media-control\.mbfdhub\.com\/player\/classroom-camera/);
});
