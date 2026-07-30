const fs = require('fs');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

test('podium ops wait for a display without defining an obsolete camera publisher', () => {
  const root = path.join(__dirname, '..', '..', 'ops', 'podium');
  const session = fs.readFileSync(path.join(root, 'mbfd-console-session.sh'), 'utf8');

  assert.match(session, /until display_connected/);
  assert.match(session, /stop_cage/);
  assert.equal(fs.existsSync(path.join(root, 'camera-compose.yaml')), false);
  assert.equal(fs.existsSync(path.join(root, '.env.example')), false);
});
