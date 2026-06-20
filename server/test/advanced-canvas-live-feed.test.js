const fs = require('fs');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

test('P3 WebRTC feed is embedded in the room canvas and starts automatically', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '..', '..', 'frontend', 'js', 'views', 'media-control', 'advanced-canvas.js'),
    'utf8'
  );

  assert.match(source, /class="mc-canvas-live-video" data-canvas-video/);
  assert.doesNotMatch(source, /data-canvas-preview/);
  assert.match(source, /render\(instance\);\s*startPreview\(instance\);/);
  assert.match(source, /schedulePreviewRestart/);
});
