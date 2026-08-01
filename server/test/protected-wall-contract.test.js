'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

function read(relPath) {
  return fs.readFileSync(path.join(__dirname, '..', '..', relPath), 'utf8');
}

test('protected Classroom Video Walls allow operation but reject structural mutation server-side', () => {
  const route = read('server/routes/video-walls.js');

  assert.match(route, /function requireWallOperate\(/);
  assert.match(route, /function rejectProtectedWallStructuralMutation\(/);
  assert.match(route, /PROTECTED_WALL_OPERATION_FIELDS/);
  assert.match(route, /router\.put\('\/:id\/layout', requireWallOperate/);
  const layoutStart = route.indexOf("router.put('/:id/layout'");
  assert.doesNotMatch(route.slice(layoutStart, layoutStart + 420), /rejectProtectedWallStructuralMutation\(req, res\)/);

  for (const signature of [
    "router.put('/:id/devices'",
    "router.put('/:id/regions/sync'",
    "router.delete('/:id'",
  ]) {
    const start = route.indexOf(signature);
    assert.notEqual(start, -1, `${signature} route is present`);
    assert.match(route.slice(start, start + 420), /rejectProtectedWallStructuralMutation\(req, res\)/);
  }
  const generalUpdate = route.indexOf("router.put('/:id'");
  assert.match(route.slice(generalUpdate, generalUpdate + 520), /requireWallOperate/);
  assert.match(route.slice(generalUpdate, generalUpdate + 520), /rejectProtectedWallStructuralMutation\(req, res,\s*\{\s*allowOperations:\s*true\s*\}\)/);
  assert.doesNotMatch(route, /'layout_mode',\s*\n\s*'is_locked'/);
  assert.match(route, /code: 'PROTECTED_WALL'/);
});

test('workspace viewers can operate only protected classroom targets', () => {
  const wallRoute = read('server/routes/video-walls.js');
  const broadcastRoute = read('server/routes/broadcast.js');

  assert.match(wallRoute, /wall\.is_locked/);
  assert.match(wallRoute, /workspace_viewer/);
  assert.match(broadcastRoute, /function allTargetsBelongToProtectedWalls\(/);
  assert.match(broadcastRoute, /include_live_stream !== true/);
  assert.match(broadcastRoute, /Read-only access/);
});

test('operator-created custom walls cannot claim protected status', () => {
  const route = read('server/routes/video-walls.js');

  assert.doesNotMatch(route, /const \{ name,[^}]*is_locked[^}]*\} = req\.body/);
  assert.match(route, /playlist_id \|\| null, 0\)/);
});

test('protected wall editor is a read-only topology summary', () => {
  const view = read('frontend/js/views/video-wall.js');

  assert.match(view, /data-protected-wall/);
  assert.match(view, /Protected Classroom Video Wall/);
  assert.match(view, /if \(locked\)[\s\S]{0,1800}return;/);
});

test('protected wall member displays cannot be retired or permanently removed', () => {
  const route = read('server/routes/devices.js');

  assert.match(route, /function rejectProtectedWallDeviceRemoval\(/);
  for (const signature of ["router.post('/:id/retire'", "router.delete('/:id'"]) {
    const start = route.indexOf(signature);
    assert.notEqual(start, -1, `${signature} route is present`);
    assert.match(route.slice(start, start + 520), /rejectProtectedWallDeviceRemoval\(req, res, device\)/);
  }
  assert.match(route, /code: 'PROTECTED_WALL_DEVICE'/);
});
