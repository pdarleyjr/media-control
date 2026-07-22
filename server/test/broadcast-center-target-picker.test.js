const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '../../frontend/js/views/broadcast-center.js'), 'utf8');

test('Broadcast Center uses typed authoritative topology targets instead of raw device selection', () => {
  assert.match(source, /waitForTargetCatalog\(\{ includeVirtualDisplays: false \}\)/);
  assert.match(source, /openTargetPicker\(\{/);
  assert.match(source, /expandTargetsToDeviceIds/);
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

