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
    'function normalizeTransportCommand(input',
    'function postTransportToFrames(command'
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
    'function tryDirectIframeTransport(command',
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
  assert.ok(snippet.includes("document.querySelector('#playerContainer video, .wall-stage video, .zone video')"), 'HTML5 transport should fall back to a DOM lookup');
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
    snippet.indexOf('activeYtPlayer = null') < snippet.indexOf("container.querySelectorAll('video, audio')"),
    'embedded transport state should be cleared before mounting replacement media'
  );
});

test('player initialization and media callbacks are generation-safe', () => {
  const html = readPlayerFile('index.html');
  const teardown = readSnippet(
    path.join(__dirname, '..', 'player', 'index.html'),
    'function teardownCurrentMedia() {',
    'function isWallFillContent(item)'
  );
  const localVideo = readSnippet(
    path.join(__dirname, '..', 'player', 'index.html'),
    "const video = document.createElement('video');",
    '} else if (isImage) {'
  );

  assert.ok(html.includes('window.__MBFD_PLAYER_INITIALIZED__'), 'duplicate script initialization should be rejected');
  assert.match(
    html,
    /<script>\s*if \(window\.__MBFD_PLAYER_INITIALIZED__\)[\s\S]*?window\.__MBFD_PLAYER_INITIALIZED__ = true;\s*\/\/ =+ i18n/,
    'the initialization guard must wrap the main player script rather than an earlier independent script block'
  );
  assert.ok(html.includes('let playbackGeneration = 0'), 'media transitions should have a monotonic generation');
  assert.ok(teardown.includes('++playbackGeneration'), 'teardown should invalidate every prior media callback');
  assert.ok(teardown.includes("querySelectorAll('video, audio')"), 'teardown should include every audible HTML media element');
  assert.ok(teardown.includes('v.muted = true'), 'old media should be muted before it is paused');
  assert.ok(teardown.includes('v.srcObject = null'), 'old capture streams should be detached');
  assert.ok(teardown.includes("v.removeAttribute('src')"), 'old media URLs should be cleared');
  assert.ok(localVideo.includes('const myGeneration = playbackGeneration'), 'a mounted video should capture its generation');
  assert.match(localVideo, /video\.onended = \(\) => \{\s*if \(playbackGeneration !== myGeneration\) return;/);
  assert.match(localVideo, /video\.onloadeddata = \(\) => \{\s*if \(playbackGeneration !== myGeneration\) return;/);
  assert.ok(localVideo.includes('playbackGeneration === myGeneration'), 'late play promises should not revive replaced media');
});

test('player teardown detaches all stale HTML media event handlers', () => {
  const teardown = readSnippet(
    path.join(__dirname, '..', 'player', 'index.html'),
    'function teardownCurrentMedia() {',
    'function isWallFillContent(item)'
  );

  for (const handler of [
    'onended', 'onerror', 'onloadeddata', 'onplay', 'onpause',
    'onplaying', 'oncanplay', 'ontimeupdate', 'onvolumechange'
  ]) {
    assert.ok(teardown.includes(`v.${handler} = null`), `${handler} should be detached during teardown`);
  }
});

test('origin fallback listeners and pending seeks are cancelled across media generations', () => {
  const html = readPlayerFile('index.html');
  const fallback = readSnippet(
    path.join(__dirname, '..', 'player', 'index.html'),
    'function attachOriginFallback(',
    '// Extract YouTube video ID'
  );
  const seek = readSnippet(
    path.join(__dirname, '..', 'player', 'index.html'),
    'function finishVideoSeek(',
    'function findControllableVideo('
  );
  const teardown = readSnippet(
    path.join(__dirname, '..', 'player', 'index.html'),
    'function teardownCurrentMedia() {',
    'function isWallFillContent(item)'
  );

  assert.ok(html.includes('let currentMediaAbortController = null'));
  assert.ok(html.includes('let activeSeekCancel = null'));
  assert.match(fallback, /const generation = playbackGeneration/);
  assert.match(fallback, /if \(generation !== playbackGeneration\) return;/);
  assert.match(fallback, /signal: currentMediaAbortController\.signal/);
  assert.match(teardown, /currentMediaAbortController\.abort\(\)/);
  assert.match(teardown, /activeSeekCancel\('Media changed before seek completed'\)/);
  assert.match(seek, /const seekGeneration = playbackGeneration/);
  assert.match(seek, /currentVideoEl === video/);
  assert.match(seek, /activeSeekCancel === cancel/);
});

test('zone videos also reject late callbacks from a replaced render', () => {
  const zones = readSnippet(
    path.join(__dirname, '..', 'player', 'index.html'),
    'function renderZones(container, defaultItem) {',
    '// ==================== Screenshots'
  );
  assert.match(zones, /const zoneGeneration = playbackGeneration/);
  assert.match(zones, /if \(playbackGeneration !== zoneGeneration\) return;/);
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
  assert.match(html, /acceptChildTransportState\(state\);\r?\n\s+finishTransportCommand/, 'direct child acknowledgements should persist child state before publishing');
});

test('player screenshot reporting tolerates socket startup and disconnect races', () => {
  const childMessages = readSnippet(
    path.join(__dirname, '..', 'player', 'index.html'),
    'function handleTransportMessage(event) {',
    'window.addEventListener(\'message\', handleTransportMessage);'
  );
  const canvasCapture = readSnippet(
    path.join(__dirname, '..', 'player', 'index.html'),
    'function captureAndSend(correlationId = null) {',
    'function startStreaming()'
  );

  assert.match(
    childMessages,
    /if \(socket\?\.connected\) \{[\s\S]*?socket\.emit\('device:screenshot'/,
    'child-frame screenshots must not emit before the device socket is connected'
  );
  assert.match(
    canvasCapture,
    /if \(base64 && base64\.length > 100 && socket\?\.connected\) \{[\s\S]*?socket\.emit\('device:screenshot'/,
    'canvas screenshots must not emit after a device socket disconnect'
  );
});

test('wall video autoplay starts muted immediately without wallStartDelay gate', () => {
  const html = readPlayerFile('index.html');
  assert.match(html, /const wallStartDelayMs = 0/);
  assert.match(html, /Wall tiles ALWAYS start muted/);
  assert.match(html, /video\.preload = 'auto'/);
  assert.match(html, /Aggressive retries/);
});

test('single-item playlists never timer-advance into a black-flash re-render', () => {
  const html = readPlayerFile('index.html');
  const nextItem = readSnippet(
    path.join(__dirname, '..', 'player', 'index.html'),
    'function nextItem() {',
    'function contentSrcForItem(item) {'
  );
  assert.ok(
    nextItem.includes('playlist.length <= 1') && nextItem.includes('return;'),
    'nextItem must no-op for sticky single-item playlists'
  );
  assert.match(
    html,
    /isImage[\s\S]*?if \(!isFollower && playlist\.length > 1\) \{\s*advanceTimer = setTimeout\(nextItem/,
    'image rotation must require multi-item playlists'
  );
  assert.match(
    html,
    /item\.widget_id[\s\S]*?if \(!isFollower && playlist\.length > 1\) \{\s*advanceTimer = setTimeout\(nextItem/,
    'widget rotation must require multi-item playlists'
  );
});

test('player version handshake reloads stale renderers after a socket reconnect', () => {
  const versionCheck = readSnippet(
    path.join(__dirname, '..', 'player', 'index.html'),
    'function acceptServerVersion(data) {',
    '// ==================== Video Wall ===================='
  );

  assert.ok(
    versionCheck.includes('if (!knownServerHash)'),
    'the first version response should establish the player bundle baseline'
  );
  assert.ok(
    versionCheck.includes('nextHash !== knownServerHash'),
    'later version responses should compare against the existing bundle baseline'
  );
  assert.ok(
    versionCheck.includes('location.reload()'),
    'a reconnect to a different server bundle must reload the stale renderer'
  );
  assert.match(
    versionCheck,
    /if \(!knownServerHash\) \{[\s\S]*?knownServerHash = nextHash;[\s\S]*?return;[\s\S]*?if \(nextHash !== knownServerHash\)/,
    'only the first response may establish a baseline; reconnect responses must compare before replacing it'
  );
});

test('managed display audio permission remains authoritative in split mode', () => {
  const html = readPlayerFile('index.html');

  assert.ok(html.includes('function audioOutputAllowed()'), 'player should centralize output audio permission');
  assert.ok(html.includes('managedDisplay.audioEnabled === true'), 'managed TVs should require an explicit audio grant');
  assert.match(html, /if \(!audioOutputAllowed\(\)\) \{\r?\n\s+document\.querySelectorAll/, 'transport audio unlock should hard-mute non-audio displays');
  assert.ok(
    html.includes('video.muted = true') && html.includes('mayUnmuteLater'),
    'local videos should mount muted on non-audio displays'
  );
  assert.ok(html.includes('mute: youtubeAudioAllowed && userHasInteracted ? 0 : 1'), 'YouTube should obey the same output policy');
  assert.ok(html.includes('video.muted = audioOutputAllowed() ? wasMuted : true'), 'seek completion must not restore forbidden audio');
});

test('video startup fallback does not override an operator pause', () => {
  const html = readPlayerFile('index.html');
  assert.ok(html.includes('let videoHasStarted = false'), 'video startup should track whether playback ever began');
  assert.ok(html.includes('videoHasStarted = true'), 'the playing event should close the startup fallback window');
  assert.ok(html.includes('video.__mcOperatorPaused = true'), 'pause transport should mark explicit operator intent');
  assert.ok(html.includes('if (!videoStartIsCurrent()) return;'), 'a delayed synchronized start must not override an immediate operator pause');
  assert.ok(html.includes('video.isConnected && currentVideoEl === video'), 'a delayed start must not revive detached or superseded media');
  assert.match(
    html,
    /if \(!videoStartIsCurrent\(\)\) \{ try \{ video\.pause\(\);(?: video\.muted = true;)? \} catch \(_\) \{\} return; \}/,
    'a pending play promise must reassert pause if operator intent changes'
  );
  assert.ok(html.includes('if (!videoHasStarted && !video.__mcOperatorPaused && video.paused)'), 'fallback replay must not restart an intentionally paused video');
});

test('span wall sync carries and enforces leader playback state', () => {
  const html = readPlayerFile('index.html');
  assert.ok(html.includes('paused: activeYtPlayer'), 'leader sync should publish its actual paused state');
  assert.ok(html.includes('if (data.paused && !currentVideoEl.paused)'), 'followers should pause when the leader is paused');
  assert.ok(html.includes('else if (!data.paused && currentVideoEl.paused)'), 'followers should resume when the leader is playing');
  assert.ok(html.includes('const latency = data.paused ? 0'), 'paused clocks must not advance by relay latency');
  assert.ok(html.includes('isFollowerEmbed && !lastWallSync?.paused'), 'YouTube follower recovery must preserve a leader pause');
  assert.ok(html.includes("if (action === 'play_pause' && wallConfig && !wallConfig.is_leader)"), 'span followers must not independently execute a non-idempotent toggle');
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

test('live video transport smoke covers the complete physical playback contract', () => {
  const smoke = fs.readFileSync(path.join(__dirname, '..', '..', 'scripts', 'live-video-transport-smoke.js'), 'utf8');
  for (const action of ['pause', 'seek', 'play', 'restart', 'play_pause']) {
    assert.ok(smoke.includes(`'${action}'`), `live smoke should exercise ${action}`);
  }
  assert.ok(smoke.includes('position_seconds: 2'), 'live smoke should exercise absolute seek');
  assert.ok(smoke.includes('position_normalized: 0.5'), 'live smoke should exercise normalized seek');
  assert.ok(smoke.includes('duration > 0'), 'live smoke should verify duration');
  assert.ok(smoke.includes("row.render_state === 'playing'"), 'restart must be visibly playing before the toggle assertion');
  assert.ok(smoke.includes('row.paused === 0'), 'restart must not pass while the new video is still paused');
  assert.ok(smoke.includes('current_time'), 'live smoke should verify the physical media clock');
  assert.ok(smoke.includes('error_state'), 'live smoke should reject player errors');
  assert.ok(smoke.includes('restoreContentId'), 'live smoke should restore the classroom baseline');
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

test('player rebases persisted revisions even when reconnect state has no slide metadata', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'player', 'index.html'), 'utf8');
  const normalizeStart = html.indexOf('function normalizeDisplayStateRestore(state)');
  const slideGuard = html.indexOf('if (!Number.isFinite(slide) || slide < 1) return null;', normalizeStart);
  const revisionRebase = html.indexOf('playerStateRevision = Math.max(playerStateRevision, revision);', normalizeStart);

  assert.ok(normalizeStart >= 0, 'restore normalizer should exist');
  assert.ok(revisionRebase > normalizeStart && revisionRebase < slideGuard, 'state revision must rebase before non-slide states return');
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
