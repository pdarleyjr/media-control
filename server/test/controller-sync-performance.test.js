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

test('repeated room snapshots cannot create a dashboard target-selection event storm', () => {
  const client = read('frontend/js/socket.js');
  const server = read('server/ws/dashboardSocket.js');

  assert.match(
    client,
    /selectedTarget\?\.target_type === targetType[\s\S]*selectedTarget\?\.target_id === targetId[\s\S]*return/,
    'the browser should not re-emit an unchanged selected target during UI reconciliation',
  );
  assert.match(
    server,
    /socket\.currentTargetRoom === newRoom[\s\S]*socket\.currentTarget\?\.target_type === target_type[\s\S]*socket\.currentTarget\?\.target_id === target_id[\s\S]*return/,
    'the server should ignore unchanged joins from stale dashboard clients before logging',
  );
});

test('media control refreshes every visible logical preview without tying sessions to control selection', () => {
  const source = read('frontend/js/views/media-control.js');
  // Screenshot fallbacks remain bounded, while live sessions are derived from
  // every visible logical program rather than the selected control target.
  assert.match(source, /const BACKGROUND_PREVIEW_INTERVAL_MS = 60000/);
  assert.match(source, /buildLivePreviewTargets/);
  assert.match(source, /livePreviewTargetDeviceIds/);
  assert.doesNotMatch(source, /function activePreviewDeviceId/);
  assert.doesNotMatch(source, /livePreviewDeviceId/);
  assert.match(source, /function scheduleDisplayStateRefresh/);
  assert.match(source, /function queuePreviewRequests/);
  assert.match(source, /displayState\.refresh\(\)\.catch/);
  assert.match(source, /createScreenshotPoller\(\{/);
  assert.match(source, /screenshotPoller\.start\(\)/);
  assert.match(source, /screenshotPoller\.stop\(\)/);
  assert.match(source, /activeIntervalMs: BACKGROUND_PREVIEW_INTERVAL_MS/);
  assert.match(source, /backgroundIntervalMs: BACKGROUND_PREVIEW_INTERVAL_MS/);
  assert.match(source, /for \(const delay of \[350, 1400\]\)/);
  assert.match(
    source,
    /const ok = await sendToPhysicalScope\(\s*parsed\.source,\s*\[deviceId\],\s*parsed\.label,\s*DROP_DELIVERY_OPTIONS,\s*\)/,
  );
  assert.match(source, /if \(ok\) refreshAfterSend\(\[deviceId\]\)/);
});

test('span wall transport controls fan out to every wall member', () => {
  const main = read('frontend/js/views/media-control.js');
  const stage = read('frontend/js/views/media-control/stage.js');
  const transport = read('frontend/js/views/media-control/transport.js');

  assert.match(main, /function activeTargetTransportIds\(\)/);
  assert.match(main, /dispatchTransportTransaction\(/);
  // §8: stage cards are passive — they no longer carry transport ids. Fan-out to
  // every wall member is resolved centrally by activeTargetTransportIds() (which
  // calls wallTransportDeviceIds for a span wall) and sent as one transaction.
  assert.match(transport, /transportDeviceIds/);
  // Every member shares one idempotency key in one socket transaction; all
  // physical and Live Program acknowledgements are awaited together.
  assert.match(transport, /sendWorkspaceTransportTransaction/);
  assert.match(transport, /dashboard:transport-transaction/);
  assert.match(transport, /Promise\.all\(\(ack\.targets \|\| \[\]\)\.map/);
  assert.match(transport, /idempotency_key: transactionId/);
  // Rapid instructor clicks are resolved through an optimistic intent tracker,
  // which turns play/pause into explicit actions and keeps every slide tap.
  assert.match(transport, /createTransportIntentTracker/);
  assert.match(transport, /intentTracker\.resolve\(key, action/);
  assert.match(main, /createTransportIntentTracker/);
  assert.match(main, /intentTracker\.resolve\(intentKey, action, playback\)/);
});

test('an independently selected split-wall member remains renderable as a display target', () => {
  const main = read('frontend/js/views/media-control.js');
  const stage = read('frontend/js/views/media-control/stage.js');

  assert.match(main, /const displays = all\.filter\(\(d\) => !wallMemberIds\.has\(d\.id\)\)/);
  assert.match(stage, /wall-split:\$\{wall\.id\}:\$\{m\.id\}/);
  assert.match(main, /return isSplitWallMemberId\(d\.id\)/);
});

test('transport actions refresh state and force previews so dashboard mirrors slide changes', () => {
  const main = read('frontend/js/views/media-control.js');
  const stage = read('frontend/js/views/media-control/stage.js');
  const transport = read('frontend/js/views/media-control/transport.js');

  assert.match(main, /onTransportAction: \(ids\) => refreshAfterSend\(ids\)/);
  assert.match(main, /refreshAfterSend\(ids\)/);
  // §8: stage cards are passive — transport actions are issued by the centralized
  // toolbar (mountTransportRow → refreshAfterSend) and serialized through
  // transport.js sendTransportCommand, not from per-card handlers on the stage.
  assert.match(transport, /onTransportAction/);
  assert.match(transport, /if \(typeof onTransportAction === 'function'\) onTransportAction\(transportIds, resolvedAction/);
  assert.match(transport, /COMMAND_LIFECYCLE/);
});

test('presentation previews follow the authoritative physical slide state', () => {
  const main = read('frontend/js/views/media-control.js');
  const stage = read('frontend/js/views/media-control/stage.js');
  const livePreview = read('frontend/js/views/media-control/live-preview.js');
  const displayProjection = read('frontend/js/services/room-display-projection.js');
  const deck = read('server/player/deck.html');

  assert.match(stage, /function shouldPreferPoster\(obj\)/);
  assert.match(stage, /kind === 'document' \|\| kind === 'pdf'/);
  assert.match(stage, /if \(screenshot && !shouldPreferPoster\(obj\)\)/);
  assert.match(displayProjection, /if \(state\.slide_index != null\) nowPlaying\.slideIndex = state\.slide_index/);
  assert.match(displayProjection, /if \(state\.slide_count != null\) nowPlaying\.slideCount = state\.slide_count/);
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

test('embedded live playback is the default for every visible logical surface', () => {
  const livePreview = read('frontend/js/views/media-control/live-preview.js');
  const stage = read('frontend/js/views/media-control/stage.js');
  const grid = read('server/player/grid.html');

  // Live embed is the DEFAULT; screenshot-only is an explicit opt-out (?live_preview=0).
  assert.match(livePreview, /operator_preview=1/);
  assert.match(stage, /livePreviewTargets/);
  const main = read('frontend/js/views/media-control.js');
  assert.match(main, /const LIVE_EMBED_PREVIEWS = new URLSearchParams\(window\.location\.search\)\.get\('live_preview'\) !== '0'/);
  assert.match(main, /livePreviewTargets/);
  assert.doesNotMatch(main, /activePreviewDeviceId/);
  assert.match(main, /const PREVIEW_REQUEST_MIN_MS = 750/);
  assert.doesNotMatch(main, /ACTIVE_PREVIEW_INTERVAL_MS/);
  // §9: dashboard previews are PASSIVE — always muted, no native controls, no
  // pointer events, and NEVER request browser/classroom audio. The old
  // operator-gesture audio hook (enableLivePreviewAudio + audio_preview=1 +
  // child.__mcEnableAudio()) unmuted+played every preview on any touch — removed.
  assert.match(livePreview, /muted loop playsinline/);
  assert.match(livePreview, /pointer-events:none/);
  assert.doesNotMatch(livePreview, /audio_preview/);
  assert.doesNotMatch(livePreview, /enableLivePreviewAudio/);
  assert.doesNotMatch(livePreview, /video\.muted = false/);
  assert.doesNotMatch(main, /enableLivePreviewAudio/);
  assert.doesNotMatch(main, /previewAudioGestureHandler/);
  // The physical multiview grid still exposes its own audio hook for the TV
  // (legitimate when loaded AS the player); the dashboard just never activates it.
  assert.match(grid, /var operatorPreview = params\.get\('operator_preview'\) === '1'/);
  assert.match(grid, /var STAGGER_MS = operatorPreview \? 600 : 1500/);
});

test('selection state is patched in place and cannot participate in media DOM identity', () => {
  const main = read('frontend/js/views/media-control.js');
  const stage = read('frontend/js/views/media-control/stage.js');
  const signature = stage.match(/function stageRenderSignature[\s\S]*?return parts\.join\('\|'\);[\s\S]*?\}/)?.[0] || '';

  assert.doesNotMatch(main, /livePreviewDeviceId/);
  assert.doesNotMatch(signature, /activeControlTargetId|livePreviewDeviceId/);
  assert.match(stage, /function updateControlStateInPlace/);
  assert.match(stage, /function reconcilePreviewSlots/);
  assert.match(stage, /iframeNavigations/);
  assert.doesNotMatch(main, /mc-stage-target-loading/);
});

test('stage repaint identity includes the authored web player URL', () => {
  const main = read('frontend/js/views/media-control.js');
  const stage = read('frontend/js/views/media-control/stage.js');

  // Guest Computer and a live-news station are both kind=web. Their content
  // identity can arrive before the richer authored URL, so the later URL
  // reconciliation must rebuild the iframe rather than taking the
  // screenshot-only in-place path and leaving the prior source visible.
  assert.match(main, /const remoteUrl = np\.remoteUrl \|\| np\.remote_url \|\| ''/);
  assert.match(main, /return \[np\.kind \|\| '', np\.contentId \|\| '', remoteUrl,/);
  assert.match(stage, /remoteUrl: np\.remoteUrl \|\| np\.remote_url \|\| ''/);
  assert.match(stage, /data-mc-media-identity/);
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
  assert.match(main, /video\.play\(\)\.then/);
  assert.match(main, /data-mc-playback-error/);
  assert.match(main, /playRejections/);
});

test('camera status reports active sources continuously instead of a static idle label', () => {
  const dock = read('frontend/js/views/media-control/action-dock.js');

  assert.doesNotMatch(dock, /textContent = ['"]cams idle['"]/);
  assert.match(dock, /data\.active_source === 'anpviz'/);
  assert.doesNotMatch(dock, /active_camera/);
  assert.doesNotMatch(dock, /data\.director/);
  assert.match(dock, /mc\.cc\.camera\.active/);
  assert.match(dock, /setInterval\(\(\) => syncLive\(\), 5000\)/);
  // The health timer is null-guarded and destroyed on teardown.
  assert.match(dock, /destroy\(\) \{ if \(healthTimer\) \{ clearInterval\(healthTimer\); healthTimer = null; \} \}/);
  // Classroom Mode no longer suppresses polling — always polls (capability-driven).
  assert.match(dock, /isClassroomModeEnabled\(\)\.then/);
  assert.doesNotMatch(dock, /if \(classroomModeActive\) \{ syncingLive = false; return; \}/);
});

test('normal display routing never probes or mutates the live composition', () => {
  const dock = read('frontend/js/views/media-control/action-dock.js');
  const send = read('frontend/js/views/media-control/send.js');

  assert.match(dock, /let liveStateKnown = false/);
  assert.match(dock, /export function isLiveStateKnown\(\)/);
  assert.match(dock, /liveStateKnown = true/);
  assert.doesNotMatch(send, /isLiveActive|isLiveCompositionAvailable|isLiveStateKnown/);
  assert.doesNotMatch(send, /api\.liveStream\.(?:status|composition|compositionContent)/);
  assert.match(send, /include_live_stream: false/);
  assert.match(dock, /data-composition-add/);
});

test('live source catalog contains one camera identity while the canvas avoids obsolete ordinal presets', () => {
  const catalog = read('frontend/js/views/media-control/camera-feeds-catalog.js');
  const canvas = read('frontend/js/views/media-control/advanced-canvas.js');

  assert.match(catalog, /id:\s*'anpviz'/);
  assert.match(catalog, /id:\s*'guest-computer'/);
  assert.doesNotMatch(catalog, /Focus 210|ANNKE|WyreStorm|kamrui-camera-/i);
  assert.doesNotMatch(catalog, /Video Wall [12]/);
  assert.doesNotMatch(canvas, /data-canvas-preset="wall-[12]"/);
  assert.doesNotMatch(canvas, /data-canvas-camera="[12]"/);
  assert.match(canvas, /Anpviz camera/);
  assert.match(canvas, /source:\s*'anpviz'/);
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
  assert.match(displays, /contentVisibilityScope\(contextFromRequest\(req\), \{ alias: 'c' \}\)/);
  assert.match(displays, /posterStmt\.get\(np\.contentId, \.\.\.posterVisibility\.params\)/);
  assert.match(stage, /kind === 'image'[\s\S]*age > STALE_AFTER_S/);
  assert.match(stage, /content-bound poster is safer than pixels left over from the previous item/);
  assert.match(player, /img\.crossOrigin = 'anonymous'/);
  assert.match(player, /img\.addEventListener\('load'[\s\S]*captureAndSend\(\)/);
  assert.match(player, /mount\.appendChild\(img\);[\s\S]*img\.src = src/);
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
  assert.match(source, /const screenshotPersistChains = new Map\(\)/);
  assert.match(source, /async function persistScreenshot\(deviceId, imageB64, capturedAt\)/);
  assert.match(source, /await fs\.promises\.writeFile\(temporaryPath, buffer\)/);
  assert.match(source, /await fs\.promises\.rename\(temporaryPath, finalPath\)/);
  assert.match(source, /stale_screenshot/);
  assert.match(source, /UPDATE screenshots SET filepath = \?, captured_at = \? WHERE id = \?/);
  assert.match(source, /INSERT INTO screenshots \(device_id, filepath, captured_at\) VALUES \(\?, \?, \?\)/);
  assert.match(source, /await persistScreenshot\(device_id, image_b64, captured_at \?\? timestamp\)/);
  assert.doesNotMatch(source, /fs\.writeFileSync\(path\.join\(config\.screenshotsDir/);
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

  assert.match(player, /function requestIframeScreenshot\(correlationId = null\)/);
  assert.match(player, /typeof childWindow\.publishScreenshot === 'function'/);
  assert.match(player, /__mc_screenshot_request: true/);
  assert.match(player, /if \(requestIframeScreenshot\(correlationId\)\) return/);
});

test('server requests fresh previews after delivered content changes', () => {
  const sceneEngine = fs.readFileSync(path.join(__dirname, '..', 'services', 'scene-engine.js'), 'utf8');
  assert.match(sceneEngine, /if \(result && result\.delivered\)/);
  assert.match(sceneEngine, /for \(const delay of \[1500, 6500\]\)/);
  assert.match(sceneEngine, /emit\('device:screenshot-request'/);
  assert.match(sceneEngine, /reason: 'content-changed'/);
});

test('span broadcasts push revised playlists only to followers in the playback scope', () => {
  const sceneEngine = fs.readFileSync(path.join(__dirname, '..', 'services', 'scene-engine.js'), 'utf8');
  assert.match(sceneEngine, /memberIds = scope\.group\.member_ids/);
  assert.match(sceneEngine, /followers\.push\(followerId\)/);
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
  assert.match(source, /state_revision: ownState\?\.state_revision \?\? leaderState\.state_revision/);
  assert.match(source, /display_state: restoreStateForDevice\(deviceId, device, wall, layoutGroup\)/);
  assert.match(source, /layout_context: layoutGroup \? \{/);
});

test('delivered group blank commands wait for player-confirmed screen state', () => {
  const source = read('server/routes/device-groups.js');

  assert.match(source, /deviceContract\.createCommand/);
  assert.match(source, /envelope\.target_revision = cmd\.revision/);
  assert.doesNotMatch(source, /UPDATE devices SET screen_on/);
});
