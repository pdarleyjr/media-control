const fs = require('fs');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

test('live stream controls follow the authoritative AI Director stream state', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '..', '..', 'frontend', 'js', 'views', 'media-control', 'command-bar.js'),
    'utf8'
  );

  assert.match(source, /await api\.liveStream\.operatorState\(\)/);
  assert.match(source, /status\?\.ai_director\?\.data\?\.stream_active === true/);
  assert.match(source, /liveStartBtn\.hidden = active/);
  assert.match(source, /liveStopBtn\.hidden = !active/);
});

test('operator can prepare the OBS program source without starting a stream', () => {
  const api = fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', 'js', 'api.js'), 'utf8');
  const dock = fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', 'js', 'views', 'media-control', 'action-dock.js'), 'utf8');
  const commandBar = fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', 'js', 'views', 'media-control', 'command-bar.js'), 'utf8');
  const prepareModal = fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', 'js', 'views', 'media-control', 'prepare-live-production.js'), 'utf8');
  assert.match(api, /prepare: \(\) => request\('\/live-stream\/prepare'/);
  assert.match(api, /operatorState: \(\) => request\('\/live-stream\/operator-state'/);
  assert.match(api, /productionPlan: \(body\) => request\('\/live-stream\/production-plan'/);
  assert.match(dock, /data-dock="prepare-live"/);
  assert.match(dock, /openPrepareLiveProductionModal/);
  assert.match(dock, /mc\.cc\.live\.prepared/);
  assert.match(dock, /api\.liveStream\.operatorState\(\)/);
  assert.match(prepareModal, /api\.liveStream\.productionPlan/);
  assert.match(commandBar, /data-launch="live-prepare"/);
  assert.match(commandBar, /await api\.liveStream\.prepare\(\)/);
});
