const fs = require('fs');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

test('live stream controls follow the authoritative publisher state', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '..', '..', 'frontend', 'js', 'views', 'media-control', 'command-bar.js'),
    'utf8'
  );

  assert.match(source, /await api\.liveStream\.operatorState\(\)/);
  assert.match(source, /status\?\.publisher\?\.active === true/);
  assert.match(source, /liveStartBtn\.hidden = active/);
  assert.match(source, /liveStopBtn\.hidden = !active/);
});

test('operator starts in one click and controls only the three fixed compositions', () => {
  const api = fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', 'js', 'api.js'), 'utf8');
  const dock = fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', 'js', 'views', 'media-control', 'action-dock.js'), 'utf8');
  const commandBar = fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', 'js', 'views', 'media-control', 'command-bar.js'), 'utf8');
  const send = fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', 'js', 'views', 'media-control', 'send.js'), 'utf8');
  assert.doesNotMatch(api, /request\('\/live-stream\/prepare'/);
  assert.match(api, /operatorState: \(\) => request\('\/live-stream\/operator-state'/);
  // Compatibility routes remain server-side for rolling deployments, but no
  // active instructor client surface carries those calls.
  assert.doesNotMatch(api, /request\('\/live-stream\/production-plan'/);
  assert.doesNotMatch(dock, /data-dock="prepare-live"|openPrepareLiveProductionModal|programPrepared/);
  assert.doesNotMatch(commandBar, /data-launch="live-prepare"|prepareLiveProgram\(/);
  assert.match(dock, /api\.liveStream\.operatorState\(\)/);
  const startHandler = dock.slice(
    dock.indexOf('async function onStartLive()'),
    dock.indexOf('async function onStopLive()'),
  );
  assert.match(startHandler, /api\.liveStream\.start\(\{\s*initiator:\s*'operator'/);
  assert.doesNotMatch(startHandler, /confirmDialog/);
  assert.match(dock, /data-composition-layout="camera_only"/);
  assert.match(dock, /data-composition-layout="content_main_camera_pip"/);
  assert.match(dock, /data-composition-layout="camera_main_content_pip"/);
  assert.match(dock, /data-composition-add/);
  assert.match(dock, /api\.liveStream\.compositionContent/);
  assert.doesNotMatch(send, /api\.liveStream\.compositionContent/);
});
