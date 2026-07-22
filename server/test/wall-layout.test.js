const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  legacyLayout,
  parseStoredLayout,
  presetGroups,
  validateLayout,
  groupForDevice,
} = require('../lib/wall-layout');
const fs = require('node:fs');
const path = require('node:path');

const wall = { id: 'wall-1', layout_mode: 'span', layout_revision: 4, leader_device_id: 'tv1', playlist_id: 'wall-playlist' };
const members = [
  { device_id: 'tv3', grid_col: 2, grid_row: 0, playlist_id: 'p3', device_name: 'TV 3' },
  { device_id: 'tv1', grid_col: 0, grid_row: 0, playlist_id: 'p1', device_name: 'TV 1' },
  { device_id: 'tv2', grid_col: 1, grid_row: 0, playlist_id: 'p2', device_name: 'TV 2' },
];

test('legacy span and split layouts preserve existing behavior', () => {
  const span = legacyLayout(wall, members);
  assert.equal(span.preset, 'span-all');
  assert.deepEqual(span.groups[0].member_ids, ['tv1', 'tv2', 'tv3']);
  assert.equal(span.groups[0].layout, 'span');
  assert.equal(span.groups[0].leader_device_id, 'tv1');
  assert.equal(span.groups[0].playlist_id, 'wall-playlist');

  const split = legacyLayout({ ...wall, layout_mode: 'split' }, members);
  assert.equal(split.preset, 'split-all');
  assert.deepEqual(split.groups.map((group) => group.member_ids), [['tv1'], ['tv2'], ['tv3']]);
  assert.deepEqual(split.groups.map((group) => group.playlist_id), ['p1', 'p2', 'p3']);
});

test('three-display presets create both supported hybrid layouts', () => {
  assert.deepEqual(presetGroups(wall, members, 'span-left').map((group) => group.member_ids), [['tv1', 'tv2'], ['tv3']]);
  assert.deepEqual(presetGroups(wall, members, 'span-right').map((group) => group.member_ids), [['tv1'], ['tv2', 'tv3']]);
  assert.deepEqual(presetGroups(wall, members, 'span-all').map((group) => group.member_ids), [['tv1', 'tv2', 'tv3']]);
  assert.deepEqual(presetGroups(wall, members, 'split-all').map((group) => group.member_ids), [['tv1'], ['tv2'], ['tv3']]);
});

test('layout validation rejects cross-wall, duplicate, missing and noncontiguous members', () => {
  assert.throws(() => validateLayout(wall, members, { groups: [{ member_ids: ['tv1', 'other'], layout: 'span' }] }), /not a member/);
  assert.throws(() => validateLayout(wall, members, { groups: [{ member_ids: ['tv1'], layout: 'solo' }, { member_ids: ['tv1', 'tv2', 'tv3'], layout: 'span' }] }), /more than one/);
  assert.throws(() => validateLayout(wall, members, { groups: [{ member_ids: ['tv1', 'tv2'], layout: 'span' }] }), /Every wall display/);
  assert.throws(() => validateLayout(wall, members, { groups: [{ member_ids: ['tv1', 'tv3'], layout: 'span' }, { member_ids: ['tv2'], layout: 'solo' }] }), /contiguous/);
});

test('stored layout parsing is versioned and resolves subgroup authority', () => {
  const groups = presetGroups(wall, members, 'span-left');
  const storedWall = { ...wall, layout_revision: 9, layout_json: JSON.stringify({ version: 1, preset: 'span-left', groups }) };
  const layout = parseStoredLayout(storedWall, members);
  assert.equal(layout.version, 1);
  assert.equal(layout.revision, 9);
  assert.equal(layout.preset, 'span-left');
  assert.equal(groupForDevice(layout, 'tv2').leader_device_id, 'tv1');
  assert.equal(groupForDevice(layout, 'tv3').layout, 'solo');
});

test('preset identity is derived from ordered member ids, not group lengths', () => {
  const left = validateLayout(wall, members, { groups: presetGroups(wall, members, 'span-left') });
  const right = validateLayout(wall, members, { groups: presetGroups(wall, members, 'span-right') });
  assert.equal(left.preset, 'span-left');
  assert.equal(right.preset, 'span-right');

  const mislabeled = validateLayout(wall, members, {
    preset: 'span-left',
    groups: presetGroups(wall, members, 'span-right'),
  });
  assert.equal(mislabeled.preset, 'span-right');
});

test('layout endpoint uses optimistic revision checks and one atomic transaction', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'routes', 'video-walls.js'), 'utf8');
  assert.match(source, /router\.put\('\/:id\/layout', requireWallWrite/);
  assert.match(source, /LAYOUT_REVISION_CONFLICT/);
  assert.match(source, /const tx = db\.transaction\(\(\) => \{/);
  assert.match(source, /SET layout_mode = \?, layout_json = \?, layout_revision = \?/);
  assert.match(source, /pushToWallMembers\(req, wall\.id\)/);
});

test('player payload scopes sync and state to the persisted subgroup', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'ws', 'deviceSocket.js'), 'utf8');
  assert.match(source, /memberIds: layoutGroup\.member_ids/);
  assert.match(source, /layout_assignment: layoutAssignment/);
  assert.match(source, /logical_canvas \+ viewport/);
  assert.match(source, /group_member_ids: layoutGroup\.member_ids/);
  assert.match(source, /group_id: layoutGroup\.id/);
  assert.match(source, /wallDevices = group\.member_ids\.filter/);
  assert.match(source, /layout_context: layoutGroup \? \{/);
});
