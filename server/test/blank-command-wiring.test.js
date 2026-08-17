const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = (...parts) => fs.readFileSync(path.join(__dirname, '..', '..', ...parts), 'utf8');

test('dashboard delivery carries the persisted target revision without claiming screen state', () => {
  const source = read('server', 'ws', 'dashboardSocket.js');
  const commandModel = read('server', 'lib', 'command-model.js');
  assert.match(source, /envelope\.target_revision = cmd\.revision/);
  assert.match(source, /envelope\.payload\.target_revision = cmd\.revision/);
  assert.match(commandModel, /target_revision: row\.revision/);
  assert.match(commandModel, /target_revision: row\.revision,[\s\S]*?action: r\.command_type/);
  assert.doesNotMatch(source, /UPDATE devices SET screen_on/);
});

test('player uses explicit state setters and has no clickable blank overlay', () => {
  const source = read('server', 'player', 'index.html');
  assert.match(source, /applyScreenCommand\(command, false\)/);
  assert.match(source, /applyScreenCommand\(command, true\)/);
  assert.match(source, /screen_on: screenStateController\.snapshot\(\)\.screen_on/);
  assert.match(source, /pointer-events:none/);
  assert.doesNotMatch(source, /toggleScreenOff/);
  assert.doesNotMatch(source, /screenOffOverlay['"]?\)?\.onclick/);
});

test('confirmed blank state is persisted and projected from display_states', () => {
  const model = read('server', 'lib', 'command-model.js');
  const snapshot = read('server', 'lib', 'room-snapshot.js');
  const projection = read('frontend', 'js', 'services', 'room-display-projection.js');
  const stage = read('frontend', 'js', 'views', 'media-control', 'stage.js');
  assert.match(model, /'screen_on'/);
  assert.match(snapshot, /ds\.screen_on/);
  assert.match(snapshot, /screenOn: boolOrNull\(row\.screen_on\)/);
  assert.match(projection, /typeof display\.screenOn === 'boolean'/);
  assert.doesNotMatch(projection, /device\.screenOn \?\?/);
  assert.match(stage, /typeof display\.screen_on !== 'boolean'/);
  assert.match(stage, /mc\.blank\.status\.unknown/);
  assert.match(stage, /screenStateIdentity/);
});

test('player reconnect restore and release hash include authoritative screen modules', () => {
  const deviceSocket = read('server', 'ws', 'deviceSocket.js');
  const server = read('server', 'server.js');
  const worker = read('server', 'player', 'sw.js');
  assert.match(deviceSocket, /error_state, screen_on, state_revision/);
  assert.match(deviceSocket, /screen_on: row\.screen_on == null \? null : row\.screen_on !== 0/);
  assert.match(server, /js\/views\/media-control\/blank-state\.js/);
  assert.match(server, /js\/services\/display-state-revision\.js/);
  assert.match(server, /js\/views\/present\.js/);
  assert.match(server, /player', 'screen-state\.js/);
  assert.match(server, /'managed-bootstrap\.js', 'sw\.js'/);
  assert.doesNotMatch(server, /media-control\/command-bar\.js/);
  assert.match(worker, /rd-player-v13/);
});

test('socket command ids do not leak into disconnect lifecycle handling', () => {
  const socket = read('frontend', 'js', 'socket.js');
  const disconnect = socket.match(/export function disconnectSocket\(\) \{[\s\S]*?\n\}/)?.[0] || '';
  const sendCommand = socket.match(/export function sendCommand\([\s\S]*?\n\}/)?.[0] || '';
  assert.doesNotMatch(disconnect, /envelope/);
  assert.match(sendCommand, /return envelope\?\.command_id \|\| null/);
});
