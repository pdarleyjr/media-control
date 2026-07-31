'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

function read(relPath) {
  return fs.readFileSync(path.join(__dirname, '..', '..', relPath), 'utf8');
}

test('Operator Control defaults to focused display and wall management', () => {
  const consoleView = read('frontend/js/views/media-control-enterprise/operator-console.js');
  const manager = read('frontend/js/components/operator-console/topology-manager.js');

  assert.match(consoleView, /mountTopologyManager/);
  assert.match(consoleView, /Operator Control/);
  assert.match(consoleView, /Advanced content routing/);
  assert.doesNotMatch(consoleView, /About \/ System|buildInfoHtml/);
  assert.match(manager, /data-topology-manager/);
  assert.match(manager, /Pair display/);
  assert.match(manager, /Create custom wall/);
});

test('display management supports pair, retire, restore, and permanent removal', () => {
  const manager = read('frontend/js/components/operator-console/topology-manager.js');

  assert.match(manager, /api\.pairDevice\(/);
  assert.match(manager, /api\.retireDevice\(/);
  assert.match(manager, /api\.restoreDevice\(/);
  assert.match(manager, /api\.getDeviceDeletionImpact\(/);
  assert.match(manager, /api\.deleteDevice\([^,]+,\s*impact\.etag\)/);
  assert.match(manager, /PROTECTED_WALL_DEVICE/);
});

test('custom wall creation combines only available displays and remains reversible', () => {
  const manager = read('frontend/js/components/operator-console/topology-manager.js');

  assert.match(manager, /availableDevices\(/);
  assert.match(manager, /api\.createWall\(/);
  assert.match(manager, /api\.setWallDevices\(/);
  assert.match(manager, /layout_revision/);
  assert.match(manager, /api\.deleteWall\(created\.id\)/);
  assert.match(manager, /wall\.is_locked/);
  assert.match(manager, /Protected Classroom Video Wall/);
});
