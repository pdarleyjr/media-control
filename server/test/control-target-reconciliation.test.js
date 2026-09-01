const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

async function loadModule() {
  const source = fs.readFileSync(
    path.join(__dirname, '../../frontend/js/views/media-control/target-reconciliation.js'),
    'utf8',
  );
  return import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
}

const primary = { type: 'wall', id: 'primary-wall', wall_id: 'primary-wall' };
const secondary = { type: 'wall', id: 'secondary-wall', wall_id: 'secondary-wall' };

test('an established operator target never falls back to a different wall', async () => {
  const { reconcileControlTarget } = await loadModule();
  const result = reconcileControlTarget({
    activeTarget: secondary,
    validateTarget: () => null,
    chooseDefaultTarget: () => primary,
  });

  assert.equal(result.target, secondary);
  assert.equal(result.available, false);
  assert.equal(result.usedDefault, false);
});

test('startup without an operator target may use the safe default chain', async () => {
  const { reconcileControlTarget } = await loadModule();
  const result = reconcileControlTarget({
    activeTarget: null,
    validateTarget: () => null,
    chooseDefaultTarget: () => primary,
  });

  assert.equal(result.target, primary);
  assert.equal(result.available, true);
  assert.equal(result.usedDefault, true);
});

test('equivalent wall topology does not require a destructive canvas reconcile', async () => {
  const { wallTopologySignature } = await loadModule();
  const wall = {
    id: 'secondary-wall',
    name: 'Classroom 1 Secondary Wall',
    layout_mode: 'span',
    layout_revision: 18,
    content_id: 'video-a',
    updated_at: 100,
    devices: [
      { device_id: 'side-left', grid_col: 0, grid_row: 0, device_status: 'online' },
      { device_id: 'side-right', grid_col: 1, grid_row: 0, device_status: 'online' },
    ],
  };
  const telemetryOnlyUpdate = {
    ...wall,
    content_id: 'video-b',
    updated_at: 101,
    devices: wall.devices.map((device) => ({ ...device, device_status: 'offline' })),
  };

  assert.equal(wallTopologySignature([wall]), wallTopologySignature([telemetryOnlyUpdate]));
});

test('membership or layout changes require a topology reconcile', async () => {
  const { wallTopologySignature } = await loadModule();
  const base = [{
    id: 'secondary-wall',
    name: 'Classroom 1 Secondary Wall',
    layout_mode: 'span',
    layout_revision: 18,
    devices: [{ device_id: 'side-left', grid_col: 0, grid_row: 0 }],
  }];
  const changed = [{
    ...base[0],
    layout_revision: 19,
    devices: [...base[0].devices, { device_id: 'side-right', grid_col: 1, grid_row: 0 }],
  }];

  assert.notEqual(wallTopologySignature(base), wallTopologySignature(changed));
});

test('layout payload changes are detected even before a revision increment arrives', async () => {
  const { wallTopologySignature } = await loadModule();
  const base = [{
    id: 'primary-wall',
    layout_mode: 'groups',
    layout_revision: 7,
    layout: { preset: 'span-left', groups: [{ id: 'pair', member_ids: ['left', 'center'] }] },
    devices: [],
  }];
  const changed = [{
    ...base[0],
    layout: { preset: 'span-right', groups: [{ id: 'pair', member_ids: ['center', 'right'] }] },
  }];

  assert.notEqual(wallTopologySignature(base), wallTopologySignature(changed));
});
