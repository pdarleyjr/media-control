const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

function read(relPath) {
  return fs.readFileSync(path.join(__dirname, '..', '..', relPath), 'utf8');
}

test('device ack and state reports fan out to target room and workspace stream', () => {
  const source = read('server/ws/deviceSocket.js');
  assert.match(source, /function emitToDeviceTargetAndWorkspace/);
  assert.match(source, /displayRoom\(deviceId\), deviceRoom\(deviceId\)/);
  assert.match(source, /emitToDeviceTargetAndWorkspace\(dashboardNs, currentDeviceId, 'command:ack'/);
  assert.match(source, /emitToDeviceTargetAndWorkspace\(dashboardNs, currentDeviceId, 'dashboard:state-sync'/);
});

test('dashboard socket exposes selected target helpers and reselects after reconnect', () => {
  const source = read('frontend/js/socket.js');
  assert.match(source, /let selectedTarget = null/);
  assert.match(source, /function emitSelectedTarget\(\)/);
  assert.match(source, /export function selectTarget\(targetType, targetId\)/);
  assert.match(source, /export function clearTarget\(\)/);
  assert.match(source, /dashboardSocket\.on\('connect'[\s\S]*emitSelectedTarget\(\)/);
});

test('media control drag drop refreshes the active visual truth without polling every display', () => {
  const source = read('frontend/js/views/media-control.js');
  assert.match(source, /const ACTIVE_PREVIEW_INTERVAL_MS = 1000/);
  assert.match(source, /const BACKGROUND_PREVIEW_INTERVAL_MS = 60000/);
  assert.match(source, /function requestActivePreview/);
  assert.match(source, /function activePreviewDeviceId/);
  assert.match(source, /function scheduleDisplayStateRefresh/);
  assert.match(source, /function queuePreviewRequests/);
  assert.match(source, /displayState\.refresh\(\)\.catch/);
  assert.match(source, /setInterval\(requestActivePreview, ACTIVE_PREVIEW_INTERVAL_MS\)/);
  assert.match(source, /setInterval\(requestVisiblePreviews, BACKGROUND_PREVIEW_INTERVAL_MS\)/);
  assert.match(source, /for \(const delay of \[350, 1400\]\)/);
  assert.match(source, /const ok = await sendToDisplays\(parsed\.source, \[deviceId\], parsed\.label\)/);
  assert.match(source, /if \(ok\) refreshAfterSend\(\[deviceId\]\)/);
});

test('span wall transport controls fan out to every wall member', () => {
  const main = read('frontend/js/views/media-control.js');
  const stage = read('frontend/js/views/media-control/stage.js');
  const transport = read('frontend/js/views/media-control/transport.js');

  assert.match(main, /function activeTargetTransportIds\(\)/);
  assert.match(main, /ids\.forEach\(id => sendCommand\(id, COMMAND_TYPES\.TRANSPORT/);
  assert.match(stage, /data-transport-ids="\$\{esc\(ids\)\}"/);
  assert.match(transport, /transportDeviceIds/);
  assert.match(transport, /transportIds\.forEach\(id => sendCommand\(id, COMMAND_TYPES\.TRANSPORT/);
});

test('an independently selected split-wall member remains renderable as a display target', () => {
  const main = read('frontend/js/views/media-control.js');

  assert.match(main, /!wallMemberIds\.has\(d\.id\)[\s\S]*activeTarget\.type === 'display'[\s\S]*activeTarget\.id === d\.id/);
  assert.match(main, /return isSplitWallMemberId\(d\.id\)/);
});

test('transport actions refresh state and force previews so dashboard mirrors slide changes', () => {
  const main = read('frontend/js/views/media-control.js');
  const stage = read('frontend/js/views/media-control/stage.js');
  const transport = read('frontend/js/views/media-control/transport.js');

  assert.match(main, /onTransportAction: \(ids\) => refreshAfterSend\(ids\)/);
  assert.match(main, /refreshAfterSend\(ids\)/);
  assert.match(stage, /onTransportAction/);
  assert.match(stage, /onTransportAction\(transportIds\.length \? transportIds : \[deviceId\], action\)/);
  assert.match(transport, /onTransportAction/);
  assert.match(transport, /if \(typeof onTransportAction === 'function'\) onTransportAction\(transportIds, action\)/);
});

test('presentation previews follow the authoritative physical slide state', () => {
  const main = read('frontend/js/views/media-control.js');
  const stage = read('frontend/js/views/media-control/stage.js');
  const livePreview = read('frontend/js/views/media-control/live-preview.js');
  const displayState = read('frontend/js/services/display-state.js');
  const deck = read('server/player/deck.html');

  assert.match(stage, /function shouldPreferPoster\(obj\)/);
  assert.match(stage, /kind === 'document' \|\| kind === 'pdf'/);
  assert.match(stage, /if \(screenshot && !shouldPreferPoster\(obj\)\)/);
  assert.match(displayState, /if \(state\.slide_index != null\) npPatch\.slideIndex = state\.slide_index/);
  assert.match(displayState, /if \(state\.slide_count != null\) npPatch\.slideCount = state\.slide_count/);
  assert.match(livePreview, /case 'pdf':[\s\S]*case 'document':[\s\S]*\/player\/doc\//);
  assert.match(livePreview, /case 'presentation':/);
  assert.match(livePreview, /data-mc-presentation="1"/);
  assert.match(main, /iframe\.mc-live-embed\[data-mc-presentation="1"\]/);
  assert.match(main, /__mc_transport:[\s\S]*action: 'go_to_slide'/);
  assert.match(deck, /params\.get\('slide'\)/);
  assert.match(deck, /params\.get\('preview'\) === '1'/);
  assert.match(main, /const preview = previewSource\(d\)/);
  assert.match(main, /preview \? \(preview\.poster \? 'poster' : 'screenshot'\) : 'none'/);
});

test('wall documents pass fill mode into the child player instead of centering on one TV', () => {
  const player = read('server/player/index.html');
  const doc = read('server/player/doc.html');

  assert.match(player, /fit === 'cover' \|\| fit === 'fill'/);
  assert.match(player, /'\?fit=' \+ encodeURIComponent\(normalizedFit\)/);
  assert.match(doc, /body\[data-fit="fill"\] #page \{ object-fit: fill; \}/);
});

test('embedded live playback is the default while screenshot-only mode is an explicit opt-out', () => {
  const livePreview = read('frontend/js/views/media-control/live-preview.js');
  const stage = read('frontend/js/views/media-control/stage.js');
  const grid = read('server/player/grid.html');

  assert.match(livePreview, /opts\.audioPreview === true/);
  assert.match(livePreview, /operator_preview=1/);
  assert.match(livePreview, /audioPreview \? '&audio_preview=1' : ''/);
  assert.doesNotMatch(livePreview, /preview=1&audio_preview=1/);
  assert.doesNotMatch(livePreview, /autoplay muted loop/);
  assert.match(livePreview, /export function enableLivePreviewAudio/);
  assert.match(livePreview, /video\.muted = false/);
  assert.match(livePreview, /child\.__mcEnableAudio\(\)/);
  assert.match(stage, /livePreviewDeviceId/);
  assert.match(stage, /audioPreview: livePreview/);
  const main = read('frontend/js/views/media-control.js');
  assert.match(main, /const LIVE_EMBED_PREVIEWS = new URLSearchParams\(window\.location\.search\)\.get\('live_preview'\) !== '0'/);
  assert.match(main, /livePreviewDeviceId: LIVE_EMBED_PREVIEWS \? activePreviewDeviceId\(\) : null/);
  assert.match(main, /const PREVIEW_REQUEST_MIN_MS = 750/);
  assert.match(main, /const ACTIVE_PREVIEW_INTERVAL_MS = 1000/);
  assert.match(main, /enableLivePreviewAudio\(app\)/);
  assert.match(main, /document\.addEventListener\('pointerdown', previewAudioGestureHandler, true\)/);
  assert.match(grid, /var operatorPreview = params\.get\('operator_preview'\) === '1'/);
  assert.match(grid, /var audioPreview = \(previewMode \|\| operatorPreview\) && params\.get\('audio_preview'\) === '1'/);
  assert.match(grid, /var STAGGER_MS = operatorPreview \? 600 : 1500/);
  assert.match(grid, /if \(item\.isAudio && _audioArmed\)[\s\S]*setTimeout\(enableAudioCell, 0\)/);
  assert.match(grid, /if \(audioPreview\)[\s\S]*window\.__mcEnableAudio\(\)/);
});

test('video previews reconcile seek and play state from the physical player', () => {
  const livePreview = read('frontend/js/views/media-control/live-preview.js');
  const main = read('frontend/js/views/media-control.js');

  assert.match(livePreview, /data-mc-video="1"/);
  assert.match(livePreview, /data-mc-current-time/);
  assert.match(livePreview, /data-mc-paused/);
  assert.match(main, /video\.mc-live-embed\[data-mc-video="1"\]/);
  assert.match(main, /Math\.abs\(video\.currentTime - target\) > 1\.25/);
  assert.match(main, /if \(paused\) video\.pause\(\)/);
  assert.match(main, /else video\.play\(\)\.catch/);
});

test('camera status reports active sources continuously instead of a static idle label', () => {
  const dock = read('frontend/js/views/media-control/action-dock.js');

  assert.doesNotMatch(dock, /textContent = ['"]cams idle['"]/);
  assert.match(dock, /data\.director && data\.director\.active_camera/);
  assert.match(dock, /mc\.cc\.camera\.active/);
  assert.match(dock, /setInterval\(\(\) => syncLive\(\), 5000\)/);
  assert.match(dock, /destroy\(\) \{ clearInterval\(healthTimer\); \}/);
});

test('known inactive live state never delays a normal content broadcast with a director status fetch', () => {
  const dock = read('frontend/js/views/media-control/action-dock.js');
  const send = read('frontend/js/views/media-control/send.js');

  assert.match(dock, /let liveStateKnown = false/);
  assert.match(dock, /export function isLiveStateKnown\(\)/);
  assert.match(dock, /liveStateKnown = true/);
  assert.match(send, /import \{ isLiveActive, isLiveStateKnown \} from '\.\/action-dock\.js'/);
  assert.match(send, /if \(isLiveStateKnown\(\)\) return isLiveActive\(\)/);
});

test('camera catalog maps Focus to wall 2 and ANNKE to wall 1', () => {
  const catalog = read('frontend/js/views/media-control/camera-feeds-catalog.js');
  const canvas = read('frontend/js/views/media-control/advanced-canvas.js');

  assert.match(catalog, /, 1, 'wall-2'\)/);
  assert.doesNotMatch(catalog, /, 1, 'wall-1'\)/);
  assert.match(catalog, /Video Wall 1', 3\)/);
  assert.match(canvas, /data-canvas-preset="wall-1"/);
  assert.match(canvas, /data-canvas-preset="wall-2"/);
  assert.match(canvas, /data-canvas-camera="3"/);
  assert.match(canvas, /preset: button\.dataset\.canvasPreset/);
});

test('periodic state timestamps never hide an authoritative device screenshot', () => {
  const stage = read('frontend/js/views/media-control/stage.js');

  assert.doesNotMatch(stage, /screenshotMatchesCurrentState/);
  assert.doesNotMatch(stage, /capturedAt >= stateUpdatedAt/);
  assert.match(stage, /const screenshot = obj && obj\.screenshot_url/);
  assert.match(stage, /periodic state reports advance that timestamp/);
});

test('split image cells replace a stale prior-media screenshot with current content', () => {
  const stage = read('frontend/js/views/media-control/stage.js');
  const displays = read('server/routes/displays.js');
  const player = read('server/player/index.html');

  assert.match(displays, /new Set\(\['image', 'video', 'web', 'youtube', 'pdf', 'document'\]\)/);
  assert.match(stage, /kind === 'image'[\s\S]*age > STALE_AFTER_S/);
  assert.match(stage, /content-bound poster is safer than pixels left over from the previous item/);
  assert.match(player, /img\.crossOrigin = 'anonymous'/);
  assert.match(player, /img\.addEventListener\('load'[\s\S]*captureAndSend\(\)/);
  assert.match(player, /img\.src = src;[\s\S]*mount\.appendChild\(img\)/);
});

test('display state store coalesces subscriber notifications by animation frame', () => {
  const source = read('frontend/js/services/display-state.js');
  assert.match(source, /let notifyScheduled = false/);
  assert.match(source, /requestAnimationFrame\(run\)/);
  assert.match(source, /else setTimeout\(run, 0\)/);
});

test('media control inspector does not report an online wall as offline just because preview is stale', () => {
  const source = read('frontend/js/views/media-control/inspector.js');
  assert.doesNotMatch(source, /Wall offline or preview unavailable/);
  assert.match(source, /if \(!online\) return 'Offline'/);
  assert.match(source, /if \(ageMs > 10000\) return 'Preview stale'/);
  assert.match(source, /if \(ageMs > 10000\) return 'Online, preview stale'/);
});

test('device screenshots update the persisted dashboard preview snapshot', () => {
  const source = read('server/ws/deviceSocket.js');
  assert.match(source, /function persistScreenshot\(deviceId, imageB64, capturedAt\)/);
  assert.match(source, /stale_screenshot/);
  assert.match(source, /UPDATE screenshots SET filepath = \?, captured_at = \? WHERE id = \?/);
  assert.match(source, /INSERT INTO screenshots \(device_id, filepath, captured_at\) VALUES \(\?, \?, \?\)/);
  assert.match(source, /persistScreenshot\(device_id, image_b64, captured_at \?\? timestamp\)/);
});

test('document player publishes the actual rendered slide to the parent screenshot channel', () => {
  const doc = fs.readFileSync(path.join(__dirname, '..', 'player', 'doc.html'), 'utf8');
  const player = fs.readFileSync(path.join(__dirname, '..', 'player', 'index.html'), 'utf8');
  assert.match(doc, /function publishScreenshot\(\)/);
  assert.match(doc, /__mc_screenshot: base64/);
  assert.match(doc, /img\.onload = function \(\)/);
  assert.match(doc, /window\.publishScreenshot = publishScreenshot/);
  assert.match(doc, /data\.__mc_screenshot_request === true/);
  assert.match(player, /data\.__mc_screenshot\.length <= 2 \* 1024 \* 1024/);
  assert.match(player, /image_b64: data\.__mc_screenshot/);
  assert.match(player, /setTimeout\(captureAndSend, 1200\)/);
  assert.match(player, /setTimeout\(captureAndSend, 6000\)/);
});

test('parent screenshot requests never overwrite iframe content with a fake fallback card', () => {
  const player = fs.readFileSync(path.join(__dirname, '..', 'player', 'index.html'), 'utf8');

  assert.match(player, /function requestIframeScreenshot\(\)/);
  assert.match(player, /typeof childWindow\.publishScreenshot === 'function'/);
  assert.match(player, /__mc_screenshot_request: true/);
  assert.match(player, /if \(requestIframeScreenshot\(\)\) return/);
});

test('server requests fresh previews after delivered content changes', () => {
  const sceneEngine = fs.readFileSync(path.join(__dirname, '..', 'services', 'scene-engine.js'), 'utf8');
  assert.match(sceneEngine, /if \(result && result\.delivered\)/);
  assert.match(sceneEngine, /for \(const delay of \[1500, 6500\]\)/);
  assert.match(sceneEngine, /emit\('device:screenshot-request'/);
  assert.match(sceneEngine, /reason: 'content-changed'/);
});

test('span-wall broadcasts push revised playlists to every follower', () => {
  const sceneEngine = fs.readFileSync(path.join(__dirname, '..', 'services', 'scene-engine.js'), 'utf8');
  assert.match(sceneEngine, /followers\.push\(m\.device_id\)/);
  assert.match(sceneEngine, /const deliver = \(\) => pushPlaylistUpdate\(io, followerId\)/);
  assert.match(sceneEngine, /setTimeout\(deliver, index \* 100\)/);
  assert.doesNotMatch(sceneEngine, /No pushPlaylistUpdate here/);
});

test('players reconcile missed playlist pushes by stable revision within seconds', () => {
  const server = read('server/ws/deviceSocket.js');
  const player = read('server/player/index.html');

  assert.match(server, /payload\.playlist_revision = crypto\.createHash\('sha256'\)/);
  assert.match(server, /socket\.on\('device:playlist-sync'/);
  assert.match(server, /appliedRevision !== payload\.playlist_revision/);
  assert.match(player, /socket\.emit\('device:playlist-sync'/);
  assert.match(player, /playlist_revision: appliedPlaylistRevision/);
  assert.match(player, /}, 3000\);/);
});

test('playlist reconnect payload carries authoritative display restore state', () => {
  const source = read('server/ws/deviceSocket.js');
  assert.match(source, /function displayStateForDevice\(deviceId\)/);
  assert.match(source, /function restoreStateForDevice\(deviceId, device, wall, layoutGroup\)/);
  assert.match(source, /restore_source: 'layout_group_leader'/);
  assert.match(source, /display_state: restoreStateForDevice\(deviceId, device, wall, layoutGroup\)/);
  assert.match(source, /layout_context: layoutGroup \? \{/);
});

test('delivered group blank commands persist the screen state shown by the dashboard', () => {
  const source = read('server/routes/device-groups.js');

  assert.match(source, /const screenState = type === 'screen_on' \? 1 : type === 'screen_off' \? 0 : null/);
  assert.match(source, /UPDATE devices SET screen_on = \?, updated_at = strftime\('%s','now'\) WHERE id = \?/);
  assert.match(source, /deviceNs\.to\(device\.id\)\.emit\('device:command'[^\n]+\);\s+if \(updateScreenState\) updateScreenState\.run\(screenState, device\.id\)/);
});
