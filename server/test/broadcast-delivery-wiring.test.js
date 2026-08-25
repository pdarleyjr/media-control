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

test('broadcast fences one dynamic audio policy before committing its request-scoped owner', () => {
  const route = source('routes/broadcast.js');
  assert.match(route, /resolveDeterministicAudioOwner/);
  assert.match(route, /source\.content_instance_id\s*=\s*deliveryRequest\.id/);
  assert.match(route, /const proposedAudioPolicy\s*=\s*buildAudioPolicy\(/);
  assert.match(route, /outputDeviceId:\s*audioOutputDeviceId/);
  assert.match(route, /ownerDeviceId:\s*audioOwnerDeviceId/);
  assert.match(route, /transactionId:\s*deliveryRequest\.id/);
  assert.match(route, /nextAudioPolicyRevision\(/);
  assert.match(route, /revision:\s*audioPolicyRevision/);
  assert.match(route, /await fenceAudioOwnershipTargets\(deviceNamespace,/);
  assert.match(route, /source\.audio_policy\s*=\s*audioFenceResult\.committed_policy/);
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

test('playlist payload carries a device-specific mute decision from the durable common policy', () => {
  const socket = source('ws/deviceSocket.js');
  assert.match(socket, /payload\.audio_policy/);
  assert.match(socket, /audio_allowed/);
  assert.match(socket, /force_muted/);
  assert.match(socket, /playlist_revision:\s*payload\.playlist_revision/);
  assert.match(
    socket,
    /authoritativeAudioPolicy\s*&&\s*!authoritativeAudioPolicy\.owner_device_id[\s\S]*ensureAudioOwnerAfterReconnect/,
    'a durable null-owner policy must retry a fresh fenced recovery after the host becomes ready',
  );
});

test('authenticated player status is persisted and relayed to the workspace dashboard', () => {
  const socket = source('ws/deviceSocket.js');
  assert.match(socket, /socket\.on\('device:broadcast-status'/);
  assert.match(socket, /deviceId:\s*currentDeviceId/);
  assert.match(socket, /broadcastDelivery\.markPlayerStatus\(/);
  assert.match(socket, /dashboard:broadcast-status/);
  assert.match(socket, /region_states:\s*Array\.isArray\(rawState\.region_states\)/);
});

test('player distinguishes receipt from confirmed rendering', () => {
  const player = source('player/index.html');
  const bootstrap = source('player/managed-bootstrap.js');
  const contentSource = player.slice(
    player.indexOf('function safeMediaUrl(rawUrl) {'),
    player.indexOf('function resolveCaptionTrackUrl(rawUrl, baseUrl) {'),
  );
  assert.match(player, /emitPendingBroadcastStatusFor\(pending, 'acknowledged'\)/);
  assert.match(player, /emitPendingBroadcastStatusFor\(pending, 'confirmed'\)/);
  assert.match(player, /expected_playlist_revision/);
  assert.match(player, /render_generation/);
  assert.match(player, /confirmPendingBroadcastRender/);
  assert.match(player, /scheduleRenderConfirmation/);
  assert.match(player, /scheduleVideoRenderReady/);
  assert.match(bootstrap, /fallbackDelayMs/);
  assert.match(contentSource, /new URL\(raw, window\.location\.href\)/);
  assert.match(contentSource, /candidate\.protocol !== 'http:'[\s\S]*candidate\.protocol !== 'https:'/);
  assert.match(contentSource, /candidate\.username[\s\S]*\|\| candidate\.password/);
  assert.match(contentSource, /return safeMediaUrl\(raw\)/);
  const fullscreenImage = player.slice(
    player.indexOf('} else if (isImage) {'),
    player.indexOf('} else if (isPdf) {'),
  );
  assert.ok(
    fullscreenImage.indexOf("markBroadcastElementReady(img, 'image-decoded')")
      < fullscreenImage.indexOf('requestAnimationFrame(() =>'),
    'decoded image confirmation must not wait for a throttled animation frame',
  );
  assert.ok(
    fullscreenImage.indexOf('mount.appendChild(img)')
      < fullscreenImage.indexOf('img.src = src'),
    'fullscreen images must be attached before cached content can emit load',
  );
});

test('YouTube failures remain visible in authoritative player state', () => {
  const player = source('player/index.html');
  const youtube = player.slice(
    player.indexOf('function youtubePlaybackError'),
    player.indexOf('// Note: YouTube advancement'),
  );
  assert.match(youtube, /101|150/);
  assert.match(youtube, /does not allow embedded playback/);
  assert.match(youtube, /currentMediaError\s*=\s*youtubePlaybackError\(event\.data\)/);
  assert.match(youtube, /publishPlayerState\(\)/);
  assert.match(youtube, /failPendingBroadcastRender\(currentMediaError\)/);
});

test('detached media cannot confirm or fail a newer pending broadcast', () => {
  const player = source('player/index.html');
  const readiness = player.slice(
    player.indexOf('function isCurrentBroadcastElement(element) {'),
    player.indexOf('function confirmCurrentRenderIfReady()'),
  );
  assert.match(readiness, /element\.isConnected/);
  assert.match(readiness, /container\.contains\(element\)/);
  assert.match(readiness, /if \(!isCurrentBroadcastElement\(element\)\) return false/);
  assert.match(readiness, /function failPendingBroadcastElement\(element, message\)/);
  assert.match(player, /failPendingBroadcastElement\(img, 'Image failed to load'\)/);
  assert.match(player, /failPendingBroadcastElement\(pdfFrame, 'PDF frame failed to load'\)/);
  assert.match(player, /failPendingBroadcastElement\(docFrame, 'Document frame failed to load'\)/);
  assert.match(player, /failPendingBroadcastElement\(iframe, 'Widget frame failed to load'\)/);
});

test('detached split-zone media cannot mutate a newer broadcast barrier', () => {
  const player = source('player/index.html');
  const zones = player.slice(
    player.indexOf('function renderZones(container, defaultItem) {'),
    player.indexOf('// ==================== Screenshots'),
  );
  assert.match(zones, /playbackGeneration === zoneGeneration/);
  assert.match(zones, /container\.contains\(zoneElement\)/);
  assert.match(zones, /mediaElement\.isConnected && zoneElement\.contains\(mediaElement\)/);
  assert.match(zones, /markCurrentZoneReady\(div, iframe, zoneKey\)/);
  assert.match(zones, /markCurrentZoneReady\(div, img, zoneKey\)/);
  assert.match(zones, /markCurrentZoneReady\(div, video, zoneKey\)/);
  assert.match(zones, /failCurrentZone\(div, iframe,/);
  assert.match(zones, /failCurrentZone\(div, img,/);
  assert.match(zones, /failCurrentZone\(div, video,/);
});

test('re-sending already rendered content binds delivery proof to the visible generation', () => {
  const player = source('player/index.html');
  const unchanged = player.slice(
    player.indexOf('if (newFp === oldFp'),
    player.indexOf("console.log('Playlist changed, updating')"),
  );
  assert.match(
    unchanged,
    /bindPendingBroadcastToRender\(\);\s*scheduleCurrentRenderConfirmation\(\)/,
  );

  const continuity = player.slice(
    player.indexOf("scheduleDisplayStateRestore('playlist-continuity')"),
    player.indexOf('isPlaying = true;\n          playCurrentItem();'),
  );
  assert.match(
    continuity,
    /bindPendingBroadcastToRender\(\);\s*scheduleCurrentRenderConfirmation\(\)/,
  );
});

test('video confirmation has a bounded fallback for background-throttled wall windows', () => {
  const player = source('player/index.html');
  const fullscreenVideo = player.slice(
    player.indexOf('} else if (isVideo) {'),
    player.indexOf('} else if (isImage) {'),
  );
  assert.match(fullscreenVideo, /scheduleVideoRenderReady\(/);
  assert.match(fullscreenVideo, /playbackGeneration === myGeneration/);
  assert.match(fullscreenVideo, /markBroadcastElementReady\(video, reason\)/);
});

test('web frame readiness is armed before navigation can complete', () => {
  const player = source('player/index.html');
  const webFrame = player.slice(
    player.indexOf("const frame = document.createElement('iframe');"),
    player.indexOf('mount.appendChild(frame);', player.indexOf("const frame = document.createElement('iframe');")),
  );

  assert.ok(
    webFrame.indexOf("frame.addEventListener('load'") < webFrame.indexOf('frame.src = webSrc;'),
    'a cached iframe may complete navigation before a late load listener is armed',
  );
  assert.ok(
    webFrame.indexOf("frame.addEventListener('error'") < webFrame.indexOf('frame.src = webSrc;'),
    'a synchronous iframe navigation failure must remain observable',
  );
  assert.match(webFrame, /let webSrc = null;/);
  assert.match(
    webFrame,
    /if \(!webSrc\) \{[\s\S]*?failPendingBroadcastRender\([\s\S]*?return;[\s\S]*?\}[\s\S]*?frame\.src = webSrc;/,
  );
});

test('frontend polls and renders every device state rather than treating HTTP acceptance as success', () => {
  const send = source('../frontend/js/views/media-control/send.js');
  assert.match(send, /trackBroadcastDelivery/);
  assert.match(send, /result\.request_id/);
  assert.doesNotMatch(send, /sentToast\(label,\s*result\.sent,\s*result\.total\)/);
});

test('drag-and-drop delivery tracks silently on success but still surfaces authoritative failures', () => {
  const send = source('../frontend/js/views/media-control/send.js');
  const view = source('../frontend/js/views/media-control.js');
  assert.doesNotMatch(send, /renderBroadcastDelivery|mc-delivery-panel/);
  const confirmed = send.slice(send.indexOf("if (request?.status === 'confirmed')"), send.indexOf("} else if", send.indexOf("if (request?.status === 'confirmed')")));
  assert.doesNotMatch(confirmed, /showToast/);
  assert.match(send, /players confirmed`, 'error'/);
  assert.match(view, /const DROP_DELIVERY_OPTIONS = \{ quietSuccess: true \}/);
  assert.match(view, /sendToPhysicalScope\([\s\S]*?DROP_DELIVERY_OPTIONS/);
  assert.match(view, /targets:\s*commandCenterState\.broadcastTargets,[\s\S]*?quietSuccess:\s*true/);
});
