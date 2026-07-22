const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '../../frontend/js/views/media-control.js'), 'utf8');

test('Command Center view picker uses authoritative wall and standalone topology', () => {
  assert.match(source, /openAuthoritativeTargetPicker\(\{/);
  assert.match(source, /waitForTargetCatalog\(\{ includeVirtualDisplays: false \}\)/);
  assert.match(source, /selection: 'single'/);
  assert.match(source, /allowIndividualWallMembers: false/);
  assert.match(source, /allowLiveProgram: false/);
  assert.doesNotMatch(source, /mc-target-choice-list/);
});

test('Command Center screen share preselects a logical wall without exposing member TVs', () => {
  assert.match(source, /stagePreselectShareTarget\(\{ kind: 'wall', id: target\.id \}\)/);
  assert.doesNotMatch(source, /mc\.cc\.share\.member/);
  assert.doesNotMatch(source, /pickOptionDialog/);
});

