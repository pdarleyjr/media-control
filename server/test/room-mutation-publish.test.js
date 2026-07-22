const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function source(file) {
  return fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
}

test('device mutations schedule an authoritative room revision', () => {
  const devices = source('routes/devices.js');
  assert.match(devices, /scheduleRoomSnapshot/);
  assert.match(devices, /publishDeviceMutation\(req, device\.workspace_id, wroteGeometry \? 'device:geometry' : 'device:updated'\)/);
  assert.match(devices, /publishDeviceMutation\(req, device\.workspace_id, 'device:removed'\)/);
});

test('group topology and assignment mutations schedule an authoritative room revision', () => {
  const groups = source('routes/device-groups.js');
  for (const reason of [
    'group:created', 'group:updated', 'group:deleted', 'group:member-added',
    'group:member-removed', 'group:content-assigned', 'group:playlist-assigned',
  ]) assert.ok(groups.includes(reason), `missing ${reason}`);
});

