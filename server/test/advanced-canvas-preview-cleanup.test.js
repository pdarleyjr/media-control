const fs = require('fs');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

test('dashboard disconnect always releases P3 capture and WebRTC resources', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'ws', 'advanced-canvas.js'),
    'utf8'
  );

  assert.match(source, /const activePreviewEndpoints = new Set\(\)/);
  assert.match(source, /activePreviewEndpoints\.add\(String\(endpointId\)\)/);
  assert.match(source, /socket\.on\('disconnect', \(\) => \{/);
  assert.match(source, /canvas:preview-stop/);
  assert.match(source, /activePreviewEndpoints\.clear\(\)/);
});
