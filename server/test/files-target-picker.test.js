const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '../../frontend/js/views/files.js'), 'utf8');

test('Nextcloud broadcast uses the shared authoritative wall-aware target picker', () => {
  assert.match(source, /waitForTargetCatalog\(\{ includeVirtualDisplays: false \}\)/);
  assert.match(source, /openTargetPicker\(\{/);
  assert.match(source, /allowIndividualWallMembers: false/);
  assert.match(source, /allowLiveProgram: false/);
  assert.match(source, /selection\.deviceIds/);
  assert.doesNotMatch(source, /api\.getDevices\(\)/);
  assert.doesNotMatch(source, /nc-bcast-devlist/);
});

