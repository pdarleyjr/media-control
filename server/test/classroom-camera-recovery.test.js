const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const player = fs.readFileSync(path.join(__dirname, '..', 'player', 'live-source.html'), 'utf8');

test('classroom camera player reconnects when video stalls', () => {
  assert.match(player, /lastOk/);
  assert.match(player, /Date\.now\(\)-lastOk\)>8000/);
  assert.match(player, /stallTO/);
  assert.match(player, /function scheduleReconnect\(\)/);
  assert.match(player, /recoverFrom\('networkError','playback stalled'/);
  assert.match(player, /case 'networkError': recoverFrom/);
  assert.match(player, /if\(retryTO\) return/);
});

test('classroom camera player has retry button and error display', () => {
  assert.match(player, /id="retry"/);
  assert.match(player, /addEventListener\('click',connect\)/);
  assert.match(player, /showErr/);
  assert.match(player, /clearErr/);
});

test('transient source restarts recover silently before exposing a sustained outage', () => {
  assert.match(player, /outageStartedAt/);
  assert.match(player, /outageTO=setTimeout/);
  assert.match(player, /\},15000\)/);
  assert.match(player, /reconnectAttempt/);
  assert.match(player, /Math\.min\(5000,750\*Math\.pow\(1\.6,reconnectAttempt\+\+\)\)/);
  assert.doesNotMatch(player, /FATAL ['"]?\+?type/);
});

test('LL-HLS honors MediaMTX part hold-back instead of buffering three full segments', () => {
  assert.match(player, /lowLatencyMode:true/);
  assert.match(player, /maxLiveSyncPlaybackRate:1\.1/);
  assert.doesNotMatch(player, /liveSyncDurationCount\s*:/);
});

test('live source renders clean full-stage video without a persistent title or diagnostics', () => {
  assert.doesNotMatch(player, /class="bar"/);
  assert.match(player, /\.stage \{ position:fixed; inset:0/);
  assert.match(player, /object-fit:contain/);
  assert.match(player, /id="meta" hidden/);
  assert.match(player, /window\.__mcEnableAudio/);
});

test('classroom camera player exposes only the three explicit canonical sources', () => {
  assert.match(player, /source=params\.get\('source'\)\|\|'anpviz'/);
  assert.match(player, /'podium-computer':'Podium Computer'/);
  assert.match(player, /'guest-computer':'Guest Computer'/);
  assert.match(player, /\/player\/live-source\/.*index\.m3u8/);
  assert.doesNotMatch(player, /camera=3|ANNKE|Focus 210|WyreStorm/);
});

test('live source drawer uses same-origin canonical player URLs without legacy camera controls', () => {
  const feeds = fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', 'js', 'views', 'media-control', 'camera-feeds.js'), 'utf8');
  const catalog = fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', 'js', 'views', 'media-control', 'camera-feeds-catalog.js'), 'utf8');

  assert.doesNotMatch(feeds, /mc-cf-control-open|Focus 210/);
  assert.match(catalog, /url: `\/player\/live-source\.html/);
  assert.ok(!catalog.includes('media-control.mbfdhub.com/player/live-source'));
});
