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
