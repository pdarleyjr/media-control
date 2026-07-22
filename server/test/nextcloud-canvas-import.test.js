const fs = require('fs');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

test('Nextcloud can import content for an advanced canvas without legacy display targets', () => {
  const route = fs.readFileSync(path.join(__dirname, '..', 'routes', 'files.js'), 'utf8');
  const view = fs.readFileSync(
    path.join(__dirname, '..', '..', 'frontend', 'js', 'views', 'media-control.js'),
    'utf8'
  );

  assert.match(route, /import_only !== true && legacyIds\.length === 0 && typedRefs\.length === 0/);
  assert.match(route, /imported: true/);
  assert.match(view, /api\.files\.importForCanvas\(path\)/);
  assert.match(view, /routeSourceToAdvancedCanvas\(\{ content_id: imported\.content_id \}, label\)/);
});
