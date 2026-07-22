'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function read(relative) {
  return fs.readFileSync(path.join(__dirname, '..', relative), 'utf8');
}

test('OBS program receiver never exposes the interactive connection screen', () => {
  const player = read('player/index.html');
  assert.match(player, /managed-program-receiver #setupScreen[\s\S]*display:\s*none\s*!important/);
  assert.match(player, /function isManagedProgramReceiver\(\)/);
  assert.match(player, /if \(isManagedProgramReceiver\(\)\)[\s\S]*receiverHealth\.markError/);
});

test('OBS program receiver requests and monitors complete authoritative snapshots', () => {
  const player = read('player/index.html');
  assert.match(player, /socket\.emit\('device:room-snapshot'/);
  assert.match(player, /socket\.on\('device:room-snapshot'/);
  assert.match(player, /receiverHealth\.acceptSnapshot/);
  assert.match(player, /window\.__playerRoomSnapshot/);
  assert.match(player, /window\.__playerHealth/);
  assert.match(player, /receiverHealth\.checkFreshness/);
});

test('device socket enforces receiver event limits and derives snapshot tenancy server-side', () => {
  const source = read('ws/deviceSocket.js');
  assert.match(source, /socket\.use\(programReceiverEventGuard\(\(\) => currentDeviceId\)\)/);
  assert.match(source, /socket\.on\('device:room-snapshot'/);
  assert.match(source, /resolveProgramReceiverSnapshotTarget\(/);
  assert.match(source, /createRoomSnapshot\(/);
});

test('live-stream bootstrap does not read receiver credentials from the URL', () => {
  const server = read('server.js');
  const start = server.indexOf("app.get('/player/live-stream'");
  const end = server.indexOf("app.get('/player/managed'", start);
  const route = server.slice(start, end);
  assert.doesNotMatch(route, /normalizePlayerAccessQuery/);
  assert.doesNotMatch(route, /req\.query/);
  assert.match(route, /loadLiveStreamBootstrapDisplay/);
  assert.match(route, /no-store, private/);
});
