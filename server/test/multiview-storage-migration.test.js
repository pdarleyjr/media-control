'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function loadStorageMigration() {
  const source = fs.readFileSync(
    path.join(__dirname, '../../frontend/js/views/media-control/multiview.js'),
    'utf8',
  );
  const start = source.indexOf('function rewriteLegacyPodiumUrl');
  const end = source.indexOf('\nfunction loadStore()', start);
  assert.ok(start >= 0 && end > start, 'Multiview storage migration helpers must remain present');

  const context = vm.createContext({
    URL,
    location: { origin: 'http://127.0.0.1:3001' },
  });
  vm.runInContext(`${source.slice(start, end)}\nthis.__migration = { rewriteLegacyPodiumUrl, migrateLegacyCells };`, context);
  return context.__migration;
}

test('v1 Multiview storage preserves Screen Share metadata and rewrites only recognized legacy Zowie player URLs to Podium', () => {
  const { migrateLegacyCells } = loadStorageMigration();
  const migrated = JSON.parse(JSON.stringify(migrateLegacyCells({
    C1: {
      cellUrl: 'https://media.mbfdhub.com/player/live-source.html?source=guest-computer&fit=cover',
      monitorUrl: 'https://media-control.mbfdhub.com/player/live-source.html?source=guest-computer&audio=1',
      kind: 'i',
      label: 'Legacy Zowie',
    },
    C2: {
      cellUrl: null,
      monitorUrl: null,
      kind: 'share',
      label: 'Screen Share',
      deviceIds: ['display-1'],
    },
    R1: {
      cellUrl: 'https://example.invalid/player/live-source.html?source=guest-computer',
      monitorUrl: null,
      kind: 'i',
      label: 'Foreign URL',
    },
  })));

  assert.deepEqual(migrated.C1, {
    cellUrl: '/player/live-source.html?source=podium-computer&fit=cover',
    monitorUrl: '/player/live-source.html?source=podium-computer&audio=1',
    kind: 'i',
    label: 'Legacy Zowie',
  });
  assert.deepEqual(migrated.C2, {
    cellUrl: null,
    monitorUrl: null,
    kind: 'share',
    label: 'Screen Share',
    deviceIds: ['display-1'],
  });
  assert.equal(
    migrated.R1.cellUrl,
    'https://example.invalid/player/live-source.html?source=guest-computer',
    'a foreign URL is not silently repurposed as a managed player',
  );
});
