const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(
  path.join(__dirname, '../../frontend/js/views/dashboard.js'),
  'utf8',
);

function functionSource(name, nextName) {
  const start = source.indexOf(`async function ${name}(`);
  const end = source.indexOf(`async function ${nextName}(`, start + 1);
  assert.notEqual(start, -1, `${name} must exist`);
  assert.notEqual(end, -1, `${nextName} must follow ${name}`);
  return source.slice(start, end);
}

test('dashboard quick broadcast uses the authoritative logical topology picker', () => {
  const picker = functionSource('openBroadcastPicker', 'doBroadcast');

  assert.match(source, /waitForTargetCatalog\(\{ includeVirtualDisplays: false \}\)/);
  assert.match(source, /openTargetPicker\(\{/);
  assert.match(picker, /capability: 'content'/);
  assert.match(picker, /selection: 'multiple'/);
  assert.match(picker, /allowIndividualWallMembers: false/);
  assert.match(picker, /allowLiveProgram: false/);
  assert.match(picker, /selection\.deviceIds/);
  assert.doesNotMatch(picker, /\[\.\.\.selectedDeviceIds\]/);
});

test('dashboard quick broadcast never mutates wall topology', () => {
  const picker = functionSource('openBroadcastPicker', 'doBroadcast');

  assert.doesNotMatch(picker, /api\.(?:updateWall|setWallDevices|setWallLayout|setWallContent)\s*\(/);
  assert.doesNotMatch(picker, /layout_mode|layoutMode|grid_cols|grid_rows/);
  assert.match(picker, /device_ids: ids/);
});

test('raw display selection remains a create-wall gesture, not a routing model', () => {
  assert.match(source, /id="broadcastBtn"[\s\S]{0,500}t\('mc\.target_picker\.title'\)/);
  assert.match(source, /id="selectionBar"[\s\S]*id="createWallBtn"/);
  assert.doesNotMatch(source, /id="selectionBar"[\s\S]{0,1000}id="broadcastBtn"/);
});
