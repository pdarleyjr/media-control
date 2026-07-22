const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const contract = require('../player/device-contract');

function read(name) {
  return fs.readFileSync(path.join(__dirname, '..', 'player', name), 'utf8');
}

function readFrontend(rel) {
  return fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', 'js', rel), 'utf8');
}

function snippet(src, start, end) {
  const a = src.indexOf(start);
  assert.ok(a >= 0, `missing ${start}`);
  const b = src.indexOf(end, a);
  assert.ok(b > a, `missing ${end}`);
  return src.slice(a, b);
}

test('seek contract accepts seconds alias used by enterprise UI', () => {
  const command = contract.createCommand({
    device_id: 'd1',
    payload: { action: 'seek', seconds: 12.5 },
  });
  assert.equal(contract.validateCommand(command).ok, true);
});

test('volume contract validates 0..1 range', () => {
  const ok = contract.createCommand({ device_id: 'd1', payload: { action: 'volume', volume: 0.4 } });
  assert.equal(contract.validateCommand(ok).ok, true);
  const bad = contract.createCommand({ device_id: 'd1', payload: { action: 'volume', volume: 1.5 } });
  assert.equal(contract.validateCommand(bad).ok, false);
});

test('player zone tagging and multi-zone resolve helpers exist', () => {
  const html = read('index.html');
  assert.ok(html.includes('dataset.zoneId'));
  assert.ok(html.includes('function resolveTargetRoot'));
  assert.ok(html.includes('function pickZoneRootForAction'));
  assert.ok(html.includes('Ambiguous multi-zone target'));
  assert.ok(html.includes('appliedCommandIds'));
  assert.ok(html.includes('function doTransportNow'));
  assert.ok(html.includes('payload.seconds'));
  assert.ok(html.includes(".zone video"));
});

test('player stop/mute/volume/seek_forward handlers are present', () => {
  const src = snippet(read('index.html'), 'function doTransportNow(command)', '// Phase 2: dashboard "Identify" action');
  for (const action of ["'stop'", "'mute'", "'unmute'", "'volume'", "'seek_forward'", "'seek_backward'", "'resume'"]) {
    assert.ok(src.includes(action), `missing ${action}`);
  }
  assert.ok(src.includes('Autoplay rejected by browser'));
  assert.ok(src.includes('stale_command'));
  assert.ok(src.includes('duplicate_command') || src.includes('alreadyAppliedCommand'));
});

test('deck and doc enforce slide range and command idempotency', () => {
  const deck = read('deck.html');
  const doc = read('doc.html');
  assert.ok(deck.includes('Slide out of range'));
  assert.ok(deck.includes('appliedCommandIds'));
  assert.ok(deck.includes('ack.idempotent'));
  assert.ok(doc.includes('Page out of range'));
  assert.ok(doc.includes('appliedCommandIds'));
  assert.ok(doc.includes('ack.idempotent'));
});

test('transport UI waits for delivery and player command-ack lifecycle', () => {
  const src = readFrontend('views/media-control/transport.js');
  assert.ok(src.includes('COMMAND_LIFECYCLE'));
  assert.ok(src.includes('sendTransportCommand'));
  assert.ok(src.includes('command-ack'));
  assert.ok(src.includes('go_to_slide'));
  assert.ok(src.includes('requireSingleTarget'));
  assert.ok(src.includes('buildTransportTarget'));
  assert.ok(src.includes('apply_timeout') || src.includes('STALE'));
});

test('player-protocol exports expanded transport + lifecycle vocabulary', () => {
  const src = readFrontend('player-protocol.js');
  assert.ok(src.includes('go_to_slide'));
  assert.ok(src.includes('COMMAND_LIFECYCLE'));
  assert.ok(src.includes('TARGET_FIELDS'));
  assert.ok(src.includes('buildTransportTarget'));
  assert.ok(src.includes("'seek'"));
});

test('stage confines split/zone transport to a single device id', () => {
  const src = readFrontend('views/media-control/stage.js');
  assert.ok(src.includes("layoutMode === 'span'"));
  assert.ok(src.includes('requireSingleTarget'));
  assert.ok(src.includes('data-layout-mode'));
  assert.ok(src.includes('zoneId'));
});

test('display-state does not clobber operator pause on progress tick', () => {
  const src = readFrontend('services/display-state.js');
  assert.ok(src.includes('force_playing'));
  assert.ok(src.includes('cur.now_playing.paused === true'));
});

test('dashboardSocket preserves zone/content target fields on command payload', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'ws', 'dashboardSocket.js'), 'utf8');
  assert.ok(src.includes('content_instance_id'));
  assert.ok(src.includes('expected_revision'));
  assert.ok(src.includes('ambiguous_target'));
});

test('postTransportToFrames targets a specific zone root', () => {
  const src = snippet(read('index.html'), 'function postTransportToFrames(command, root)', 'function tryApplyDisplayStateRestore');
  assert.ok(src.includes('framesInRoot'));
  assert.ok(src.includes('Child player frame not ready for transport'));
});

test('player HTML5 video selector includes zone videos', () => {
  const src = snippet(read('index.html'), 'function findControllableVideo(root)', 'function doTransport(input)');
  assert.ok(src.includes("#playerContainer video, .wall-stage video, .zone video"));
});
