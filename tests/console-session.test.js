const fs = require('fs');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

test('console session waits for a real DRM output and stops Cage after disconnect', () => {
  const session = fs.readFileSync(
    path.join(__dirname, '..', 'deploy', 'cage', 'mbfd-console-session.sh'),
    'utf8'
  );
  const service = fs.readFileSync(
    path.join(__dirname, '..', 'deploy', 'systemd', 'mbfd-console.service'),
    'utf8'
  );

  assert.match(session, /grep -qs '\^connected\$' \/sys\/class\/drm\/card\*-\*\/status/);
  assert.match(session, /until display_connected/);
  assert.match(session, /stop_cage/);
  assert.match(service, /ExecStart=\/opt\/mbfd\/media-control-console\/mbfd-console-session\.sh/);
});
