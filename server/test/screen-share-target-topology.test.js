const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(
  path.join(__dirname, '../../frontend/js/views/screen-share.js'),
  'utf8',
);

test('screen share targets come from the authoritative catalog, not racing device and wall endpoints', () => {
  assert.match(source, /waitForTargetCatalog\(\{ includeVirtualDisplays: false \}\)/);
  assert.doesNotMatch(source, /apiGet\('\/api\/(?:devices|walls)'\)/);
  assert.match(source, /catalog\.standaloneDisplays/);
});

test('screen share wall cards report real operator topology and fail closed on missing geometry', () => {
  assert.match(source, /w\.layoutMode/);
  assert.match(source, /w\.dimensionsLabel/);
  assert.match(source, /revision \$\{w\.layoutRevision\}/);
  assert.match(source, /\$\{w\.onlineCount\}\/\$\{members\.length\} online/);
  assert.match(source, /Missing calibrated canvas geometry/);
});

test('screen share hides wall members and the virtual livestream from individual targets', () => {
  assert.match(source, /catalog\.standaloneDisplays/);
  assert.doesNotMatch(source, /Devices that are members of a wall are still individually targetable/);
  assert.match(source, /includeVirtualDisplays: false/);
});

test('screen share wall tiles use snapshot viewport geometry without a hardcoded resolution', () => {
  assert.match(source, /m\.viewport\.width/);
  assert.match(source, /m\.viewport\.height/);
  assert.doesNotMatch(source, /1280\s*[x×]\s*720/i);
});

