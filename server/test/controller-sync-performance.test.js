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

test('media control drag drop coalesces refreshes and throttles preview screenshots', () => {
  const source = read('frontend/js/views/media-control.js');
  assert.match(source, /const PREVIEW_REQUEST_MIN_MS = 8000/);
  assert.match(source, /function scheduleDisplayStateRefresh/);
  assert.match(source, /function queuePreviewRequests/);
  assert.match(source, /displayState\.refresh\(\)\.catch/);
  assert.match(source, /setInterval\(requestVisiblePreviews, 60000\)/);
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

test('document previews prefer live screenshots over static posters after slide changes', () => {
  const main = read('frontend/js/views/media-control.js');
  const stage = read('frontend/js/views/media-control/stage.js');

  assert.match(stage, /function shouldPreferPoster\(obj\)/);
  assert.match(stage, /kind === 'document' \|\| kind === 'pdf'/);
  assert.match(stage, /if \(currentScreenshot && !shouldPreferPoster\(obj\)\)/);
  assert.match(main, /img\.classList\.contains\('mc-shot-poster'\)/);
});

test('dashboard never lets an old screenshot override newer authoritative display state', () => {
  const stage = read('frontend/js/views/media-control/stage.js');

  assert.match(stage, /function screenshotMatchesCurrentState\(obj\)/);
  assert.match(stage, /obj\?\.state_updated_at \?\? obj\?\.live_state\?\.state_updated_at/);
  assert.match(stage, /capturedAt >= stateUpdatedAt/);
  assert.match(stage, /const currentScreenshot = obj && obj\.screenshot_url && screenshotMatchesCurrentState\(obj\)/);
  assert.match(stage, /state_updated_at: live\.state_updated_at \?\? live\.live_state\?\.state_updated_at/);
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
  assert.match(player, /data\.__mc_screenshot\.length <= 2 \* 1024 \* 1024/);
  assert.match(player, /image_b64: data\.__mc_screenshot/);
  assert.match(player, /setTimeout\(captureAndSend, 1200\)/);
  assert.match(player, /setTimeout\(captureAndSend, 6000\)/);
});

test('server requests fresh previews after delivered content changes', () => {
  const sceneEngine = fs.readFileSync(path.join(__dirname, '..', 'services', 'scene-engine.js'), 'utf8');
  assert.match(sceneEngine, /if \(result && result\.delivered\)/);
  assert.match(sceneEngine, /for \(const delay of \[1500, 6500\]\)/);
  assert.match(sceneEngine, /emit\('device:screenshot-request'/);
  assert.match(sceneEngine, /reason: 'content-changed'/);
});

test('playlist reconnect payload carries authoritative display restore state', () => {
  const source = read('server/ws/deviceSocket.js');
  assert.match(source, /function displayStateForDevice\(deviceId\)/);
  assert.match(source, /function restoreStateForDevice\(deviceId, device, wall\)/);
  assert.match(source, /restore_source: 'wall_leader'/);
  assert.match(source, /display_state: restoreStateForDevice\(deviceId, device, wall\)/);
});
