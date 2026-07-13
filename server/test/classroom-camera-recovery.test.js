const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const player = fs.readFileSync(path.join(__dirname, '..', 'player', 'classroom-camera.html'), 'utf8');

test('classroom camera player reconnects when video timestamps stop advancing', () => {
  assert.match(player, /lastProgressAt/);
  assert.match(player, /Date\.now\(\) - lastProgressAt > 10000/);
  assert.match(player, /freshSource = source \+ '\?fresh='/);
  assert.match(player, /liveMaxLatencyDurationCount: 3/);
});

test('Focus 210 top-level player exposes real digital PTZ controls and presets', () => {
  assert.match(player, /data-eptz="zoom-in"/);
  assert.match(player, /data-eptz="wall-1"/);
  assert.match(player, /data-eptz="wall-2"/);
  assert.match(player, /window\.top === window\.self/);
  assert.match(player, /video\.style\.transform/);
});
