const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildUniversalWallGeometry,
  buildLayoutAssignment,
  bezelPixelsBetween,
} = require('../lib/wall-geometry');

test('derives a mixed-resolution span from each member real geometry and converts bezel millimetres deterministically', () => {
  const wall = {
    id: 'wall-1',
    screen_w_mm: 1000,
    screen_h_mm: 600,
    bezel_h_mm: 10,
    bezel_v_mm: 0,
  };
  const members = [
    {
      device_id: 'left', grid_col: 0, grid_row: 0, screen_width: 1920, screen_height: 1080,
      canvas_x: null, canvas_y: null, canvas_width: null, canvas_height: null,
    },
    {
      device_id: 'right', grid_col: 1, grid_row: 0, screen_width: 3840, screen_height: 2160,
      canvas_x: null, canvas_y: null, canvas_width: null, canvas_height: null,
    },
  ];

  const left = buildUniversalWallGeometry({ wall, members, memberIds: ['left', 'right'], deviceId: 'left' });
  const right = buildUniversalWallGeometry({ wall, members, memberIds: ['left', 'right'], deviceId: 'right' });

  // Boundary scale is the deterministic mean of the adjoining panels'
  // horizontal pixel densities: ((1.92 + 3.84) / 2) * 10mm = 28.8px.
  assert.deepEqual(left.screenRect, { x: 0, y: 0, w: 1920, h: 1080 });
  assert.deepEqual(right.screenRect, { x: 1949, y: 0, w: 3840, h: 2160 });
  assert.deepEqual(left.playerRect, { x: 0, y: 0, w: 5789, h: 2160 });
  assert.deepEqual(right.playerRect, left.playerRect);
  assert.deepEqual(left.logicalCanvas, { width: 5789, height: 2160 });
  assert.deepEqual(left.viewport, { x: 0, y: 0, w: 1920, h: 1080 });
  assert.deepEqual(right.viewport, { x: 1949, y: 0, w: 3840, h: 2160 });
});

test('honours calibrated canvas rectangles and clips a target viewport to an explicit player rectangle', () => {
  const wall = {
    id: 'wall-2',
    player_x: 100,
    player_y: 50,
    player_width: 2200,
    player_height: 900,
    screen_w_mm: 400,
    screen_h_mm: 225,
    bezel_h_mm: 0,
    bezel_v_mm: 0,
  };
  const members = [
    {
      device_id: 'a', grid_col: 0, grid_row: 0,
      screen_width: 1920, screen_height: 1080,
      canvas_x: 0, canvas_y: 0, canvas_width: 1200, canvas_height: 1000,
    },
    {
      device_id: 'b', grid_col: 1, grid_row: 0,
      screen_width: 3840, screen_height: 2160,
      canvas_x: 1200, canvas_y: 0, canvas_width: 1200, canvas_height: 1000,
    },
  ];

  const geometry = buildUniversalWallGeometry({ wall, members, memberIds: ['a', 'b'], deviceId: 'b' });

  assert.deepEqual(geometry.screenRect, { x: 1200, y: 0, w: 1200, h: 1000 });
  assert.deepEqual(geometry.playerRect, { x: 100, y: 50, w: 2200, h: 900 });
  assert.deepEqual(geometry.logicalCanvas, { width: 2200, height: 900 });
  assert.deepEqual(geometry.viewport, { x: 1100, y: 0, w: 1100, h: 900 });
});

test('uses real two-dimensional row geometry instead of a global legacy tile fallback', () => {
  const wall = {
    id: 'wall-3',
    screen_w_mm: 400,
    screen_h_mm: 225,
    bezel_h_mm: 0,
    bezel_v_mm: 5,
  };
  const members = [
    { device_id: 'top', grid_col: 0, grid_row: 0, screen_width: 1366, screen_height: 768 },
    { device_id: 'bottom', grid_col: 0, grid_row: 1, screen_width: 1920, screen_height: 1080 },
  ];

  const geometry = buildUniversalWallGeometry({ wall, members, memberIds: ['top', 'bottom'], deviceId: 'bottom' });

  // Mean vertical density is ((768/225 + 1080/225) / 2) * 5mm = 20.53px.
  assert.deepEqual(geometry.screenRect, { x: 0, y: 789, w: 1920, h: 1080 });
  assert.deepEqual(geometry.logicalCanvas, { width: 1920, height: 1869 });
  assert.notEqual(geometry.screenRect.w, 320);
  assert.notEqual(geometry.screenRect.h, 180);
});

