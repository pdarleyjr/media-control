const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const player = fs.readFileSync(path.join(__dirname, '..', 'player', 'live-source.html'), 'utf8');

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

test('classroom camera player exposes only the canonical Anpviz source', () => {
  assert.match(player, /source=params\.get\('source'\)\|\|'anpviz'/);
  assert.match(player, /\/player\/live-source\/.*index\.m3u8/);
  assert.doesNotMatch(player, /camera=3|ANNKE|Focus 210|WyreStorm/);
});

test('live source drawer uses same-origin canonical player URLs without legacy camera controls', () => {
  const feeds = fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', 'js', 'views', 'media-control', 'camera-feeds.js'), 'utf8');
  const catalog = fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', 'js', 'views', 'media-control', 'camera-feeds-catalog.js'), 'utf8');

  assert.doesNotMatch(feeds, /mc-cf-control-open|Focus 210/);
  assert.match(catalog, /url: `\/player\/live-source\.html/);
  assert.doesNotMatch(catalog, /media-control\.mbfdhub\.com\/player\/live-source/);
});
