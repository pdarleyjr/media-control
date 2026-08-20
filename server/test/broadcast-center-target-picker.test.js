const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '../../frontend/js/views/broadcast-center.js'), 'utf8');

test('Broadcast Center uses typed authoritative topology targets instead of raw device selection', () => {
  assert.match(source, /waitForTargetCatalog\(\{ includeVirtualDisplays: false \}\)/);
  assert.match(source, /openTargetPicker\(\{/);
  assert.match(source, /expandTargetsToDeviceIds/);
  assert.match(source, /targets: selectedTypedTargets\(\)/);
  assert.match(source, /targetReferences = selection\.references/);
  assert.match(source, /api\.files\.broadcast\(sel\.id, undefined, \{ targets: selectedTypedTargets\(\) \}\)/);
  assert.match(source, /allowIndividualWallMembers: false/);
  assert.doesNotMatch(source, /api\.getDevices\(\)/);
  assert.doesNotMatch(source, /data-all=/);
});

test('Broadcast Center shows and transmits Live Program only through explicit selection', () => {
  assert.match(source, /liveProgramSelected\(\)/);
  assert.match(source, /include_live_stream/);
  assert.match(source, /allowLiveProgram: sel\.type !== 'nc_file'/);
  assert.match(source, /Live Program explicitly selected/);
});

test('Broadcast Center sends presentations through the canonical presentation id contract', () => {
  assert.match(source, /payload\.presentation_id = sel\.id/);
  assert.doesNotMatch(source, /payload\.remote_url = `\$\{location\.origin\}\/player\/deck\/\$\{sel\.id\}`/);
});

test('Broadcast Center preserves rapid transport intent while player state catches up', () => {
  assert.match(source, /createTransportIntentTracker/);
  assert.match(source, /roomState\.getDisplay\(ids\[0\]\)\?\.now_playing/);
  assert.match(source, /transportIntentTracker\.resolve\(intentKey, ctl, playback\)/);
  assert.match(source, /sendCommand\(id, 'transport', \{ \.\.\.intent\.payload, action: intent\.action \}\)/);
  assert.match(source, /transportIntentTracker\.settle\(intentKey, intent\.sequence/);
});
