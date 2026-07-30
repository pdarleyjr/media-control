'use strict';

const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const root = path.join(__dirname, '..', '..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');

test('live source catalog contains exactly Anpviz and Guest Computer and no obsolete camera catalog', () => {
  const catalog = read('frontend/js/views/media-control/camera-feeds-catalog.js');

  assert.match(catalog, /id:\s*'anpviz'/);
  assert.match(catalog, /id:\s*'guest-computer'/);
  assert.match(catalog, /LIVE_NEWS_CATALOG/);
  assert.match(catalog, /\/player\/live-source\.html\?source=/);
  assert.doesNotMatch(catalog, /Focus 210|WyreStorm|ANNKE|Ozolio|youtube-nocookie|kamrui-camera-/i);
});

test('obsolete camera players and socket camera relay are absent', () => {
  const server = read('server/server.js');
  const sockets = read('server/ws/advanced-canvas.js');
  const canvas = read('frontend/js/views/media-control/advanced-canvas.js');

  assert.doesNotMatch(server, /oz-stream|oz-poster|ozolio-resolve/i);
  assert.doesNotMatch(sockets, /canvas:camera-(?:frame|error|request)/i);
  assert.match(canvas, /source:\s*'anpviz'/);
  assert.match(canvas, /\/player\/live-source\.html/);
  assert.doesNotMatch(canvas, /classroom-camera|data-canvas-camera="3"/i);
});

test('one canonical Anpviz stream pairs copied camera video with only TONOR audio', () => {
  const mediaMtx = read('kamrui-media-edge/mediamtx.yml.tpl');
  const publisher = read('appliance/p3/anpviz-tonor/Start-AnpvizTonorPublisher.ps1');
  const publisherConfig = read('appliance/p3/anpviz-tonor/config.example.json');

  assert.match(mediaMtx, /anpviz-video:/);
  assert.match(mediaMtx, /anpviz-main:\s*\r?\n\s+source: publisher/);
  assert.match(mediaMtx, /guest-computer:/);
  assert.doesNotMatch(mediaMtx, /annke-|kamrui-camera-/i);

  assert.match(publisher, /TONOR G11 USB microphone/);
  assert.match(publisher, /VID_0D8C&PID_0134/i);
  assert.match(publisher, /Resolve-TonorAudioEndpoint/);
  assert.match(publisher, /-list_devices/);
  assert.match(publisher, /-c:v/);
  assert.match(publisher, /copy/);
  assert.match(publisher, /aresample=async=/);
  assert.match(publisher, /afftdn=/);
  assert.match(publisher, /agate=/);
  assert.match(publisher, /microphoneGainDb/);
  assert.match(publisher, /first_pts=0/);
  assert.doesNotMatch(publisher, /use_wallclock_as_timestamps|'-copyts'|'-start_at_zero'/);
  assert.match(publisher, /48000/);
  assert.match(publisherConfig, /anpviz-main/);
  assert.doesNotMatch(publisher, /built-in|camera audio fallback/i);
});

test('TONOR DirectShow discovery tolerates expected FFmpeg stderr and restores strict failures', () => {
  const publisher = read('appliance/p3/anpviz-tonor/Start-AnpvizTonorPublisher.ps1');
  const resolveStart = publisher.indexOf('function Resolve-TonorAudioEndpoint');
  const resolveEnd = publisher.indexOf('function Send-Heartbeat', resolveStart);
  const resolveBlock = publisher.slice(resolveStart, resolveEnd);
  const savePolicy = resolveBlock.indexOf('$previousErrorActionPreference = $ErrorActionPreference');
  const relaxPolicy = resolveBlock.indexOf("$ErrorActionPreference = 'Continue'");
  const enumerate = resolveBlock.indexOf('-list_devices');
  const restorePolicy = resolveBlock.indexOf('$ErrorActionPreference = $previousErrorActionPreference');

  assert.ok(resolveStart >= 0 && resolveEnd > resolveStart);
  assert.match(resolveBlock, /Alternative name\\s\+"/);
  assert.ok(savePolicy >= 0);
  assert.ok(relaxPolicy > savePolicy);
  assert.ok(enumerate > relaxPolicy);
  assert.ok(restorePolicy > enumerate);
});

test('camera edge records, livestreams, previews, and proxies only the canonical Anpviz stream', () => {
  const api = read('kamrui-media-edge/camera-api/server.js');
  const proxy = read('cameras-proxy/html/index.html');
  const admin = read('kamrui-media-edge/mbfd-media-admin');
  const install = read('kamrui-media-edge/scripts/install.sh');
  const upgrade = read('kamrui-media-edge/scripts/upgrade.sh');

  assert.match(api, /anpviz-main/);
  assert.match(api, /microphone_connected/);
  assert.match(api, /synchronization_status/);
  assert.doesNotMatch(api, /annke-main|annke-preview|kamrui-camera-/i);
  assert.match(proxy, /\/hls\/anpviz-main\/index\.m3u8/);
  assert.match(proxy, /TONOR/);
  assert.doesNotMatch(proxy, /ANNKE|Focus 210|WyreStorm/i);
  assert.match(api, /createAudioLevelMonitor/);
  assert.match(install, /audio-level-health\.js/);
  assert.match(upgrade, /audio-level-health\.js/);
  assert.match(upgrade, /HOME=\/var\/cache\/mbfd-camera-api/);
  assert.match(upgrade, /npm_config_cache=\/var\/cache\/mbfd-camera-api\/npm/);
  assert.match(admin, /192\.168\.1\.101 to any port 8200/);
  assert.match(admin, /100\.123\.92\.37 to any port 8200/);
  assert.match(admin, /192\.168\.1\.116 to any port 8554/);
  assert.match(admin, /192\.168\.1\.101 to any port 8554/);
  assert.match(admin, /100\.123\.92\.37 to any port 8554/);
  assert.doesNotMatch(admin, /192\.168\.1\.0\/24 to any port (?:8200|8554|8888)/);
});

test('Guest Computer uses embedded HDMI audio and the normal draggable source contract', () => {
  const view = read('frontend/js/views/media-control/camera-feeds.js');
  const catalog = read('frontend/js/views/media-control/camera-feeds-catalog.js');

  assert.match(view, /api\.liveSources\.list/);
  assert.match(view, /attachTileHandlers/);
  assert.match(view, /source\.available/);
  assert.match(catalog, /audio_policy:\s*'embedded_hdmi'/);
  const guestBlock = catalog.slice(catalog.indexOf("id: 'guest-computer'"));
  assert.doesNotMatch(guestBlock, /tonor/i);
});
