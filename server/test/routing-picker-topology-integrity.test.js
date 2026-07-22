'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const picker = fs.readFileSync(
  path.join(__dirname, '../../frontend/js/views/media-control/routing-picker.js'),
  'utf8',
);
const mediaControl = fs.readFileSync(
  path.join(__dirname, '../../frontend/js/views/media-control.js'),
  'utf8',
);
const send = fs.readFileSync(
  path.join(__dirname, '../../frontend/js/views/media-control/send.js'),
  'utf8',
);

test('content target picking preserves the current wall composition', () => {
  const exportedPicker = picker.match(/export async function pickRoutingTargets[\s\S]*?\n\}/)?.[0] || '';
  assert.doesNotMatch(exportedPicker, /showWallModeDialog/);
  assert.match(exportedPicker, /mode:\s*'preserve'/);

  const applyModes = mediaControl.match(/async function applyWallRoutingModes[\s\S]*?\n\}/)?.[0] || '';
  assert.doesNotMatch(applyModes, /api\.updateWall/);
});

test('wall popup cards expose current layout revision, online count and physical canvas', () => {
  assert.match(picker, /layout_revision/);
  assert.match(picker, /onlineCount/);
  assert.match(picker, /wallCanvasSize/);
  assert.match(picker, /data-route-topology/);
});

test('shared picker broadcasts carry authoritative typed references to the server', () => {
  assert.match(mediaControl, /targetReferences:\s*result\.references/);
  assert.match(mediaControl, /sendToDisplays\(source, route\.targetIds, label, \{ targets: route\.targetReferences \}\)/);
  assert.match(mediaControl, /api\.files\.broadcast\(path, undefined, \{ targets: route\.targetReferences \}\)/);
  assert.match(send, /const targetPayload = typedTargets\.length \? \{ targets: typedTargets \} : \{ device_ids: targetIds \}/);
  assert.equal((send.match(/\.\.\.targetPayload/g) || []).length, 2);
});
