'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const assert = require('node:assert/strict');

function read(relativePath) {
  return fs.readFileSync(path.join(__dirname, '..', relativePath), 'utf8');
}

test('active operator UI has no Prepare Live or Program Ready workflow', () => {
  const dock = read('../frontend/js/views/media-control/action-dock.js');
  assert.doesNotMatch(dock, /data-dock="prepare-live"|openPrepareLiveProductionModal|programPrepared/);
  assert.match(dock, /api\.liveStream\.start\(\{\s*initiator:\s*'operator'/);
});

test('composition API is authoritative, tenant-scoped, revisioned, and cohesive', () => {
  const api = read('../frontend/js/api.js');
  const route = read('routes/live-stream.js');
  assert.match(api, /composition:\s*\(\)\s*=>\s*request\('\/live-stream\/composition'/);
  assert.match(api, /compositionContent:\s*\(body\)/);
  assert.match(api, /compositionLayout:\s*\(body\)/);
  assert.match(api, /compositionClear:\s*\(body\)/);
  assert.match(route, /router\.get\('\/composition'/);
  assert.match(route, /router\.post\('\/composition\/content'/);
  assert.match(route, /router\.put\('\/composition\/layout'/);
  assert.match(route, /router\.delete\('\/composition\/content'/);
  assert.match(route, /workspaceId:\s*req\.workspaceId/);
  assert.doesNotMatch(route, /workspaceId:\s*req\.body/);
});

test('live content is added explicitly from the action dock, never by normal display routing', () => {
  const send = read('../frontend/js/views/media-control/send.js');
  const dock = read('../frontend/js/views/media-control/action-dock.js');
  assert.match(dock, /content_main_camera_pip/);
  assert.match(dock, /camera_main_content_pip/);
  assert.match(dock, /data-composition-add/);
  assert.match(dock, /api\.liveStream\.compositionContent/);
  assert.match(dock, /confirm_content_audio: false/);
  assert.doesNotMatch(send, /compositionContent|chooseLiveStreamComposition|routeToLiveComposition/);
  assert.match(send, /include_live_stream: false/);
});

test('persistent on-air controls use the three fixed layouts and touch-safe controls', () => {
  const dock = read('../frontend/js/views/media-control/action-dock.js');
  const css = read('../frontend/css/media-control.css');
  assert.match(dock, /data-composition-layout="camera_only"/);
  assert.match(dock, /data-composition-layout="content_main_camera_pip"/);
  assert.match(dock, /data-composition-layout="camera_main_content_pip"/);
  assert.match(dock, /data-composition-remove/);
  assert.match(css, /\.mc-composition-control[\s\S]*min-height:\s*44px/);
});

test('managed program receiver is muted by default and has an explicit server audio policy event', () => {
  const server = read('server.js');
  const player = read('player/index.html');
  const routeStart = server.indexOf("app.get('/player/live-stream'");
  const routeEnd = server.indexOf("app.get('/player/managed'", routeStart);
  const liveReceiverRoute = server.slice(routeStart, routeEnd);
  assert.match(liveReceiverRoute, /audioEnabled:\s*false/);
  assert.match(player, /device:program-audio-policy/);
  assert.match(player, /content_replace/);
});

test('live content state is read from the authenticated workspace, never an any-workspace stub', () => {
  const route = read('routes/live-stream.js');
  const dock = read('../frontend/js/views/media-control/action-dock.js');
  assert.match(route, /async function getCameraDirectorState\(workspaceId\)/);
  assert.match(route, /const hasCanonicalAnpviz = !!\(s\.sources\?\.anpviz/);
  assert.match(route, /const value = hasCanonicalAnpviz \? nestedValue : legacyValue/);
  assert.match(route, /sourceBoolean\(anpviz\.microphone_connected, s\.microphone_connected\)/);
  assert.match(route, /sourceBoolean\(anpviz\.audio_online, s\.audio_online\)/);
  assert.match(route, /const programSourceReady = cameraOnline/);
  assert.match(route, /microphoneConnected === true/);
  assert.match(route, /audioOnline === true/);
  assert.match(route, /synchronizationStatus === 'locked'/);
  assert.match(route, /anpviz_stream:\s*programSourceReady/);
  assert.match(route, /stream_start_allowed:\s*programSourceReady/);
  assert.match(route, /liveStreamProgramState\(workspaceId\)/);
  assert.match(route, /camera_edge:\s*director\.data\?\.camera_edge/);
  assert.doesNotMatch(dock, /status\s*&&\s*status\.ai_director/);
  assert.doesNotMatch(route, /function liveStreamProgramStateAny\(\)/);
});

test('source-controlled OBS assets contain exactly the required scenes and no runtime secrets', () => {
  const generator = read('../deploy/obs-fixed-compositor/generate-config.js');
  const unit = read('../deploy/obs-fixed-compositor/mbfd-fixed-compositor.service');
  const health = read('../deploy/obs-fixed-compositor/healthcheck.js');
  const deploy = read('../deploy/obs-fixed-compositor/install.sh');
  const docs = read('../deploy/obs-fixed-compositor/README.md');
  const environment = read('../deploy/obs-fixed-compositor/obs-fixed-compositor.env.example');
  for (const scene of [
    'MBFD_CAMERA_ONLY',
    'MBFD_CONTENT_MAIN_CAMERA_PIP',
    'MBFD_CAMERA_MAIN_CONTENT_PIP',
  ]) {
    assert.match(generator, new RegExp(scene));
  }
  assert.match(generator, /1920/);
  assert.match(generator, /1080/);
  assert.match(generator, /30/);
  assert.match(generator, /keyint_sec/);
  assert.doesNotMatch(generator, /stream[_ -]?key\s*[:=]\s*['"][^'"]+/i);
  assert.match(unit, /EnvironmentFile=/);
  assert.match(unit, /Wants=.*mbfd-obs-x\.service/);
  assert.match(unit, /After=.*mbfd-obs-x\.service/);
  assert.match(unit, /Environment=DISPLAY=:20/);
  assert.match(unit, /Environment=QT_QPA_PLATFORM=xcb/);
  assert.match(unit, /\$\{OBS_NODE_BIN\}.*generate-config\.js/);
  assert.match(unit, /\$\{OBS_NODE_BIN\}.*healthcheck\.js/);
  assert.doesNotMatch(unit, /ExecStart(?:Pre|Post)=\/usr\/bin\/node/);
  assert.match(unit, /--websocket_ipv4_only/);
  assert.match(environment, /^OBS_NODE_BIN=/m);
  assert.match(unit, /ExecStartPre=.*xdpyinfo -display :20/);
  assert.match(unit, /WantedBy=multi-user\.target/);
  assert.match(health, /getCurrentProgramScene/);
  assert.match(deploy, /install/);
  assert.match(docs, /direct_camera/);
  assert.match(docs, /fixed_compositor/);
});

test('OBS generator creates one persistent camera and browser source across exactly three scenes', (t) => {
  const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mbfd-obs-config-'));
  t.after(() => fs.rmSync(runtimeDir, { recursive: true, force: true }));

  const generatorPath = path.join(__dirname, '..', '..', 'deploy', 'obs-fixed-compositor', 'generate-config.js');
  const secret = 'test-only-secret-that-must-not-be-logged';
  const result = spawnSync(process.execPath, [generatorPath], {
    encoding: 'utf8',
    env: {
      ...process.env,
      OBS_CONFIG_HOME: runtimeDir,
      OBS_CAMERA_RTSP_URL: 'rtsp://127.0.0.1:8554/camera',
      LIVE_PROGRAM_RECEIVER_URL: 'http://127.0.0.1:3000/player/live-stream',
      OBS_WEBSOCKET_PASSWORD: secret,
      OBS_H264_ENCODER: 'test_hardware_h264',
      PEERTUBE_RTMP_SERVER: 'rtmp://127.0.0.1/live',
      PEERTUBE_STREAM_KEY: 'test-only-stream-key',
    },
  });

  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, new RegExp(secret));

  const collection = JSON.parse(fs.readFileSync(
    path.join(runtimeDir, 'basic', 'scenes', 'MBFD_FIXED_COMPOSITOR.json'),
    'utf8',
  ));
  assert.deepEqual(
    collection.scene_order.map((scene) => scene.name),
    ['MBFD_CAMERA_ONLY', 'MBFD_CONTENT_MAIN_CAMERA_PIP', 'MBFD_CAMERA_MAIN_CONTENT_PIP'],
  );
  assert.equal(collection.sources.filter((source) => source.name === 'MBFD_ANPVIZ_CAMERA').length, 1);
  assert.equal(collection.sources.filter((source) => source.name === 'MBFD_LIVE_CONTENT').length, 1);
  assert.equal(collection.sources.filter((source) => source.id === 'scene').length, 3);
  assert.equal(collection.sources.some((source) => source.name === 'Cut'), false);
  assert.deepEqual(collection.transitions, []);
  assert.equal(
    collection.sources.find((source) => source.name === 'MBFD_ANPVIZ_CAMERA').settings.ffmpeg_options,
    'rtsp_transport=tcp',
  );

  const websocket = JSON.parse(fs.readFileSync(
    path.join(runtimeDir, 'plugin_config', 'obs-websocket', 'config.json'),
    'utf8',
  ));
  assert.equal(websocket.auth_required, true);
  assert.equal('server_bind_address' in websocket, false);

  const profile = fs.readFileSync(
    path.join(runtimeDir, 'basic', 'profiles', 'MBFD_FIXED_COMPOSITOR', 'basic.ini'),
    'utf8',
  );
  assert.match(profile, /BaseCX=1920/);
  assert.match(profile, /BaseCY=1080/);
  assert.match(profile, /FPSInt=30/);
  assert.match(profile, /KeyframeInterval=2/);
  assert.match(profile, /SampleRate=48000/);
  assert.doesNotMatch(profile, /obs_x264/);
});
