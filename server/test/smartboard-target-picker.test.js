const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(
  path.join(__dirname, '../../frontend/js/views/smartboard.js'),
  'utf8',
);

test('Smartboard chooses one authoritative logical destination', () => {
  assert.match(source, /waitForTargetCatalog\(\{ includeVirtualDisplays: false \}, \{ requireFresh: true \}\)/);
  assert.match(source, /openTargetPicker\(\{/);
  assert.match(source, /capability: 'whiteboard'/);
  assert.match(source, /selection: 'single'/);
  assert.match(source, /allowIndividualWallMembers: false/);
  assert.match(source, /allowLiveProgram: false/);
  assert.match(source, /selection\.deviceIds\.filter/);
  assert.match(source, /selectedTarget\.onlineCount !== selectedTarget\.memberCount/);
  assert.doesNotMatch(source, /apiGet\('\/api\/devices'\)/);
  assert.doesNotMatch(source, /data-all=/);
  assert.doesNotMatch(source, /All displays \(whole room\)/);
});

test('Smartboard maps deep-linked wall members back to their logical wall', () => {
  assert.match(source, /function requestedTargetReference\(catalog, deviceId\)/);
  assert.match(source, /candidate\.members\.some\(\(member\) => member\.id === deviceId\)/);
  assert.match(source, /selectedTargets:/);
  assert.match(source, /targetLabel = selectedTarget\.topologyLabel/);
});
