const { test } = require('node:test');
const assert = require('node:assert/strict');

async function previewTargetsModule() {
  return import('../../frontend/js/views/media-control/preview-targets.js');
}

function display(id, online = true) {
  return { id, online, now_playing: { kind: 'web', contentId: `content-${id}` } };
}

test('every visible standalone display and span wall gets one logical preview target', async () => {
  const { buildLivePreviewTargets, livePreviewTargetDeviceIds } = await previewTargetsModule();
  const displays = [display('standalone-a'), display('standalone-b')];
  const members = [display('wall-left'), display('wall-center'), display('wall-right')];
  const byId = new Map([...displays, ...members].map((item) => [item.id, item]));
  const walls = [{
    id: 'front-wall',
    layout_mode: 'span',
    leader_device_id: 'wall-center',
    devices: members.map((item, index) => ({ device_id: item.id, grid_col: index, grid_row: 0 })),
  }];

  const targets = buildLivePreviewTargets({
    displays,
    walls,
    byId,
    selectedIds: displays.map((item) => item.id),
  });

  assert.deepEqual([...targets.keys()], [
    'display:standalone-a',
    'display:standalone-b',
    'wall:front-wall',
  ]);
  assert.equal(targets.get('wall:front-wall').deviceId, 'wall-center');
  assert.deepEqual(livePreviewTargetDeviceIds(targets), [
    'standalone-a',
    'standalone-b',
    'wall-center',
  ]);
});

test('a span leader outage changes only that logical surface player', async () => {
  const { buildLivePreviewTargets } = await previewTargetsModule();
  const members = [display('left'), display('leader', false), display('right')];
  const targets = buildLivePreviewTargets({
    walls: [{
      id: 'span-wall',
      layout_mode: 'span',
      leader_device_id: 'leader',
      devices: members.map((item, index) => ({ device_id: item.id, grid_col: index, grid_row: 0 })),
    }],
    byId: new Map(members.map((item) => [item.id, item])),
  });

  assert.deepEqual([...targets.keys()], ['wall:span-wall']);
  assert.equal(targets.get('wall:span-wall').deviceId, 'left');
});

test('grouped walls allocate one preview per authored logical program', async () => {
  const { buildLivePreviewTargets } = await previewTargetsModule();
  const members = [display('left'), display('center'), display('right')];
  const wall = {
    id: 'grouped-wall',
    layout_mode: 'groups',
    devices: members.map((item, index) => ({ device_id: item.id, grid_col: index, grid_row: 0 })),
    layout: {
      groups: [
        { id: 'left-program', leader_device_id: 'left', member_ids: ['left'] },
        { id: 'right-program', leader_device_id: 'center', member_ids: ['center', 'right'] },
      ],
    },
  };

  const targets = buildLivePreviewTargets({
    walls: [wall],
    byId: new Map(members.map((item) => [item.id, item])),
  });

  assert.deepEqual([...targets.keys()], [
    'wall-group:grouped-wall:left-program',
    'wall-group:grouped-wall:right-program',
  ]);
  assert.equal(targets.get('wall-group:grouped-wall:left-program').deviceId, 'left');
  assert.equal(targets.get('wall-group:grouped-wall:right-program').deviceId, 'center');
});

test('multi-player split walls allocate one preview per independently playing member', async () => {
  const { buildLivePreviewTargets } = await previewTargetsModule();
  const members = [display('split-left'), display('split-right')];
  const targets = buildLivePreviewTargets({
    walls: [{
      id: 'split-wall',
      layout_mode: 'split',
      grid_cols: 2,
      devices: members.map((item, index) => ({ device_id: item.id, grid_col: index, grid_row: 0 })),
    }],
    byId: new Map(members.map((item) => [item.id, item])),
  });

  assert.deepEqual([...targets.keys()], [
    'wall-split:split-wall:split-left',
    'wall-split:split-wall:split-right',
  ]);
});

test('single-player regional walls use one composite session that exposes every region', async () => {
  const { buildLivePreviewTargets, livePreviewTargetDeviceIds } = await previewTargetsModule();
  const player = display('mosaic-player');
  const targets = buildLivePreviewTargets({
    walls: [{
      id: 'mosaic-wall',
      layout_mode: 'split',
      grid_cols: 2,
      devices: [{ device_id: player.id, grid_col: 0, grid_row: 0 }],
      layout: {
        regions: [
          { id: 'left-region', player_device_id: player.id, enabled: true },
          { id: 'right-region', player_device_id: player.id, enabled: true },
        ],
      },
    }],
    byId: new Map([[player.id, player]]),
  });

  assert.deepEqual([...targets.keys()], ['wall-regions:mosaic-wall']);
  assert.deepEqual(targets.get('wall-regions:mosaic-wall').regionIds, ['left-region', 'right-region']);
  assert.deepEqual(livePreviewTargetDeviceIds(targets), ['mosaic-player']);
});
