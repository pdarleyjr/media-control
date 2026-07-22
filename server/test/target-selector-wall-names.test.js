const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(
  path.join(__dirname, '../../frontend/js/views/media-control/target-selector.js'),
  'utf8',
);

test('Command Center wall tabs preserve configured physical wall names', () => {
  assert.match(source, /return name \|\| \(\(wall && wall\.id\) \|\| ''\)/);
  assert.doesNotMatch(source, /return 'Video Wall [12]'/);
});

