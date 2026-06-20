const fs = require('fs');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

test('podium camera uses the clean raw 720p mode and stable ALSA card name', () => {
  const compose = fs.readFileSync(
    path.join(__dirname, '..', 'deploy', 'camera', 'compose.yaml'),
    'utf8'
  );

  assert.match(compose, /- yuyv422/);
  assert.match(compose, /- "10"/);
  assert.match(compose, /1280x720/);
  assert.match(compose, /hw:C920,0/);
  assert.match(compose, /\+discardcorrupt\+nobuffer/);
});
