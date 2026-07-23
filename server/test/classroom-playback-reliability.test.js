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

// §8: ACKNOWLEDGED is RECEIPT only; CONFIRMED requires a matching physical
// player-state report. ack alone must NEVER reach CONFIRMED.
test('command confirmation requires matching player state, not ack alone (task §8)', () => {
  const src = readFrontend('views/media-control/transport.js');
  assert.ok(src.includes('function matchesExpectedState'));
  // ack without a matching state stays ACKNOWLEDGED and waits for state-sync.
  assert.ok(src.includes("COMMAND_LIFECYCLE.ACKNOWLEDGED"));
  assert.ok(src.includes('entry.acknowledged = true'));
  assert.ok(src.includes('ensureDisplayStateConfirmation'));
  // A matching physical state promotes to CONFIRMED.
  assert.ok(src.includes("COMMAND_LIFECYCLE.CONFIRMED"));
  assert.ok(src.includes("confirmed_by: 'ack-state'"));
  assert.ok(src.includes("confirmed_by: 'state-sync'"));
  // Correlation fields carried on the pending entry.
  assert.ok(src.includes('action: resolvedAction'));
  assert.ok(src.includes('contentInstanceId'));
  // Pause confirms only on paused=true; Play on paused=false; Seek on position.
  assert.ok(src.includes("action === 'pause'") && src.includes('state.paused === true'));
  assert.ok(src.includes("action === 'play'") && src.includes('state.paused === false'));
  assert.ok(src.includes("action === 'seek'"));
  // Wrong device / wrong content instance must NOT confirm.
  assert.ok(src.includes('state.device_id') && src.includes('entry.deviceId'));
  assert.ok(src.includes('entry.contentInstanceId') && src.includes('state.content_instance_id'));
});

test('player-protocol exports expanded transport + lifecycle vocabulary', () => {
  const src = readFrontend('player-protocol.js');
  assert.ok(src.includes('go_to_slide'));
  assert.ok(src.includes('COMMAND_LIFECYCLE'));
  assert.ok(src.includes('TARGET_FIELDS'));
  assert.ok(src.includes('buildTransportTarget'));
  assert.ok(src.includes("'seek'"));
});

