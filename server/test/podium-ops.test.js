const fs = require('fs');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

test('podium ops wait for a display and use clean camera capture settings', () => {
  const root = path.join(__dirname, '..', '..', 'ops', 'podium');
  const session = fs.readFileSync(path.join(root, 'mbfd-console-session.sh'), 'utf8');
  const camera = fs.readFileSync(path.join(root, 'camera-compose.yaml'), 'utf8');

  assert.match(session, /until display_connected/);
  assert.match(session, /stop_cage/);
  assert.match(camera, /- yuyv422/);
  assert.match(camera, /hw:C920,0/);
});
