const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function read(relativePath) {
  return fs.readFileSync(path.resolve(__dirname, '../..', relativePath), 'utf8');
}

test('target selector exposes direct touch controls for every video wall', () => {
  const selector = read('frontend/js/views/media-control/target-selector.js');

  assert.match(selector, /class="mc-target-wall-tabs"/);
  assert.match(selector, /data-target-value="wall:/);
  assert.match(selector, /aria-pressed=/);
  assert.match(selector, /activateValue\(button\.dataset\.targetValue/);
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
  const view = read('frontend/js/views/media-control.js');
  const smoke = read('scripts/live-console-ui-smoke.js');

  assert.match(toolbox, /draggable="true"[\s\S]*?data-drag-source=/);
  assert.match(toolbox, /addEventListener\('dragstart'[\s\S]*?application\/x-mc-source/);
  assert.match(view, /\.mc-wall-all\[data-wall-ids\][\s\S]*?addEventListener\('drop'/);
  assert.match(smoke, /new DragEvent\('dragstart'/);
  assert.match(smoke, /new DragEvent\('drop'/);
  assert.match(smoke, /SMOKE_DRAG_CONTENT_ID/);
  assert.match(smoke, /dragConfig\.contentId\.toLowerCase\(\) === 'auto'/);
  assert.match(smoke, /configured drag source is not visible/);
  assert.match(smoke, /pointerType: 'touch'/);
  assert.match(smoke, /touch_probe_state/);
  assert.match(smoke, /touch_restored_state/);
  assert.match(smoke, /convergence_ms: Date\.now\(\) - dragStartedAt/);
  assert.match(smoke, /touch_convergence_ms: Date\.now\(\) - touchStartedAt/);
  assert.match(smoke, /waitForPhysicalContent\(db, dragConfig\.deviceIds, dragConfig\.contentId\)/);
  assert.match(smoke, /restoreDragDropContent\(db, dragConfig\)/);
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
  assert.match(rail, /case 'cameras':[\s\S]*?openLibraryTab\('camerafeeds'\)/);
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

test('a hybrid wall preset immediately targets its spanned subgroup', () => {
  const view = read('frontend/js/views/media-control.js');

  assert.match(view, /const preferred = groups\.find\(\(group\) => group\.layout === 'span'/);
  assert.match(view, /type: 'group',[\s\S]*?wall_id: wallId/);
  assert.match(view, /targetApi\.setActive\(target\);[\s\S]*?handleTargetChange\(target\)/);
  assert.match(view, /function chooseInitialTarget\(\)[\s\S]*?w\?\.layout_mode === 'groups'[\s\S]*?type: 'group',[\s\S]*?wall_id: w\.id/);
});

test('live podium preview does not duplicate work with one-second screenshots', () => {
  const view = read('frontend/js/views/media-control.js');

  assert.match(view, /if \(!LIVE_EMBED_PREVIEWS\) \{[\s\S]*?setInterval\(requestActivePreview, ACTIVE_PREVIEW_INTERVAL_MS\)/);
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

test('browser smoke can validate the normal signed-in web UI', () => {
  const smoke = read('scripts/live-console-ui-smoke.js');

  assert.match(smoke, /SMOKE_LOGIN_IDENTIFIER/);
  assert.match(smoke, /SMOKE_LOGIN_PASSWORD/);
  assert.match(smoke, /createWebSession/);
  assert.match(smoke, /Page\.addScriptToEvaluateOnNewDocument/);
  assert.match(smoke, /localStorage\.setItem\('token'/);
  assert.match(smoke, /auth_mode: webSession \? 'web-login' : 'podium-device'/);
});
