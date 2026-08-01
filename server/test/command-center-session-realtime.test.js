'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

function read(relPath) {
  return fs.readFileSync(path.join(__dirname, '..', '..', relPath), 'utf8');
}

test('authenticated website sessions always land on Command Center', () => {
  const app = read('frontend/js/app.js');

  assert.doesNotMatch(app, /enterpriseOk \? '#\/operator-console' : '#\/control'/);
  assert.match(app, /isAuthenticated\(\) && \(hash === '' \|\| hash === '#' \|\| hash === '#\/'\)/);
  assert.match(app, /window\.location\.hash = '#\/control'/);
});

test('Command Center reloads wall topology from socket events and cleans up its listener', () => {
  const control = read('frontend/js/views/media-control.js');

  assert.match(control, /socketOn\('wall-changed', wallChangedHandler\)/);
  assert.match(control, /socketOn\('room-snapshot', roomSnapshotWallHandler\)/);
  assert.match(control, /wallsFromRoomSnapshot/);
  assert.match(control, /await loadWalls\(\)/);
  assert.match(control, /socketOff\('wall-changed', wallChangedHandler\)/);
  assert.match(control, /targetApi\?\.setOptions/);
});

test('Operator Control inventory also refreshes from topology socket events', () => {
  const manager = read('frontend/js/components/operator-console/topology-manager.js');

  assert.match(manager, /socketOn\('wall-changed'/);
  assert.match(manager, /socketOn\('device-added'/);
  assert.match(manager, /socketOff\('wall-changed'/);
});

test('wall layout controls are non-modal and apply immediately', () => {
  const controls = read('frontend/js/views/media-control/span-split.js');

  assert.doesNotMatch(controls, /confirmDialog/);
  assert.match(controls, /onSetWallLayout/);
});

test('hybrid wall controls use the authoritative wall revision and contain async failures', () => {
  const controls = read('frontend/js/views/media-control/span-split.js');
  const control = read('frontend/js/views/media-control.js');

  assert.match(controls, /wall\.layout_revision/);
  assert.doesNotMatch(controls, /wall\.layout\?\.revision \|\| 0/);
  assert.match(controls, /layoutMutationPending/);
  assert.match(controls, /catch \{ \/\* host reports and reconciles the failure \*\/ \}/);
  assert.match(control, /await api\.getWall\(wallId\)/);
  assert.match(control, /error\?\.code === 'LAYOUT_REVISION_CONFLICT'/);
  assert.match(control, /await loadWalls\(\)/);
});

test('installable web app capability includes the standard and Apple compatibility metadata', () => {
  const index = read('frontend/index.html');

  assert.match(index, /<meta name="mobile-web-app-capable" content="yes">/);
  assert.match(index, /<meta name="apple-mobile-web-app-capable" content="yes">/);
});
