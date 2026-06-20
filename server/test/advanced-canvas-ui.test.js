const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('advanced canvas monitor keeps inactive media elements hidden', () => {
  const css = fs.readFileSync(
    path.resolve(__dirname, '../../frontend/css/media-control.css'),
    'utf8'
  );

  assert.match(css, /\.mc-canvas-video-wrap \[hidden\]\s*\{\s*display:\s*none;\s*\}/);
});
