const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

function readPlayerFile(name) {
  return fs.readFileSync(path.join(__dirname, '..', 'player', name), 'utf8');
}

function readSnippet(filePath, startMarker, endMarker) {
  const html = fs.readFileSync(filePath, 'utf8');
  const start = html.indexOf(startMarker);
  assert.ok(start >= 0, `${startMarker} should exist in ${path.basename(filePath)}`);
  const end = html.indexOf(endMarker, start);
  assert.ok(end >= 0, `${endMarker} should exist in ${path.basename(filePath)}`);
  return html.slice(start, end);
}

test('player transport normalization unwraps nested payload wrappers', () => {
  const snippet = readSnippet(
    path.join(__dirname, '..', 'player', 'index.html'),
    'function normalizeTransportCommand(input) {',
    'function postTransportToFrames(command)'
  );

  assert.ok(snippet.includes('unwrapTransportPayload'), 'normalizeTransportCommand should unwrap nested transport payloads');
  assert.ok(snippet.includes('rawPayload.action'), 'normalizeTransportCommand should read raw payload actions');
  assert.ok(snippet.includes('rawPayload.command'), 'normalizeTransportCommand should read raw payload commands');
  assert.ok(snippet.includes('command.action'), 'normalizeTransportCommand should still allow direct actions');
  assert.ok(snippet.includes('command.type'), 'normalizeTransportCommand should still preserve the transport wrapper type');
});

test('player direct iframe transport handles go_to_slide targets', () => {
  const snippet = readSnippet(
    path.join(__dirname, '..', 'player', 'index.html'),
    'function tryDirectIframeTransport(command) {',
    'function doTransport(input)'
  );

  assert.ok(snippet.includes('go_to_slide'), 'tryDirectIframeTransport should recognize go_to_slide');
  assert.ok(snippet.includes('payload.page'), 'tryDirectIframeTransport should read slide targets from payload');
  assert.ok(
    snippet.indexOf('childWindow.handleAction') >= 0 &&
      snippet.indexOf('childWindow.handleAction') < snippet.indexOf('const pageImg = idoc.getElementById'),
    'tryDirectIframeTransport should use child handleAction state before DOM fallback'
  );
  assert.ok(snippet.includes("typeof result.then === 'function'"), 'parent should await asynchronous child-player acknowledgements');
});

test('player applies validated seek commands to YouTube and HTML5 video', () => {
  const snippet = readSnippet(
    path.join(__dirname, '..', 'player', 'index.html'),
    'function readSeekPosition(command, duration) {',
    '// Phase 2: dashboard "Identify" action'
  );

  assert.ok(snippet.includes('position_seconds'), 'seek should accept the canonical position_seconds field');
  assert.ok(snippet.includes('payload.position'), 'seek should retain the legacy position alias');
  assert.ok(snippet.includes('payload.time'), 'seek should retain the legacy time alias');
  assert.ok(snippet.includes("action === 'seek'"), 'transport should recognize seek');
  assert.ok(snippet.includes('activeYtPlayer.seekTo(position, true)'), 'YouTube seek should use the IFrame API');
  assert.ok(snippet.includes('currentVideoEl && currentVideoEl.isConnected'), 'HTML5 transport should prefer the tracked active video');
  assert.ok(snippet.includes("document.querySelector('#playerContainer video, .wall-stage video')"), 'HTML5 transport should fall back to a DOM lookup');
  assert.ok(snippet.includes('video.currentTime = boundedPosition'), 'HTML5 video seek should update currentTime');
  assert.ok(snippet.includes("video.addEventListener('seeked'"), 'HTML5 seek should wait for media-clock convergence');
  assert.ok(snippet.includes("'Video seek did not converge'"), 'HTML5 seek should fail instead of acknowledging an unapplied clock');
  assert.ok(snippet.includes('transportSeekInProgress = true'), 'paused video seek should suppress transient playback state');
  assert.ok(snippet.includes('Promise.resolve(video.play()).then(apply)'), 'paused video seek should wake the decoder before moving its clock');
  assert.ok(snippet.includes('if (wasPaused && !video.paused) video.pause()'), 'paused video seek should restore pause before acknowledgement');
  assert.ok(snippet.includes("finishTransportCommand(command, false, 'Invalid or unsupported seek target'"), 'invalid seek payloads should fail explicitly');
  assert.ok(snippet.includes('payload.position_normalized'), 'seek should support normalized positions');
  assert.ok(snippet.includes('payload.position_percent'), 'seek should support percentage positions');
});

test('player teardown prevents stale YouTube transport from hijacking local video', () => {
  const snippet = readSnippet(
    path.join(__dirname, '..', 'player', 'index.html'),
    'function teardownCurrentMedia() {',
    'function isWallFillContent(item)'
  );

  assert.ok(snippet.includes('++ytGeneration'), 'teardown should invalidate late YouTube callbacks');
  assert.ok(snippet.includes('activeYtPlayer.destroy()'), 'teardown should release the previous YouTube player');
  assert.ok(snippet.includes('activeYtPlayer = null'), 'teardown should return transport authority to the visible media');
  assert.ok(
    snippet.indexOf('activeYtPlayer = null') < snippet.indexOf("container.querySelectorAll('video')"),
    'embedded transport state should be cleared before mounting replacement media'
  );
});

