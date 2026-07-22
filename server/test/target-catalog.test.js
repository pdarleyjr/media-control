'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

async function loadCatalogModule() {
  const source = fs.readFileSync(
    path.join(__dirname, '../../frontend/js/services/target-catalog.js'),
    'utf8',
  );
  return import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
}

function roomSnapshot() {
  const displays = [
    { id: 'primary-left', name: 'Front Left', status: 'online', width: 3840, height: 2160 },
    { id: 'primary-center', name: 'Front Center', status: 'online', width: 3840, height: 2160 },
    { id: 'primary-right', name: 'Front Right', status: 'online', width: 3840, height: 2160 },
    { id: 'secondary-left', name: 'Side Left', status: 'online', width: 1920, height: 1080 },
    { id: 'secondary-right', name: 'Side Right', status: 'offline', width: 1920, height: 1080 },
    { id: 'podium', name: 'Podium Confidence', status: 'online', width: 1920, height: 1080 },
    { id: 'live-stream-program-main', name: 'Live Stream Program', status: 'online', width: 1920, height: 1080 },
  ];
  return {
    schemaVersion: 1,
    workspaceId: 'ws-1',
    roomId: 'classroom-1',
    revision: 17,
    confirmedState: {
      displays: displays.map((display) => ({
        id: display.id,
        name: display.name,
        status: display.status,
        renderState: display.status === 'online' ? 'ready' : null,
      })),
    },
    deviceStates: { displays, nodes: [] },
    layoutState: {
      walls: [
        {
          id: 'primary-wall',
          name: 'Primary Wall',
          layoutMode: 'span',
          layoutRevision: 9,
          gridColumns: 3,
          gridRows: 1,
          members: [
            { deviceId: 'primary-left', gridColumn: 0, gridRow: 0, viewport: { x: 0, y: 0, width: 3840, height: 2160 } },
            { deviceId: 'primary-center', gridColumn: 1, gridRow: 0, viewport: { x: 3840, y: 0, width: 3840, height: 2160 } },
            { deviceId: 'primary-right', gridColumn: 2, gridRow: 0, viewport: { x: 7680, y: 0, width: 3840, height: 2160 } },
          ],
        },
        {
          id: 'secondary-wall',
          name: 'Secondary Wall',
          layoutMode: 'mirror',
          layoutRevision: 4,
          gridColumns: 2,
          gridRows: 1,
          members: [
            { deviceId: 'secondary-left', gridColumn: 0, gridRow: 0, viewport: { x: 0, y: 0, width: 1920, height: 1080 } },
            { deviceId: 'secondary-right', gridColumn: 1, gridRow: 0, viewport: { x: 1920, y: 0, width: 1920, height: 1080 } },
          ],
        },
      ],
      groups: [
        {
          id: 'all-five',
          name: 'All Five Wall Displays',
          memberIds: [
            'primary-left', 'primary-center', 'primary-right',
            'secondary-left', 'secondary-right',
          ],
        },
        { id: 'confidence', name: 'Confidence Monitor', memberIds: ['podium'] },
      ],
    },
    livestreamProgram: {
      configured: true,
      displayId: 'live-stream-program-main',
      displayName: 'Live Stream Program',
      status: 'online',
      width: 1920,
      height: 1080,
      contentId: 'scene-holding',
    },
  };
}

test('catalog models physical wall topology with live member status and real dimensions', async () => {
  const { buildTargetCatalog } = await loadCatalogModule();
  const catalog = buildTargetCatalog(roomSnapshot());

  assert.equal(catalog.revision, 17);
  assert.equal(catalog.walls.length, 2);
  assert.deepEqual(catalog.walls[0].dimensions, { width: 11520, height: 2160 });
  assert.equal(
    catalog.walls[0].topologyLabel,
    'Primary Wall · 3 displays · span · 3/3 online · 11520 × 2160',
  );
  assert.equal(catalog.walls[1].onlineCount, 1);
  assert.equal(catalog.walls[1].members[1].status, 'offline');
  assert.equal(
    catalog.physicalMemberLine,
    'Front Left (online) · Front Center (online) · Front Right (online) · Side Left (online) · Side Right (offline)',
  );
});

