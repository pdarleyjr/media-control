const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(
  path.join(__dirname, '../../frontend/js/views/media-control/multiview.js'),
  'utf8',
);

test('Multiview frame sharing uses the authoritative logical target picker', () => {
  assert.match(source, /waitForTargetCatalog\(\{ includeVirtualDisplays: false \}\)/);
  assert.match(source, /openTargetPicker\(\{/);
  assert.match(source, /capability: 'screen_share'/);
  assert.match(source, /selection: 'single'/);
  assert.match(source, /allowIndividualWallMembers: false/);
  assert.match(source, /allowLiveProgram: false/);
  assert.doesNotMatch(source, /displayState\.getAll\(\)/);
  assert.doesNotMatch(source, /data-pick-id/);
});

test('Multiview maps a logical wall through calibrated member geometry', () => {
  assert.match(source, /function frameShareTargets\(target, frameRect\)/);
  assert.match(source, /target\.type !== 'wall'/);
  assert.match(source, /member\.viewport/);
  assert.match(source, /target\.onlineCount !== target\.memberCount/);
  assert.match(source, /Promise\.allSettled/);
  assert.match(source, /screenShareEngine\.startBroadcastTo\(entry\.deviceId, \{ wallTile: entry\.wallTile \}\)/);
  assert.match(source, /screenShareEngine\.stopBroadcastTo\(deviceId\)/);
});
