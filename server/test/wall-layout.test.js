const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  legacyLayout,
  parseStoredLayout,
  presetGroups,
  validateLayout,
  groupForDevice,
  normalizeWallRegions,
  regionsFromLayoutZones,
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

test('wall layout remains data-driven when a sixth display is enrolled', () => {
  const sixMembers = Array.from({ length: 6 }, (_, index) => ({
    device_id: `tv${index + 1}`,
    grid_col: index,
    grid_row: 0,
    playlist_id: `p${index + 1}`,
    device_name: `TV ${index + 1}`,
  }));

  const spanned = validateLayout(wall, sixMembers, {
    groups: presetGroups(wall, sixMembers, 'span-all'),
  });
  assert.deepEqual(spanned.groups[0].member_ids, [
    'tv1', 'tv2', 'tv3', 'tv4', 'tv5', 'tv6',
  ]);

  const independent = validateLayout(
    { ...wall, layout_mode: 'split' },
    sixMembers,
    { groups: presetGroups(wall, sixMembers, 'split-all') },
  );
  assert.deepEqual(
    independent.groups.map((group) => group.member_ids),
    [['tv1'], ['tv2'], ['tv3'], ['tv4'], ['tv5'], ['tv6']],
  );
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

test('Mosaic wall regions normalize stable geometry and fail closed on stale or invalid topology', () => {
  const mosaicWall = { ...wall, layout_mode: 'split', layout_revision: 12 };
  const mosaicMembers = [{ ...members[0], device_id: 'mosaic-player' }];
  const input = {
    revision: 12,
    regions: [{
      id: 'front-left',
      name: 'Front Left',
      x: 0,
      y: 0,
      width: 50,
      height: 100,
      player_device_id: 'mosaic-player',
      zone_id: 'zone-front-left',
      fit_mode: 'cover',
      revision: 12,
    }],
  };

  assert.deepEqual(normalizeWallRegions(mosaicWall, mosaicMembers, input), [{
    id: 'front-left',
    name: 'Front Left',
    x: 0,
    y: 0,
    width: 50,
    height: 100,
    coordinate_system: 'normalized-percent',
    player_device_id: 'mosaic-player',
    zone_id: 'zone-front-left',
    z_index: 0,
    fit_mode: 'cover',
    enabled: true,
    revision: 12,
  }]);

  assert.throws(
    () => normalizeWallRegions(mosaicWall, mosaicMembers, {
      ...input,
      regions: [{ ...input.regions[0], revision: 11 }],
    }),
    /revision must match/,
  );
  assert.throws(
    () => normalizeWallRegions(mosaicWall, mosaicMembers, {
      ...input,
      regions: [{ ...input.regions[0], x: 75, width: 50 }],
    }),
    /exceeds the normalized canvas/,
  );
  assert.throws(
    () => normalizeWallRegions(mosaicWall, mosaicMembers, {
      ...input,
      regions: [{ ...input.regions[0], player_device_id: 'removed-player' }],
    }),
    /current wall member/,
  );
  assert.throws(
    () => normalizeWallRegions(mosaicWall, mosaicMembers, {
      ...input,
      regions: [
        input.regions[0],
        { ...input.regions[0], id: 'front-right', name: 'Front Right' },
      ],
    }),
    /zone .* appears more than once/i,
  );
});

test('stored authoritative layouts fail closed instead of falling back to legacy topology', () => {
  assert.throws(
    () => parseStoredLayout({ ...wall, layout_json: '{not-json' }, members),
    (error) => error && error.code === 'INVALID_STORED_WALL_LAYOUT',
  );
  assert.throws(
    () => parseStoredLayout({
      ...wall,
      layout_json: JSON.stringify({
        groups: [{ id: 'bad', member_ids: ['removed-device'], layout: 'solo' }],
      }),
    }, members),
    (error) => error && error.code === 'INVALID_STORED_WALL_LAYOUT',
  );
});

test('Mosaic zone synchronization authors stable authoritative regions from the player layout', () => {
  const mosaicWall = {
    id: 'mosaic',
    layout_mode: 'split',
    layout_revision: 20,
  };
  const mosaicMembers = [{
    device_id: 'front-center',
    grid_col: 0,
    grid_row: 0,
    device_name: 'Mosaic Player',
  }];
  const regions = regionsFromLayoutZones(mosaicWall, mosaicMembers, [
    {
      id: 'zone-left',
      name: 'Front Left',
      x_percent: 0,
      y_percent: 0,
      width_percent: 50,
      height_percent: 100,
      z_index: 0,
      fit_mode: 'cover',
    },
    {
      id: 'zone-right',
      name: 'Front Right',
      x_percent: 50,
      y_percent: 0,
      width_percent: 50,
      height_percent: 100,
      z_index: 1,
      fit_mode: 'contain',
    },
  ], { revision: 21 });

  assert.deepEqual(regions.map((region) => ({
    id: region.id,
    player: region.player_device_id,
    zone: region.zone_id,
    x: region.x,
    width: region.width,
    revision: region.revision,
  })), [
    {
      id: 'zone-left',
      player: 'front-center',
      zone: 'zone-left',
      x: 0,
      width: 50,
      revision: 21,
    },
    {
      id: 'zone-right',
      player: 'front-center',
      zone: 'zone-right',
      x: 50,
      width: 50,
      revision: 21,
    },
  ]);
  assert.throws(
    () => regionsFromLayoutZones(mosaicWall, mosaicMembers, [], { revision: 21 }),
    /at least one layout zone/i,
  );
  assert.throws(
    () => regionsFromLayoutZones(mosaicWall, [...mosaicMembers, { device_id: 'other' }], [{
      id: 'zone',
      name: 'Zone',
      x_percent: 0,
      y_percent: 0,
      width_percent: 100,
      height_percent: 100,
    }], { revision: 21 }),
    /exactly one current wall member/i,
  );
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

test('every wall topology and membership mutation advances revision and invalidates stale groups', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'routes', 'video-walls.js'), 'utf8');
  assert.match(source, /const topologyFields = new Set\(\[/);
  assert.match(source, /updates\.push\('layout_json = NULL'\)/);
  assert.match(source, /updates\.push\('layout_revision = layout_revision \+ 1'\)/);
  assert.match(source, /router\.put\('\/:id\/devices'[\s\S]*expected_revision[\s\S]*LAYOUT_REVISION_CONFLICT/);
  assert.match(source, /router\.put\('\/:id\/devices'[\s\S]*layout_json = NULL,[\s\S]*layout_revision = layout_revision \+ 1/);
  assert.match(source, /if \(!topologyChanged\) return res\.json/);
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
