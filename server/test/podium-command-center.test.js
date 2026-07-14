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
  assert.match(smoke, /waitForPhysicalContent\(db, dragConfig\.deviceIds, dragConfig\.contentId\)/);
  assert.match(smoke, /restoreDragDropContent\(db, dragConfig\)/);
});

test('podium browser smoke exercises both whiteboard modes and a real pointer stroke', () => {
  const smoke = read('scripts/live-console-ui-smoke.js');

  assert.match(smoke, /\[data-mc-rail="whiteboard"\]/);
  assert.match(smoke, /\[data-wb-mode="blank"\]/);
  assert.match(smoke, /\[data-wb-mode="overlay"\]/);
  assert.match(smoke, /new PointerEvent\(type/);
  assert.match(smoke, /drawing_changed:/);
  assert.match(smoke, /#mc-wb-clear/);
  assert.match(smoke, /#mc-wb-close/);
});
