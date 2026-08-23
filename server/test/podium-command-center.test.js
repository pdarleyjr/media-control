const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function read(relativePath) {
  return fs.readFileSync(path.resolve(__dirname, '../..', relativePath), 'utf8');
}

test('target selector exposes direct touch controls for pinned walls and a dropdown for the rest', () => {
  const selector = read('frontend/js/views/media-control/target-selector.js');

  // Quick-focus tabs render wall buttons with tab semantics (aria-selected).
  assert.match(selector, /class="mc-target-wall-tabs"/);
  assert.match(selector, /role="tab"/);
  assert.match(selector, /data-target-value="\$\{esc\(ref\)\}"/);
  assert.match(selector, /aria-selected=/);
  assert.match(selector, /activateValue\(button\.dataset\.targetValue/);
  // The dropdown carries every remaining authorized target (unpinned walls +
  // groups + displays), so no wall is unreachable.
  assert.match(selector, /mc-target-select/);
  assert.match(selector, /remainingWalls/);
});

test('podium command center occupies only the viewport below the appliance header', () => {
  const css = read('frontend/css/console.css');

  assert.match(css, /body\.console-mode\.cc-fullscreen \.content\s*\{[\s\S]*?position:\s*fixed/);
  assert.match(css, /inset:\s*var\(--console-header-h\) 0 0/);
  assert.match(css, /body\.console-mode\.cc-fullscreen \.mc-cc-shell\s*\{[\s\S]*?height:\s*100%/);
  assert.match(css, /touch-action:\s*pan-y/);
  assert.match(css, /body\.console-mode select\s*\{[\s\S]*?min-height:\s*52px/);
  assert.match(css, /body\.console-mode select option\s*\{[\s\S]*?font-size:\s*18px/);
  assert.match(css, /body\.console-mode \.mc-target-wall-btn[\s\S]*?min-height:\s*52px/);
});

test('multiview remains reachable inside the fixed command center viewport', () => {
  const css = read('frontend/css/media-control.css');
  const view = read('frontend/js/views/media-control.js');

  assert.match(css, /\.mc-multiview-host:not\(\[hidden\]\)\s*\{[\s\S]*?position:\s*fixed;[\s\S]*?overflow-y:\s*auto;/);
  assert.match(css, /\.mc-multiview-host:not\(\[hidden\]\)\s*\{[\s\S]*?touch-action:\s*pan-y;/);
  assert.match(css, /\.mc-multiview-host \.mc-mv-stage\s*\{[\s\S]*?100dvh/);
  assert.match(view, /id="mc-multiview"[\s\S]*?role="dialog"[\s\S]*?aria-modal="true"/);
  assert.match(view, /event\.key === 'Escape'/);
});

test('podium library drag and drop preserves the source contract through physical wall verification', () => {
  const toolbox = read('frontend/js/views/media-control/toolbox.js');
  const stage = read('frontend/js/views/media-control/stage.js');
  const view = read('frontend/js/views/media-control.js');
  const smoke = read('scripts/live-console-ui-smoke.js');

  assert.match(toolbox, /draggable="true"[\s\S]*?data-drag-source=/);
  assert.match(toolbox, /addEventListener\('dragstart'[\s\S]*?application\/x-mc-source/);
  assert.match(view, /\.mc-wall-all\[data-wall-ids\][\s\S]*?addEventListener\('drop'/);
  assert.match(stage, /mc-wall-groups-overview[\s\S]*?class="mc-wall-all"[\s\S]*?data-wall-id="\$\{esc\(wall\.id\)\}"/);
  assert.match(stage, /data-wall-id="\$\{esc\(wall\.id\)\}" data-wall-ids="\$\{esc\(wallMemberIds\)\}"/);
  assert.match(view, /zone\.dataset\.wallId \|\| zone\.closest\('\.mc-wall\[data-wall-id\]'\)/);
  assert.match(smoke, /new DragEvent\('dragstart'/);
  assert.match(smoke, /new DragEvent\('drop'/);
  assert.match(smoke, /SMOKE_DRAG_CONTENT_ID/);
  assert.match(smoke, /SMOKE_DRAG_SOURCE_LABEL/);
  assert.match(smoke, /SMOKE_DRAG_GROUP_ID/);
  assert.match(smoke, /SMOKE_DRAG_LAYOUT_REVISION/);
  assert.match(smoke, /SMOKE_DRAG_NON_TARGET_DEVICE_IDS/);
  assert.match(smoke, /dragConfig\.contentId\.toLowerCase\(\) === 'auto'/);
  assert.match(smoke, /configured drag source is not visible/);
  assert.match(smoke, /pointerType: 'touch'/);
  assert.match(smoke, /touch_probe_state/);
  assert.match(smoke, /touch_restored_state/);
  assert.match(smoke, /convergence_ms: Date\.now\(\) - dragStartedAt/);
  assert.match(smoke, /touch_convergence_ms: Date\.now\(\) - touchStartedAt/);
  assert.match(smoke, /waitForPhysicalContent\(db, dragConfig\.deviceIds, dragConfig\.contentId\)/);
  assert.match(smoke, /waitForPhysicalSource\(db, dragConfig\.deviceIds/);
  assert.match(smoke, /assertNonTargetImmutability\([\s\S]*?dragConfig\.nonTargetDeviceIds/);
  assert.match(smoke, /targets:\s*\[restoreTarget\]/);
  assert.match(smoke, /type:\s*'wall-group'/);
  assert.match(smoke, /layout_revision:\s*config\.layoutRevision/);
  assert.match(smoke, /restoreDragDropContent\(db, dragConfig, beforeState\)/);
  assert.match(smoke, /requiredRenderStates\.includes\(row\.render_state\)/);
  assert.match(smoke, /config\.restoreContentId,[\s\S]*?\['playing', 'paused'\]/);
  assert.match(smoke, /waitForRestoredStates\(db, beforeStates\)/);
  assert.match(smoke, /const timedMedia = \/\^\(video\|audio\)\$\/i\.test\(String\(expected\?\.content_type \|\| ''\)\)/);
  assert.match(smoke, /!timedMedia \|\| expected\?\.paused !== 1/);
  assert.match(smoke, /const token = generateAcceptanceToken\(user, target\.workspace_id\)/);
  assert.match(smoke, /restoreTransportState\(db, token, beforeStates\)/);
  assert.match(smoke, /mouse_to_touch_settle_ms:\s*2000/);
  assert.match(smoke, /await sleep\(dragDrop\.mouse_to_touch_settle_ms\)/);
  assert.match(smoke, /const timedMedia = \/\^\(video\|audio\)\$\/i/);
  assert.match(smoke, /const presentation = \/\^\(document\|presentation\|deck\)\$\/i/);
  assert.match(smoke, /if \(timedMedia && \(state\.muted === 1 \|\| state\.muted === 0\)\)/);
  assert.match(smoke, /state\.muted === 1 \? 'mute' : 'unmute'/);
  assert.match(smoke, /state\.paused === 1 \? 'pause' : 'play'/);
  assert.match(smoke, /action, command_id: envelope\.command_id, acknowledged_at: row\.ack_at/);
  assert.match(smoke, /FROM broadcast_requests br[\s\S]*?br\.source_type = 'remote_url'/);
  assert.match(smoke, /row\.current_content_id === expectedByDevice\.get\(row\.target_id\)/);
  assert.match(smoke, /row\.acknowledgment_state === 'confirmed'/);
  assert.match(smoke, /proveStableSourcePlayback\(db, dragConfig/);
  assert.match(smoke, /fs\.mkdtempSync\(path\.join\(os\.tmpdir\(\), 'mbfd-console-evidence-'\)\)/);
  assert.match(smoke, /fs\.constants\.O_EXCL/);
  assert.match(smoke, /fs\.openSync\(filePath, flags, 0o600\)/);
  assert.doesNotMatch(smoke, /writeFileSync\(screenshotPath/);
});

test('live console smoke opens its acceptance database before browser-driven writes', () => {
  const smoke = read('scripts/live-console-ui-smoke.js');
  const databaseOpen = smoke.indexOf('const dragDb = dragConfig ? openAcceptanceDatabase() : null;');
  const chromiumSpawn = smoke.indexOf('const child = spawn(chromium');

  assert.notEqual(databaseOpen, -1);
  assert.notEqual(chromiumSpawn, -1);
  assert.ok(databaseOpen < chromiumSpawn);
  assert.match(smoke, /function openAcceptanceDatabase\(\)[\s\S]*?better-sqlite3[\s\S]*?process\.env\.DB_PATH[\s\S]*?readonly:\s*true[\s\S]*?fileMustExist:\s*true/);
  assert.doesNotMatch(smoke, /require\('\.\.\/server\/db\/database'\)/);
  assert.doesNotMatch(smoke, /require\('\.\.\/server\/middleware\/auth'\)/);
  assert.match(smoke, /function generateAcceptanceToken\(user, currentWorkspaceId\)[\s\S]*?jsonwebtoken[\s\S]*?algorithm:\s*'HS256'[\s\S]*?expiresIn:\s*config\.jwtExpiry/);
  assert.match(smoke, /dragDb\?\.close\(\)/);
});

test('live console smoke selects the configured wall before looking for its drop target', () => {
  const smoke = read('scripts/live-console-ui-smoke.js');
  const configuredWallSelection = smoke.indexOf("const configuredWallTarget = `wall:${dragConfig.wallId}`;");
  const dragInventory = smoke.indexOf("const inventory = await waitFor(cdp");

  assert.notEqual(configuredWallSelection, -1);
  assert.notEqual(dragInventory, -1);
  assert.ok(configuredWallSelection < dragInventory);
  assert.match(smoke, /mc-target-wall-btn.*data-target-value[\s\S]*?configuredWallTarget[\s\S]*?button\.click\(\)/);
  assert.match(smoke, /configured wall target/);
});

test('grouped wall regions accept an exact typed drop instead of falling through to the room', () => {
  const stage = read('frontend/js/views/media-control/stage.js');
  const view = read('frontend/js/views/media-control.js');
  const smoke = read('scripts/live-console-ui-smoke.js');

  assert.match(stage, /class="mc-wall-region[\s\S]*?data-layout-group-id=[\s\S]*?data-wall-id=/);
  assert.match(view, /\.mc-wall-region\[data-layout-group-id\]\[data-wall-id\]/);
  assert.match(view, /const group = layoutGroupById\(region\.dataset\.layoutGroupId, region\.dataset\.wallId\)/);
  assert.match(view, /sendToPhysicalScope\([\s\S]*?group\.member_ids/);
  assert.match(view, /e\.stopPropagation\(\)/);
  assert.match(smoke, /\.mc-wall-region\[data-layout-group-id\]/);
});

test('target switching patches control state without a structural media loading cycle', () => {
  const view = read('frontend/js/views/media-control.js');
  assert.match(view, /function scheduleTargetPaint\(/);
  assert.match(view, /requestAnimationFrame\(/);
  assert.doesNotMatch(view, /mc-stage-target-loading/);
  assert.match(view, /if \(restoringTarget\) \{[\s\S]*?paintStage\(\);[\s\S]*?\} else \{[\s\S]*?scheduleTargetPaint\(\);/);
});

test('a late startup preference response cannot overwrite an operator target click', () => {
  const view = read('frontend/js/views/media-control.js');

  assert.match(view, /let targetIntentGeneration = 0/);
  assert.match(view, /if \(!restoringTarget\) targetIntentGeneration \+= 1/);
  assert.match(view, /const restoreGeneration = targetIntentGeneration/);
  assert.match(view, /targetIntentGeneration !== restoreGeneration/);
});

test('a startup preference response from an unmounted render cannot mutate a later render', () => {
  const view = read('frontend/js/views/media-control.js');

  assert.match(view, /let targetRestoreLifecycleGeneration = 0/);
  assert.match(view, /const restoreLifecycleGeneration = targetRestoreLifecycleGeneration/);
  assert.match(view, /targetRestoreLifecycleGeneration !== restoreLifecycleGeneration/);
  assert.match(view, /targetRestoreLifecycleGeneration \+= 1/);
});

test('Multiview contains its own mouse, touch, and keyboard content picker', () => {
  const multiview = read('frontend/js/views/media-control/multiview.js');
  const css = read('frontend/css/media-control.css');
  const smoke = read('scripts/live-console-ui-smoke.js');

  assert.match(multiview, /function sourceLibraryHtml\(/);
  assert.match(multiview, /data-mv-source/);
  assert.match(multiview, /data-mv-add/);
  assert.match(multiview, /sourceButton\.addEventListener\('click'/);
  assert.match(multiview, /sourceButton\.addEventListener\('dragstart'/);
  assert.match(multiview, /selectedSlot/);
  assert.match(multiview, /if \(source\.playlist_id\) return/);
  assert.match(multiview, /Object\.entries\(contentIndex \|\| \{\}\)\.forEach/);
  assert.match(css, /\.mc-mv-library/);
  assert.match(css, /\.mc-mv-slot-add\s*\{[^}]*min-height:\s*48px/);
  assert.match(smoke, /multiview_content_added/);
  assert.match(smoke, /dialog\.mc-target-picker\[open\]/);
  assert.match(smoke, /\.mc-target-picker-scroll/);
  assert.match(smoke, /\[data-target-cancel\]/);
});

test('podium touch drag uses pointer events while preserving desktop drag and drop', () => {
  const toolbox = read('frontend/js/views/media-control/toolbox.js');
  const view = read('frontend/js/views/media-control.js');
  const css = read('frontend/css/media-control.css');

  assert.match(toolbox, /addEventListener\('pointerdown'/);
  assert.match(toolbox, /event\.pointerType === 'touch' \|\| event\.pointerType === 'pen'/);
  assert.match(toolbox, /new CustomEvent\('mc:source-drop'/);
  assert.match(view, /addEventListener\('mc:source-drop'/);
  assert.match(css, /\.mc-touch-drag-ghost/);
  assert.match(css, /@media \(pointer: coarse\)[\s\S]*?touch-action:\s*none/);
  assert.match(toolbox, /addEventListener\('dragstart'[\s\S]*?application\/x-mc-source/);
});

test('a split-wall tile selects only that member for transport controls', () => {
  const view = read('frontend/js/views/media-control.js');

  assert.match(view, /function selectStageDisplayTarget\(deviceId\)/);
  assert.match(view, /wall\.layout_mode === 'split'/);
  assert.match(view, /const target = \{ type: 'display', id: deviceId, supportsModes: false \}/);
  assert.match(view, /targetApi\.setActive\(target\)/);
  assert.match(view, /handleTargetChange\(target\)/);
  assert.match(view, /onSelect:\s*selectStageDisplayTarget/);
});

test('podium rail surfaces remain inside the persistent command center', () => {
  const view = read('frontend/js/views/media-control.js');
  const railStart = view.indexOf('function wireCommandRail(');
  const railEnd = view.indexOf('\nexport async function render(', railStart);
  const rail = view.slice(railStart, railEnd);

  assert.match(view, /import \* as downloadsView from '.\/downloads\.js'/);
  assert.match(view, /import \* as auditLogView from '.\/audit-log\.js'/);
  assert.match(view, /import \* as settingsView from '.\/settings\.js'/);
  assert.match(view, /data-mc-rail="admin"/);
  assert.match(rail, /openViewModal\(\{ title: 'Downloads', module: downloadsView \}\)/);
  assert.match(rail, /openViewModal\(\{ title: 'System Logs', module: auditLogView \}\)/);
  assert.match(rail, /openViewModal\(\{ title: 'Settings', module: settingsView \}\)/);
  assert.match(rail, /case 'cameras':[\s\S]*?openLibraryTab\('sources'\)/);
  assert.match(rail, /case 'multiview':[\s\S]*?actions\.onMultiview/);
  assert.match(rail, /case 'share':[\s\S]*?actions\.onShare/);
  assert.match(rail, /case 'schedules':[\s\S]*?schedulesView/);
  assert.match(view, /data-mc-rail="upload"/);
  assert.match(rail, /case 'upload':[\s\S]*?openUploadMediaModal\(\)/);
  assert.match(view, /data-quick-upload-input/);
  assert.doesNotMatch(rail, /window\.location\.hash = '#\/(?:downloads|audit|settings|)'/);
  assert.match(read('frontend/css/media-control.css'), /\.mc-target-choice\s*\{[\s\S]*?min-height:\s*58px/);
  assert.match(read('frontend/css/media-control.css'), /\.mc-cc-rail\s*\{[\s\S]*?overflow-y:\s*auto/);
});

test('a hybrid wall preset keeps the complete wall visible and selects a control region', () => {
  const view = read('frontend/js/views/media-control.js');

  assert.match(view, /const preferred = groups\.find\(\(group\) => group\.layout === 'span'/);
  assert.match(view, /activeControlTarget = preferred/);
  assert.match(view, /const wallTarget = \{ type: 'wall', id: wallId/);
  assert.match(view, /targetApi\.setActive\(wallTarget\)/);
  assert.doesNotMatch(view, /function chooseInitialTarget\(\)[\s\S]*?w\?\.layout_mode === 'groups'[\s\S]*?return \{[\s\S]*?type: 'group'/);
});

test('hybrid wall previews render both subgroup regions with independent controls', () => {
  const stage = read('frontend/js/views/media-control/stage.js');

  assert.match(stage, /function wallGroupsCard\(wall, byId/);
  assert.match(stage, /data-layout-group-id=/);
  assert.match(stage, /data-wall-ids=/);
  assert.match(stage, /onSelectGroup/);
  assert.match(stage, /w\.layout_mode === 'groups'/);
});

test('live podium preview does not duplicate work with one-second screenshots', () => {
  const view = read('frontend/js/views/media-control.js');

  // Screenshot polling is routed through the instrumented poller; the active
  // tile cadence drops to the low-frequency background interval whenever the
  // live embedded preview is active (no per-second duplicate capture).
  assert.match(view, /activeIntervalMs: BACKGROUND_PREVIEW_INTERVAL_MS/);
  assert.match(view, /BACKGROUND_PREVIEW_INTERVAL_MS = 60000/);
});

test('web and podium navigation expose critical destinations and deterministic back behavior', () => {
  const index = read('frontend/index.html');
  const app = read('frontend/js/app.js');
  const view = read('frontend/js/views/media-control.js');

  for (const label of ['Upload &amp; Media', 'Share My Screen', 'Cameras', 'Multiview', 'Schedules', 'Video Walls']) {
    assert.match(index, new RegExp(label));
  }
  assert.match(app, /window\.mcBack = \(\) =>/);
  assert.match(app, /id="consoleBackButton"/);
  assert.match(app, /routeAbortController\?\.abort\(\)/);
  assert.match(app, /generation !== routeGeneration/);
  assert.match(view, /LAST_TARGET_KEY/);
  assert.match(view, /signal\?\.aborted/);
});

test('USB import lets the podium operator choose the owning account', () => {
  const app = read('frontend/js/app.js');

  assert.match(app, /id="consoleUsbProfile"/);
  assert.match(app, /Import into account/);
  assert.match(app, /async function activateConsoleProfile\(profileId\)/);
  assert.match(app, /await activateConsoleProfile\(profileId\)/);
  assert.match(app, /importSelectedUsbFiles\(selected, body, profileId\)/);
});

test('podium browser smoke exercises both whiteboard modes and a real pointer stroke', () => {
  const smoke = read('scripts/live-console-ui-smoke.js');

  assert.match(smoke, /\[data-mc-rail="upload"\]/);
  assert.match(smoke, /\[data-quick-upload-input\]/);
  assert.match(smoke, /\[data-mc-rail="whiteboard"\]/);
  assert.match(smoke, /\[data-wb-mode="blank"\]/);
  assert.match(smoke, /\[data-wb-mode="overlay"\]/);
  assert.match(smoke, /new PointerEvent\(type/);
  assert.match(smoke, /drawing_changed:/);
  assert.match(smoke, /#mc-wb-clear/);
  assert.match(smoke, /#mc-wb-close/);
});

test('podium browser smoke clicks both hybrid presets and restores the original wall mode', () => {
  const smoke = read('scripts/live-console-ui-smoke.js');

  assert.match(smoke, /SMOKE_HYBRID_LAYOUTS/);
  assert.match(smoke, /for \(const preset of \['span-left', 'span-right'\]\)/);
  assert.match(smoke, /waitForHybridPreset\(cdp, preset\)/);
  assert.match(smoke, /data-layout-group-id/);
  assert.match(smoke, /finally \{[\s\S]*data-ss-mode=/);
  assert.match(smoke, /hybrid_layouts: hybridLayouts/);
});

test('browser smoke can validate the normal signed-in web UI', () => {
  const smoke = read('scripts/live-console-ui-smoke.js');

  assert.match(smoke, /SMOKE_LOGIN_IDENTIFIER/);
  assert.match(smoke, /SMOKE_LOGIN_PASSWORD/);
  assert.match(smoke, /createWebSession/);
  assert.match(smoke, /Page\.addScriptToEvaluateOnNewDocument/);
  assert.match(smoke, /localStorage\.setItem\('token'/);
  assert.match(smoke, /auth_mode: webSession \? 'web-login' : 'podium-device'/);
});

test('podium browser smoke follows authorized wall targets without hardcoded room names', () => {
  const smoke = read('scripts/live-console-ui-smoke.js');

  assert.match(smoke, /SMOKE_EXPECT_WALL_TARGETS/);
  assert.match(smoke, /ready\.length < 2/);
  assert.match(smoke, /button\.dataset\.targetValue === \$\{JSON\.stringify\(targetValue\)\}/);
  assert.match(smoke, /button\.getAttribute\('aria-selected'\) === 'true'/);
  assert.doesNotMatch(smoke, /Video Wall 1 target is missing/);
  assert.doesNotMatch(smoke, /Video Wall 2 target is missing/);
});

test('command center visual snapshots wait for the asynchronous layout to settle', () => {
  const mobile = read('server/e2e/real-app/mobile-defect.spec.js');
  const visualBlock = mobile.match(/test\(`Command Center visual regression[\s\S]*?await context\.close\(\);/i)?.[0] || '';

  assert.match(mobile, /async function waitForCommandCenterVisualReady/);
  assert.match(mobile, /\.mc-cam-health-label/);
  assert.match(mobile, /\[data-live-state\]/);
  assert.match(mobile, /document\.fonts\.ready/);
  assert.match(mobile, /stableSamples >= 4/);
  assert.match(visualBlock, /waitForCommandCenterVisualReady\(page\)/);
  assert.doesNotMatch(visualBlock, /waitForTimeout\(500\)/);
  assert.match(visualBlock, /maxDiffPixelRatio:\s*0\.01/);
});
