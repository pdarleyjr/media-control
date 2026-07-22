const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(
  path.join(__dirname, '../../frontend/js/views/presentations.js'),
  'utf8',
);

test('presentation action uses the authoritative topology picker', () => {
  assert.match(source, /waitForTargetCatalog\(\{ includeVirtualDisplays: false \}\)/);
  assert.match(source, /openTargetPicker\(\{/);
  assert.match(source, /allowIndividualWallMembers: false/);
  assert.doesNotMatch(source, /api\.getDevices\(\)/);
});

test('presentation keeps Live Program separate and passes the explicit server gate', () => {
  assert.match(source, /allowLiveProgram: true/);
  assert.match(source, /include_live_stream: selection\.includesLiveProgram/);
  assert.match(source, /device_ids: ids/);
  assert.match(source, /presentation_id: pid/);
});

