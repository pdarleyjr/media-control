const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('idle screen-share rendering cannot recurse between UI synchronizers', () => {
  const source = fs.readFileSync(
    path.resolve(__dirname, '../../frontend/js/views/screen-share.js'),
    'utf8'
  );

  assert.match(source, /function syncCaptureStoppedUI\(\{ refreshSessions = true \} = \{\}\)/);
  assert.match(source, /syncCaptureStoppedUI\(\{ refreshSessions: false \}\)/);
});