test('catalog exposes stored groups and only truly standalone physical displays', async () => {
  const { buildTargetCatalog } = await loadCatalogModule();
  const catalog = buildTargetCatalog(roomSnapshot());

  assert.deepEqual(catalog.groups.map((group) => group.id), ['all-five', 'confidence']);
  assert.equal(catalog.groups[0].topologyLabel, 'All Five Wall Displays · 5 displays · 4/5 online · mixed dimensions');
  assert.deepEqual(catalog.standaloneDisplays.map((display) => display.id), ['podium']);
  assert.equal(
    catalog.standaloneDisplays[0].topologyLabel,
    'Podium Confidence · standalone display · online · 1920 × 1080',
  );
});

test('live stream program is separate and its virtual display is excluded by default', async () => {
  const { buildTargetCatalog } = await loadCatalogModule();
  const catalog = buildTargetCatalog(roomSnapshot());

  assert.equal(catalog.displays.some((display) => display.id.startsWith('live-stream-program-')), false);
  assert.deepEqual(catalog.liveProgram, {
    type: 'live-program',
    id: 'live-stream-program-main',
    name: 'Live Stream Program',
    label: 'Live Stream Program',
    status: 'online',
    online: true,
    dimensions: { width: 1920, height: 1080 },
    dimensionsLabel: '1920 × 1080',
    contentId: 'scene-holding',
    raw: roomSnapshot().livestreamProgram,
  });
});

test('target expansion deduplicates wall members across walls, groups, and direct targets', async () => {
  const {
    buildTargetCatalog,
    expandTargetToDeviceIds,
    expandTargetsToDeviceIds,
  } = await loadCatalogModule();
  const catalog = buildTargetCatalog(roomSnapshot());

  assert.deepEqual(expandTargetToDeviceIds('wall:primary-wall', catalog), [
    'primary-left', 'primary-center', 'primary-right',
  ]);
  assert.deepEqual(expandTargetsToDeviceIds([
    { type: 'wall', id: 'primary-wall' },
    { type: 'group', id: 'all-five' },
    { type: 'display', id: 'primary-left' },
    { type: 'display', id: 'podium' },
  ], catalog), [
    'primary-left', 'primary-center', 'primary-right',
    'secondary-left', 'secondary-right', 'podium',
  ]);
});

test('missing wall member reports offline and uses persisted physical dimensions', async () => {
  const { buildTargetCatalog } = await loadCatalogModule();
  const snapshot = roomSnapshot();
  snapshot.layoutState.walls[0].members.push({
    deviceId: 'spare-screen',
    gridColumn: 3,
    gridRow: 0,
    displayWidth: 2560,
    displayHeight: 1440,
    viewport: { x: 11520, y: 0, width: 2560, height: 1440 },
  });

  const catalog = buildTargetCatalog(snapshot);
  const spare = catalog.walls[0].members.at(-1);
  assert.equal(spare.status, 'offline');
  assert.deepEqual(spare.dimensions, { width: 2560, height: 1440 });
  assert.deepEqual(catalog.walls[0].dimensions, { width: 14080, height: 2160 });
});

test('invalid snapshots and unknown targets fail closed', async () => {
  const { buildTargetCatalog, expandTargetToDeviceIds } = await loadCatalogModule();
  const catalog = buildTargetCatalog(null);

  assert.deepEqual(catalog.walls, []);
  assert.deepEqual(catalog.groups, []);
  assert.deepEqual(catalog.displays, []);
  assert.equal(catalog.liveProgram, null);
  assert.deepEqual(expandTargetToDeviceIds('wall:not-real', catalog), []);
});
