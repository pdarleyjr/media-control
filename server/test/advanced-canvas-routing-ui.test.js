const fs = require('fs');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

test('classroom source taps use the advanced canvas while standard workspaces retain legacy routing', () => {
  const view = fs.readFileSync(
    path.join(__dirname, '..', '..', 'frontend', 'js', 'views', 'media-control.js'),
    'utf8'
  );
  const canvas = fs.readFileSync(
    path.join(__dirname, '..', '..', 'frontend', 'js', 'views', 'media-control', 'advanced-canvas.js'),
    'utf8'
  );

  assert.match(view, /if \(hasAdvancedCanvasEndpoint\(\)\)/);
  assert.match(view, /return routeSourceToAdvancedCanvas\(source, label\)/);
  assert.match(canvas, /data-canvas-target="primary"/);
  assert.match(canvas, /data-canvas-target="secondary"/);
  assert.match(canvas, /data-canvas-target="display:\$\{index\}"/);
});

test('canvas blanking preserves layers and clear requires confirmation', () => {
  const canvas = fs.readFileSync(
    path.join(__dirname, '..', '..', 'frontend', 'js', 'views', 'media-control', 'advanced-canvas.js'),
    'utf8'
  );
  const route = fs.readFileSync(
    path.join(__dirname, '..', 'routes', 'advanced-canvas.js'),
    'utf8'
  );

  assert.match(canvas, /api\.canvas\.setActive\(instance\.endpoint\.id, !blanked\)/);
  assert.match(canvas, /clear_confirm_title/);
  assert.match(route, /router\.post\('\/:id\/active'/);
  assert.match(route, /advanced_canvas\.clear/);
});
