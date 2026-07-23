const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function source(relativePath) {
  return fs.readFileSync(path.join(__dirname, '..', relativePath), 'utf8');
}

test('broadcast route creates a persistent request and returns a request status URL', () => {
  const route = source('routes/broadcast.js');
  assert.match(route, /broadcastDelivery\.createRequest\(/);
  assert.match(route, /deliveryRequest\.devices/);
  assert.match(route, /broadcastDelivery\.markDispatched\(/);
  assert.match(route, /request_id:\s*deliveryRequest\.id/);
  assert.match(route, /status_url:/);
});

test('playlist payload carries request, command, source, and expected revision metadata', () => {
  const socket = source('ws/deviceSocket.js');
  assert.match(socket, /payload\.broadcast_delivery/);
  assert.match(socket, /request_id:\s*String\(activeDelivery\.requestId\)/);
  assert.match(socket, /command_id:\s*String\(activeDelivery\.commandId\)/);
  assert.match(socket, /source_id:\s*String\(activeDelivery\.sourceId\)/);
  assert.match(socket, /expected_playlist_revision:\s*payload\.playlist_revision/);
  assert.match(socket, /broadcastDelivery\.markPrepared\(/);
});

test('authenticated player status is persisted and relayed to the workspace dashboard', () => {
  const socket = source('ws/deviceSocket.js');
  assert.match(socket, /socket\.on\('device:broadcast-status'/);
  assert.match(socket, /deviceId:\s*currentDeviceId/);
  assert.match(socket, /broadcastDelivery\.markPlayerStatus\(/);
  assert.match(socket, /dashboard:broadcast-status/);
});

test('player distinguishes receipt from confirmed rendering', () => {
  const player = source('player/index.html');
  assert.match(player, /emitPendingBroadcastStatus\('acknowledged'\)/);
  assert.match(player, /emitPendingBroadcastStatus\('confirmed'\)/);
  assert.match(player, /expected_playlist_revision/);
  assert.match(player, /render_generation/);
  assert.match(player, /confirmPendingBroadcastRender/);
});

test('frontend polls and renders every device state rather than treating HTTP acceptance as success', () => {
  const send = source('../frontend/js/views/media-control/send.js');
  assert.match(send, /trackBroadcastDelivery/);
  assert.match(send, /result\.request_id/);
  assert.doesNotMatch(send, /sentToast\(label,\s*result\.sent,\s*result\.total\)/);
});