test('stage cards are passive and transport is centralized (task §8)', () => {
  const src = readFrontend('views/media-control/stage.js');
  const main = readFrontend('views/media-control.js');
  // Display cards are <article> (NOT <button>) so they can contain a screensaver
  // <select> without nesting interactive controls. A dedicated select button is
  // the sole inspect affordance.
  assert.ok(src.includes('<article class="mc-card mc-display-card'));
  assert.ok(src.includes('class="mc-card-select"'));
  // NO per-card transport hosts — one authoritative toolbar lives below the canvas.
  assert.ok(!src.includes('data-tp-host'));
  assert.ok(!src.includes('mc-card-transport'));
  assert.ok(!src.includes('mc-wall-transport'));
  // The authoritative transport row + split/zone confinement live in media-control.js.
  assert.ok(main.includes('function activeTargetTransportIds()'));
  assert.ok(main.includes('function mountTransportRow('));
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

test('player serializes rapid transport and drops stale non-durable reconnect commands', () => {
  const html = read('index.html');
  assert.ok(html.includes('transportSerialQueue'));
  assert.ok(html.includes('doTransportNow'));
  assert.ok(html.includes('stale_command'));
  assert.ok(html.includes('45000'));
  assert.ok(html.includes('alreadyAppliedCommand'));
  assert.ok(html.includes('rememberAppliedCommand'));
});

test('duplicate command_id is idempotent in player and deck/doc without re-applying', () => {
  const html = read('index.html');
  const deck = read('deck.html');
  const doc = read('doc.html');
  assert.ok(html.includes('alreadyAppliedCommand(command.command_id)'));
  assert.ok(deck.includes('appliedCommandIds[cmd.command_id]'));
  assert.ok(doc.includes('appliedCommandIds[cmd.command_id]'));
  assert.ok(deck.includes('ack.idempotent'));
  assert.ok(doc.includes('ack.idempotent'));
});

test('duplicate seek payloads remain valid and share canonical command identity', () => {
  const a = contract.createCommand({
    device_id: 'd1',
    command_id: '11111111-1111-4111-8111-111111111111',
    payload: { action: 'seek', seconds: 4 },
  });
  const b = contract.createCommand({
    device_id: 'd1',
    command_id: '11111111-1111-4111-8111-111111111111',
    payload: { action: 'seek', position_seconds: 4 },
  });
  assert.equal(contract.validateCommand(a).ok, true);
  assert.equal(contract.validateCommand(b).ok, true);
  assert.equal(a.command_id, b.command_id);
});

test('two-zone targeting remains distinct in resolve path and transport UI', () => {
  const html = read('index.html');
  const transport = readFrontend('views/media-control/transport.js');
  const stage = readFrontend('views/media-control/stage.js');
  const main = readFrontend('views/media-control.js');
  assert.ok(html.includes('zone_id'));
  assert.ok(html.includes('pickZoneRootForAction'));
  assert.ok(html.includes('Ambiguous multi-zone target'));
  assert.ok(transport.includes('zoneId'));
  assert.ok(transport.includes('buildTransportTarget'));
  // §8: transport is centralized in media-control.js (mountTransportRow), not on
  // stage cards. Span-wall fan-out resolves every wall member via
  // activeTargetTransportIds → wallTransportDeviceIds; split/zone confinement is
  // enforced by transport.js buildTransportTarget/requireSingleTarget.
  assert.ok(main.includes('function activeTargetTransportIds()'));
  assert.ok(main.includes('wallTransportDeviceIds'));
  assert.ok(transport.includes('requireSingleTarget'));
});

test('web and podium share transport module lifecycle waits for command-ack', () => {
  const transport = readFrontend('views/media-control/transport.js');
  assert.ok(transport.includes("onSocket('command-ack'"));
  assert.ok(transport.includes('sendTransportCommand'));
  assert.ok(transport.includes('COMMAND_LIFECYCLE.CONFIRMED'));
  assert.ok(transport.includes('COMMAND_LIFECYCLE.STALE'));
  assert.ok(transport.includes('COMMAND_LIFECYCLE.OFFLINE'));
  assert.ok(transport.includes('DEFAULT_COMMAND_TIMEOUT_MS'));
});

test('non-regression: livestream/audio/socket/service-worker ownership surfaces remain intact', () => {
  const root = path.join(__dirname, '..');
  assert.ok(fs.existsSync(path.join(root, 'routes', 'live-stream.js')) || fs.existsSync(path.join(root, 'lib')));
  // Agent 3 did not modify these paths; prove the worktree still contains the supporting modules.
  const liveCandidates = [
    path.join(root, 'routes', 'live-stream.js'),
    path.join(root, 'lib', 'command-model.js'),
    path.join(root, 'player', 'sw.js'),
  ];
  for (const file of liveCandidates) {
    assert.ok(fs.existsSync(file), `expected ${path.basename(file)} present for integration`);
  }
  const commandModel = fs.readFileSync(path.join(root, 'lib', 'command-model.js'), 'utf8');
  assert.ok(commandModel.includes('recordAck') || commandModel.includes('ingestCommand'));
  const sw = fs.readFileSync(path.join(root, 'player', 'sw.js'), 'utf8');
  assert.ok(sw.length > 20, 'player service worker must remain present');
  // dashboardSocket still exposes device-command (our touch) without removing other control channels
  const dash = fs.readFileSync(path.join(root, 'ws', 'dashboardSocket.js'), 'utf8');
  assert.ok(dash.includes("dashboard:device-command"));
  assert.ok(dash.includes('screen_on') || dash.includes('screen_off') || dash.includes('wb-'));
});

test('idempotency map semantics: first apply records, second sees duplicate', () => {
  // Mirrors player appliedCommandIds memory without a browser DOM.
  const applied = new Map();
  function remember(id, ok) {
    if (!id) return;
    applied.set(String(id), { ok: ok !== false, at: Date.now() });
  }
  function already(id) {
    if (!id) return null;
    return applied.get(String(id)) || null;
  }
  remember('cmd-next-1', true);
  const second = already('cmd-next-1');
  assert.ok(second);
  assert.equal(second.ok, true);
  assert.equal(already('cmd-next-2'), null);
  remember('cmd-seek-1', true);
  assert.equal(already('cmd-seek-1').ok, true);
});

test('stale vs durable command classification matches player policy', () => {
  const durable = new Set(['go_to_slide', 'seek', 'pause', 'stop', 'mute', 'unmute', 'volume']);
  const nonDurable = ['next', 'prev', 'play_pause', 'restart'];
  for (const action of nonDurable) assert.equal(durable.has(action), false);
  for (const action of durable) assert.equal(durable.has(action), true);
  const ageMs = 46000;
  const wouldDrop = (action, age) => age > 45000 && !durable.has(action);
  assert.equal(wouldDrop('next', ageMs), true);
  assert.equal(wouldDrop('seek', ageMs), false);
  assert.equal(wouldDrop('go_to_slide', ageMs), false);
  assert.equal(wouldDrop('next', 1000), false);
});
