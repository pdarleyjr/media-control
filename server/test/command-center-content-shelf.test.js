'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..', '..');

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

test('Command Center Content Library uses a fixed bottom shelf without a modal backdrop', () => {
  const view = read('frontend/js/views/media-control.js');
  const css = read('frontend/css/media-control.css');

  assert.match(view, /id="mc-library-drawer"/);
  assert.match(view, /class="mc-library-body"[\s\S]*?id="mc-toolbox"/);
  assert.doesNotMatch(view, /mc-library-backdrop|data-library-backdrop/);
  assert.match(css, /--mc-library-collapsed-h:\s*48px/);
  assert.match(css, /--mc-library-expanded-h:\s*clamp\(220px,\s*40dvh,\s*360px\)/);
  assert.match(css, /\.mc-cc-body \.mc-library-drawer\s*\{[\s\S]*?position:\s*fixed;[\s\S]*?left:[\s\S]*?right:\s*0;[\s\S]*?bottom:\s*0;/);
  assert.match(css, /\.mc-cc-body \.mc-library-drawer\[data-open="false"\]\s*\{[\s\S]*?translateY/);
  assert.doesNotMatch(css, /\.mc-cc-body \.mc-library-drawer\[data-open="false"\][^{]*\{[^}]*translateX/);
});

