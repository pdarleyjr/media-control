const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

async function loadModule() {
  const source = fs.readFileSync(path.join(__dirname, '../../frontend/js/services/canvas-topology.js'), 'utf8');
  return import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
}

function catalog() {
  return {
    walls: [
      { id: 'primary', name: 'Classroom Primary', layoutMode: 'span', layoutRevision: 88, onlineCount: 3, memberCount: 3, members: [
        { id: 'p1', name: 'P1', status: 'online', viewport: { x: 0, y: 0, width: 1280, height: 720 } },
        { id: 'p2', name: 'P2', status: 'online', viewport: { x: 1280, y: 0, width: 1280, height: 720 } },
        { id: 'p3', name: 'P3', status: 'online', viewport: { x: 2560, y: 0, width: 1280, height: 720 } },
      ] },
      { id: 'eoc', name: 'EOC Front', layoutMode: 'span', layoutRevision: 0, onlineCount: 0, memberCount: 3, members: [
        { id: 'e1', name: 'E1', status: 'offline', viewport: { x: 0, y: 0, width: 1920, height: 1080 } },
        { id: 'e2', name: 'E2', status: 'offline', viewport: { x: 1920, y: 0, width: 1920, height: 1080 } },
        { id: 'e3', name: 'E3', status: 'offline', viewport: { x: 3840, y: 0, width: 1920, height: 1080 } },
      ] },
    ],
    standaloneDisplays: [{ id: 'podium', name: 'Podium', status: 'online', dimensions: { width: 2560, height: 1440 } }],
  };
}

test('derives every configured wall and standalone output from real snapshot geometry', async () => {
  const { normalizeCanvasTopology } = await loadModule();
  const topology = normalizeCanvasTopology(null, catalog());
  assert.deepEqual(topology.walls.map((wall) => [wall.id, wall.name, wall.memberCount]), [
    ['primary', 'Classroom Primary', 3], ['eoc', 'EOC Front', 3],
  ]);
  assert.equal(topology.outputs.length, 7);
  assert.equal(topology.width, 12160);
  assert.equal(topology.height, 1440);
  assert.equal(topology.outputs.find((output) => output.id === 'e1').x, 3840);
});

test('preserves calibrated endpoint coordinates and annotates wall identity without ordinal guesses', async () => {
  const { normalizeCanvasTopology } = await loadModule();
  const topology = normalizeCanvasTopology({
    width: 9000,
    height: 1200,
    outputs: [
      { id: 'p1', x: 50, y: 10, width: 1000, height: 700 },
      { id: 'e1', x: 5000, y: 10, width: 1800, height: 1000 },
    ],
  }, catalog());
  assert.equal(topology.outputs[0].wallName, 'Classroom Primary');
  assert.equal(topology.outputs[1].wallId, 'eoc');
  assert.equal(topology.width, 9000);
  assert.equal(topology.walls.length, 2);
});

test('empty topology fails safely with a minimal nonzero canvas and no invented displays', async () => {
  const { normalizeCanvasTopology } = await loadModule();
  assert.deepEqual(normalizeCanvasTopology(null, null), {
    origin_x: 0, origin_y: 0, width: 1, height: 1, outputs: [], walls: [],
  });
});