test('uses the largest real panel extent in a grid track so mixed panels never overlap', () => {
  const wall = {
    id: 'wall-grid',
    screen_w_mm: 400,
    screen_h_mm: 225,
    bezel_h_mm: 0,
    bezel_v_mm: 0,
  };
  const members = [
    { device_id: 'small-top', grid_col: 0, grid_row: 0, screen_width: 1280, screen_height: 720 },
    { device_id: 'large-top', grid_col: 1, grid_row: 0, screen_width: 1920, screen_height: 1080 },
    { device_id: 'bottom', grid_col: 0, grid_row: 1, screen_width: 1366, screen_height: 768 },
  ];

  const bottom = buildUniversalWallGeometry({
    wall,
    members,
    memberIds: members.map((member) => member.device_id),
    deviceId: 'bottom',
  });

  assert.equal(bottom.screenRect.y, 1080);
  assert.equal(bottom.playerRect.h, 1848);
});

test('builds the versioned universal target assignment without inventing unknown content or start time', () => {
  const assignment = buildLayoutAssignment({
    layoutId: 'wall-4:layout:7',
    layoutRevision: 7,
    contentId: 'content-9',
    fitMode: 'contain',
    synchronizedStartAt: null,
    geometry: {
      logicalCanvas: { width: 3840, height: 1080 },
      viewport: { x: 1920, y: 0, w: 1920, h: 1080 },
    },
  });

  assert.deepEqual(assignment, {
    layout_id: 'wall-4:layout:7',
    layout_revision: 7,
    content_id: 'content-9',
    logical_canvas: { width: 3840, height: 1080 },
    viewport: { x: 1920, y: 0, w: 1920, h: 1080 },
    fit_mode: 'contain',
    synchronized_start_at: null,
  });

  assert.equal(buildLayoutAssignment({
    layoutId: 'wall-4:layout:7',
    layoutRevision: 7,
    geometry: null,
  }), null);
});

test('uses physical wall dimensions only as a last-resort per-track fallback and handles absent geometry safely', () => {
  assert.equal(buildUniversalWallGeometry({ wall: null, members: [], memberIds: [], deviceId: 'missing' }), null);
  assert.equal(buildUniversalWallGeometry({ wall: { id: 'wall' }, members: [], memberIds: [], deviceId: 'missing' }), null);

  const wall = {
    id: 'physical-fallback',
    screen_w_mm: 400,
    screen_h_mm: 225,
    bezel_h_mm: 10,
    bezel_v_mm: 0,
    player_x: 0,
    player_y: 0,
    player_width: 0,
    player_height: -1,
  };
  const members = [
    { device_id: 'unknown-a', grid_col: 0, grid_row: 0 },
    { device_id: 'unknown-b', grid_col: 1, grid_row: 0 },
  ];
  const geometry = buildUniversalWallGeometry({ wall, members, memberIds: ['unknown-a', 'unknown-b'], deviceId: 'unknown-b' });

  assert.deepEqual(geometry.screenRect, { x: 410, y: 0, w: 400, h: 225 });
  assert.deepEqual(geometry.logicalCanvas, { width: 810, height: 225 });
  assert.deepEqual(geometry.viewport, { x: 410, y: 0, w: 400, h: 225 });
});

test('bezel conversion and viewport clipping remain deterministic for incomplete calibration', () => {
  assert.equal(bezelPixelsBetween({ bezel_h_mm: 0 }, [], 'x', 0, 1), 0);
  assert.equal(bezelPixelsBetween({ bezel_h_mm: 7, screen_w_mm: null }, [], 'x', 0, 1), 7);

  const geometry = buildUniversalWallGeometry({
    wall: { id: 'off-canvas', player_x: 500, player_y: 500, player_width: 100, player_height: 100 },
    members: [{ device_id: 'screen', grid_col: 0, grid_row: 0, screen_width: 100, screen_height: 100 }],
    memberIds: ['screen'],
    deviceId: 'screen',
  });
  assert.deepEqual(geometry.viewport, { x: 0, y: 0, w: 0, h: 0 });

  assert.deepEqual(buildLayoutAssignment({
    geometry: { logicalCanvas: { width: 1, height: 1 }, viewport: { x: 0, y: 0, w: 1, h: 1 } },
    layoutRevision: 'invalid',
  }), {
    layout_id: null,
    layout_revision: 0,
    content_id: null,
    logical_canvas: { width: 1, height: 1 },
    viewport: { x: 0, y: 0, w: 1, h: 1 },
    fit_mode: null,
    synchronized_start_at: null,
  });
});
