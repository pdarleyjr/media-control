'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

async function loadModule() {
  const source = fs.readFileSync(
    path.join(__dirname, '../../frontend/js/services/whiteboard-targets.js'),
    'utf8',
  );
  return import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
}

function catalog() {
  const left = {
    type: 'display', id: 'left', name: 'Left 4K', status: 'online', online: true,
    dimensions: { width: 3840, height: 2160 },
    viewport: { x: 120, y: 40, width: 3840, height: 2160 },
  };
  const right = {
    type: 'display', id: 'right', name: 'Right HD', status: 'offline', online: false,
    dimensions: { width: 1920, height: 1080 },
    viewport: { x: 3960, y: 40, width: 1920, height: 1080 },
  };
  const podium = {
    type: 'display', id: 'podium', name: 'Podium', status: 'online', online: true,
    dimensions: { width: 2560, height: 1440 }, memberIds: ['podium'],
  };
  return {
    revision: 44,
    walls: [{
      type: 'wall', id: 'front-wall', name: 'Front Wall', layoutRevision: 12,
      dimensions: { width: 5760, height: 2160 }, memberIds: ['left', 'right'],
      members: [left, right],
      topologyLabel: 'Front Wall · 2 displays · span · 1/2 online · 5760 × 2160',
    }],
    groups: [{
      type: 'group', id: 'confidence', name: 'Confidence Displays',
      memberIds: ['podium'], members: [podium],
      topologyLabel: 'Confidence Displays · 1 display · 1/1 online · 2560 × 1440',
    }],
    standaloneDisplays: [podium],
    liveProgram: { type: 'live-program', id: 'live-stream-program-main' },
  };
}

test('whiteboard targets expose logical topology only and preserve calibrated wall geometry', async () => {
  const { buildWhiteboardTargets } = await loadModule();
  const targets = buildWhiteboardTargets(catalog(), [
    { id: 'left', screenshot_url: '/left.jpg' },
    { id: 'right', screenshot_url: '/right.jpg' },
    { id: 'podium', screenshot_url: '/podium.jpg' },
  ]);

  assert.deepEqual(targets.map((target) => [target.target_type, target.wall_id || target.group_id || target.target_id]), [
    ['wall', 'front-wall'],
    ['group', 'confidence'],
    ['display', 'podium'],
  ]);
  assert.equal(targets.some((target) => target.target_id === 'right'), false);
  assert.equal(targets.some((target) => target.target_id === 'live-stream-program-main'), false);

  const wall = targets[0];
  assert.equal(wall.width, 5760);
  assert.equal(wall.height, 2160);
  assert.equal(wall.layout_revision, 12);
  assert.deepEqual(wall.members, [
    { id: 'left', screenshot_url: '/left.jpg', x: 0, y: 0, width: 2 / 3, height: 1 },
    { id: 'right', screenshot_url: '/right.jpg', x: 2 / 3, y: 0, width: 1 / 3, height: 0.5 },
  ]);
});

test('incompletely calibrated walls fail closed instead of targeting only a leader', async () => {
  const { buildWhiteboardTargets } = await loadModule();
  const value = catalog();
  value.walls[0].members[1].viewport = null;

  const targets = buildWhiteboardTargets(value, []);
  assert.equal(targets.some((target) => target.wall_id === 'front-wall'), false);
  assert.deepEqual(targets.map((target) => target.target_type), ['group', 'display']);
});

test('active wall members resolve to the whole wall while logical groups stay groups', async () => {
  const { buildWhiteboardTargets, findWhiteboardTargetForActive } = await loadModule();
  const value = catalog();
  const targets = buildWhiteboardTargets(value, []);

  assert.equal(findWhiteboardTargetForActive(targets, value, { type: 'display', id: 'right' }).wall_id, 'front-wall');
  assert.equal(findWhiteboardTargetForActive(targets, value, { type: 'group', id: 'confidence' }).group_id, 'confidence');
  assert.equal(findWhiteboardTargetForActive(targets, value, { type: 'display', id: 'podium' }).target_id, 'podium');
});

test('missing authoritative catalog yields no targets', async () => {
  const { buildWhiteboardTargets, findWhiteboardTargetForActive } = await loadModule();
  assert.deepEqual(buildWhiteboardTargets(null, []), []);
  assert.equal(findWhiteboardTargetForActive([], null, { type: 'wall', id: 'front-wall' }), null);
});
