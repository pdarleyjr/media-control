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
  assert.match(camera, /yuyv422/, 'must capture in yuyv422 format');
  assert.match(camera, /hw:C920,0/);
  assert.match(camera, /thread_queue_size/);
  assert.doesNotMatch(camera, /discardcorrupt/, 'bad -fflags flag must not be present');
  assert.doesNotMatch(camera, /-shortest/, '-shortest must not be present');
  assert.match(camera, /network_mode: host/, 'must use host networking for Tailscale RTMP');
  assert.match(camera, /healthcheck/, 'healthcheck must be configured');
  assert.match(camera, /while true/, 'must have reconnect loop to prevent v4l2 device-busy race');
});