test('parent media acknowledgements do not freeze the authoritative playback clock', () => {
  const html = readPlayerFile('index.html');
  const finish = readSnippet(
    path.join(__dirname, '..', 'player', 'index.html'),
    'function finishTransportCommand(command, ok, error, state) {',
    'function handleTransportMessage(event)'
  );

  assert.ok(html.includes('function acceptChildTransportState(state)'), 'child playback state should have an explicit ownership boundary');
  assert.ok(!finish.includes('lastTransportState = state'), 'parent acknowledgement snapshots must not override the live media clock');
  assert.ok(html.includes('acceptChildTransportState(data.__mc_transport_state)'), 'verified child frame state should remain authoritative');
  assert.ok(html.includes('acceptChildTransportState(state);\n                finishTransportCommand'), 'direct child acknowledgements should persist child state before publishing');
});

test('managed display audio permission remains authoritative in split mode', () => {
  const html = readPlayerFile('index.html');

  assert.ok(html.includes('function audioOutputAllowed()'), 'player should centralize output audio permission');
  assert.ok(html.includes('managedDisplay.audioEnabled === true'), 'managed TVs should require an explicit audio grant');
  assert.ok(html.includes('if (!audioOutputAllowed()) {\n        document.querySelectorAll'), 'transport audio unlock should hard-mute non-audio displays');
  assert.ok(html.includes('video.muted = !audioOutputAllowed() || !userHasInteracted'), 'local videos should mount muted on non-audio displays');
  assert.ok(html.includes('mute: youtubeAudioAllowed && userHasInteracted ? 0 : 1'), 'YouTube should obey the same output policy');
  assert.ok(html.includes('video.muted = audioOutputAllowed() ? wasMuted : true'), 'seek completion must not restore forbidden audio');
});

test('HLS child player implements canonical video transport and state reporting', () => {
  const hls = readPlayerFile('hls.html');
  assert.ok(hls.includes('window.MbfdDeviceContract.normalizeCommand'), 'child player should normalize the canonical command envelope');
  assert.ok(hls.includes('window.handleAction'), 'same-origin parent should have a direct child transport bridge');
  assert.ok(hls.includes('__mc_transport_ack'), 'cross-frame transport should return an acknowledgement');
  assert.ok(hls.includes('__mc_transport_state'), 'child playback events should publish authoritative state');
  assert.ok(hls.includes('position_normalized'), 'child seek should support normalized positions');
  assert.ok(hls.includes("video.addEventListener('ended'"), 'child should publish ended state');
  assert.ok(hls.includes("video.addEventListener('error'"), 'child should publish error state');
});

test('player restores persisted document slide state after reconnect before publishing stale state', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'player', 'index.html'), 'utf8');

  assert.ok(html.includes('function normalizeDisplayStateRestore(state)'), 'player should normalize server display_state restore payloads');
  assert.ok(html.includes('function childSlideStateReady(childState, restore)'), 'player should wait for child page metadata before restoring');
  assert.ok(html.includes('function tryApplyDisplayStateRestore(reason)'), 'player should apply restore through the child handleAction contract');
  assert.ok(html.includes("action: 'go_to_slide'"), 'restore should use canonical go_to_slide transport');
  assert.ok(html.includes('shouldHoldStateReportForRestore(state)'), 'player should suppress temporary page-1 reports while restore is pending');
  assert.ok(html.includes('publishPlayerState({ force: true })'), 'player should publish authoritative state after restore completes');
});

test('player reports local cache readiness from completed media loading, not URL presence', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'player', 'index.html'), 'utf8');
  assert.ok(html.includes('let currentLocalAssetReady = null'));
  assert.ok(html.includes('local_asset_ready: currentLocalAssetReady'));
  assert.ok(html.includes("currentCacheStatus = localPlayableAsset ? 'staging' : 'direct'"));
  assert.ok(html.includes("currentLocalAssetReady = true"));
  assert.ok(!html.includes('local_asset_ready: item && item.asset_url ? 1 : 0'));
});

test('doc player transport normalization unwraps nested payload wrappers before go_to_slide', () => {
  const snippet = readSnippet(
    path.join(__dirname, '..', 'player', 'doc.html'),
    'function unwrapTransportPayload(payload) {',
    'function goToPage(value)'
  );

  assert.ok(snippet.includes('rawPayload.action || rawPayload.command || rawPayload.type'), 'doc normalizeAction should detect wrapper payloads');
  assert.ok(snippet.includes('unwrapTransportPayload(rawPayload)'), 'doc normalizeAction should flatten nested payloads');
  assert.ok(snippet.includes('input.type'), 'doc normalizeAction should still preserve the wrapper type as a fallback');
});

test('deck player transport normalization unwraps nested payload wrappers before go_to_slide', () => {
  const snippet = readSnippet(
    path.join(__dirname, '..', 'player', 'deck.html'),
    'function unwrapTransportPayload(payload) {',
    'function goToSlide(value)'
  );

  assert.ok(snippet.includes('rawPayload.action || rawPayload.command || rawPayload.type'), 'deck normalizeAction should detect wrapper payloads');
  assert.ok(snippet.includes('unwrapTransportPayload(rawPayload)'), 'deck normalizeAction should flatten nested payloads');
  assert.ok(snippet.includes('input.type'), 'deck normalizeAction should still preserve the wrapper type as a fallback');
});
