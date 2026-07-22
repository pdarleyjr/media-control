const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(
  path.join(__dirname, '../../frontend/js/views/media-control/advanced-canvas.js'),
  'utf8',
);

test('advanced canvas derives wall routing from authoritative topology without ordinal walls', () => {
  assert.match(source, /endpointWithTopology\(rawEndpoint, catalog\)/);
  assert.match(source, /topology\.walls \|\| \[\]/);
  assert.match(source, /data-canvas-target="wall:\$\{esc\(wall\.id\)\}"/);
  assert.doesNotMatch(source, /outputs\.slice\(0, 3\)/);
  assert.doesNotMatch(source, /outputs\.slice\(3, 5\)/);
  assert.doesNotMatch(source, /6400/);
});

test('advanced canvas cards expose configured wall name, layout, dimensions, online count and revision', () => {
  assert.match(source, /wall\.layoutMode/);
  assert.match(source, /wall\.rect\.width/);
  assert.match(source, /wall\.onlineCount/);
  assert.match(source, /wall\.layoutRevision/);
  assert.doesNotMatch(source, /VIDEO WALL 1 \/ 3 DISPLAYS/);
  assert.doesNotMatch(source, /VIDEO WALL 2 \/ 2 DISPLAYS/);
});
