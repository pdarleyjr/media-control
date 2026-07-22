'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.join(__dirname, '../..');
const schedulesPath = path.join(root, 'frontend/js/views/schedules.js');
const deviceDetailPath = path.join(root, 'frontend/js/views/device-detail.js');

function source(pathname) {
  return fs.readFileSync(pathname, 'utf8');
}

function loadPureFunction(view, name) {
  const match = view.match(new RegExp(`export function ${name}\\([^\\n]*\\) \\{[\\s\\S]*?^\\}`, 'm'));
  assert.ok(match, `${name} export should exist`);
  return Function(`${match[0].replace('export ', '')}; return ${name};`)();
}

test('schedules uses the authoritative picker and preserves the one-device-or-group API contract', () => {
  const view = source(schedulesPath);
  const scheduleTargetPayload = loadPureFunction(view, 'scheduleTargetPayload');

  assert.match(view, /import \{ openTargetPicker \} from '\.\.\/components\/target-picker\.js'/);
  assert.match(view, /import \{ waitForTargetCatalog \} from '\.\.\/services\/target-catalog-runtime\.js'/);
  assert.match(view, /selection:\s*'single'/);
  assert.match(view, /capability:\s*\(target\) => target\.type !== 'wall'/);
  assert.match(view, /allowIndividualWallMembers:\s*false/);
  assert.match(view, /allowLiveProgram:\s*false/);
  assert.match(view, /if \(target\.type === 'display'\) return \{ device_id: target\.id \}/);
  assert.match(view, /if \(target\.type === 'group'\) return \{ group_id: target\.id \}/);
  assert.doesNotMatch(view, /<select id="schTarget"/);
  assert.doesNotMatch(view, /target\.split\(':'\)/);
  assert.deepEqual(scheduleTargetPayload({ type: 'display', id: 'tv-7' }), { device_id: 'tv-7' });
  assert.deepEqual(scheduleTargetPayload({ type: 'group', id: 'instructors' }), { group_id: 'instructors' });
  assert.equal(scheduleTargetPayload({ type: 'wall', id: 'primary-wall' }), null);
});

test('device playlist copy replaces the numbered prompt with logical topology targets', () => {
  const view = source(deviceDetailPath);

  assert.match(view, /waitForTargetCatalog\(\{ includeVirtualDisplays: false \}, \{ requireFresh: true \}\)/);
  assert.match(view, /openTargetPicker\(\{/);
  assert.match(view, /selection:\s*'single'/);
  assert.match(view, /allowIndividualWallMembers:\s*false/);
  assert.match(view, /allowLiveProgram:\s*false/);
  assert.match(view, /copyPlaylistTargetIds\(selection, device\.id\)/);
  assert.match(view, /Promise\.allSettled\(targetIds\.map/);
  assert.doesNotMatch(view, /prompt\(t\('device\.copy\.prompt'/);
  assert.doesNotMatch(view, /others\[parseInt\(targetId\) - 1\]/);
});

test('copy playlist destination expansion deduplicates targets and never copies back to the source', () => {
  const view = source(deviceDetailPath);
  const copyPlaylistTargetIds = loadPureFunction(view, 'copyPlaylistTargetIds');

  assert.deepEqual(
    copyPlaylistTargetIds({ deviceIds: ['tv-1', 'tv-2', 'tv-2', '', 'tv-3'] }, 'tv-1'),
    ['tv-2', 'tv-3'],
  );
  assert.deepEqual(copyPlaylistTargetIds(null, 'tv-1'), []);
});
