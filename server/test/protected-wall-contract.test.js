'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

function read(relPath) {
  return fs.readFileSync(path.join(__dirname, '..', '..', relPath), 'utf8');
}

test('protected Classroom Video Walls reject every configuration mutation server-side', () => {
  const route = read('server/routes/video-walls.js');

  assert.match(route, /function rejectProtectedWallMutation\(/);
  for (const signature of [
    "router.put('/:id'",
    "router.put('/:id/layout'",
    "router.put('/:id/devices'",
    "router.put('/:id/regions/sync'",
    "router.delete('/:id'",
  ]) {
    const start = route.indexOf(signature);
    assert.notEqual(start, -1, `${signature} route is present`);
    assert.match(route.slice(start, start + 420), /rejectProtectedWallMutation\(req, res\)/);
  }
  assert.doesNotMatch(route, /'layout_mode',\s*\n\s*'is_locked'/);
  assert.match(route, /code: 'PROTECTED_WALL'/);
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
