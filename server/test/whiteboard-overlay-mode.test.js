const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

function read(relPath) {
  return fs.readFileSync(path.join(__dirname, '..', '..', relPath), 'utf8');
}

test('whiteboard offers explicit wall/display targets and overlay or blank modes', () => {
  const host = read('frontend/js/views/media-control.js');
  const board = read('frontend/js/views/media-control/whiteboard.js');

  assert.match(host, /function whiteboardTargets\(\)/);
  assert.match(host, /function whiteboardTargetFromActive\(\)/);
  assert.match(host, /targets: whiteboardTargets\(\)/);
  assert.match(board, /id="mc-wb-target-select"/);
  assert.match(board, /data-wb-mode="overlay"/);
  assert.match(board, /data-wb-mode="blank"/);
  assert.match(board, /mode: whiteboardMode/);
});

test('overlay mode paints over the physical display screenshot and refreshes it while open', () => {
  const board = read('frontend/js/views/media-control/whiteboard.js');
  const css = read('frontend/css/media-control.css');

  assert.match(board, /class="mc-wb-background-grid"/);
  assert.match(board, /socketOn\('screenshot-ready'/);
  assert.match(board, /function requestTargetScreenshots\(\)[\s\S]*requestScreenshot\(id\)/);
  assert.doesNotMatch(board, /SCREENSHOT_REFRESH_MS/);
  assert.match(board, /ctx\.clearRect\(0, 0, canvas\.width, canvas\.height\)/);
  assert.match(board, /globalCompositeOperation = 'destination-out'/);
  assert.match(css, /\.mc-wb-background/);
  assert.match(css, /\.mc-wb-canvas-wrap\.is-blank/);
});

test('whiteboard start fans out to every resolved wall target and carries mode to players', () => {
  const socket = read('server/ws/dashboardSocket.js');
  const player = read('server/player/index.html');

  assert.match(socket, /mode: data && data\.mode === 'blank' \? 'blank' : 'overlay'/);
  assert.match(socket, /relayToTargets\('device:wb-show', payload, wbTargets\(data, device_id\)\)/);
  assert.match(player, /function wbApplyMode\(mode\)/);
  assert.match(player, /_wb\.mode = mode === 'blank' \? 'blank' : 'overlay'/);
  assert.match(player, /wbApplyMode\(options && options\.mode\)/);
});

test('whiteboard ignores stale session hydration after a local edit or target mode change', () => {
  const board = read('frontend/js/views/media-control/whiteboard.js');

  assert.match(board, /let sessionRequestRevision = 0/);
  assert.match(board, /let localEditRevision = 0/);
  assert.match(board, /const requestRevision = \+\+sessionRequestRevision/);
  assert.match(board, /const editRevision = localEditRevision/);
  assert.match(board, /requestRevision !== sessionRequestRevision/);
  assert.match(board, /editRevision !== localEditRevision/);
  assert.match(board, /localEditRevision \+= 1/);
});

test('whiteboard composes every target member and avoids a permanent fixed poll', () => {
  const board = read('frontend/js/views/media-control/whiteboard.js');

  assert.match(board, /members:\s*Array\.isArray\(t\.members\)/);
  assert.match(board, /class="mc-wb-background-grid"/);
  assert.match(board, /function renderCompositeBackground\(/);
  assert.match(board, /requestTargetScreenshots\(/);
  assert.doesNotMatch(board, /setInterval\(requestPhysicalScreenshot/);
});

test('whiteboard clips composite strokes and normalizes transformed member payloads', () => {
  const board = read('frontend/js/views/media-control/whiteboard.js');
  const socket = read('server/ws/dashboardSocket.js');

  assert.match(board, /function clipSegment\(/);
  assert.match(board, /clipSegment\(stroke\.points\[index - 1\], stroke\.points\[index\]/);
  assert.match(socket, /whiteboardState\.normalizeStroke\(memberStrokes\[id\]\)/);
  assert.match(socket, /relayToTargets\('device:wb-stroke', \{ stroke: localStroke \}/);
});
