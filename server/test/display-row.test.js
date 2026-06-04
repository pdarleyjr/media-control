const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mapDisplayRow } = require('../lib/display-row');

const NP = { label: 'Idle', kind: 'idle', itemCount: 0 };

function baseRow(over = {}) {
  return {
    id: 'dev-1',
    name: 'Lobby',
    status: 'offline',
    last_heartbeat: null,
    screen_width: 1920,
    screen_height: 1080,
    screen_on: 1,
    playlist_id: 'pl-42',
    layout_id: 'lay-7',
    shot_at: null,
    ...over,
  };
}

// The regression this guards: /state SELECTs playlist_id but the old inline
// mapper dropped it, so the client saw undefined and Mirror routing broke.
test('playlist_id is preserved in the mapped response', () => {
  const out = mapDisplayRow(baseRow(), NP, 1000);
  assert.equal(out.playlist_id, 'pl-42');
});

test('null playlist_id maps to null (not undefined)', () => {
  const out = mapDisplayRow(baseRow({ playlist_id: null }), NP, 1000);
  assert.equal(out.playlist_id, null);
  assert.ok('playlist_id' in out, 'key must be present even when null');
});

test('missing playlist_id key maps to null', () => {
  const row = baseRow();
  delete row.playlist_id;
  const out = mapDisplayRow(row, NP, 1000);
  assert.equal(out.playlist_id, null);
});

// Guard the rest of the contract so the extraction stays faithful.
test('online window: recent heartbeat + online status -> online', () => {
  const now = 1000;
  const out = mapDisplayRow(baseRow({ status: 'online', last_heartbeat: now - 10 }), NP, now);
  assert.equal(out.online, true);
});

test('online window: stale heartbeat -> offline', () => {
  const now = 1000;
  const out = mapDisplayRow(baseRow({ status: 'online', last_heartbeat: now - 120 }), NP, now);
  assert.equal(out.online, false);
});

test('screen_on: 0 -> false, anything else -> true', () => {
  assert.equal(mapDisplayRow(baseRow({ screen_on: 0 }), NP, 1000).screen_on, false);
  assert.equal(mapDisplayRow(baseRow({ screen_on: 1 }), NP, 1000).screen_on, true);
});

test('layout_id and dimensions use || null fallback', () => {
  const out = mapDisplayRow(baseRow({ layout_id: null, screen_width: 0, screen_height: 0 }), NP, 1000);
  assert.equal(out.layout_id, null);
  assert.equal(out.width, null);
  assert.equal(out.height, null);
});

test('screenshot url/at built from shot_at, else null', () => {
  const withShot = mapDisplayRow(baseRow({ shot_at: 1700 }), NP, 1000);
  assert.equal(withShot.screenshot_url, '/api/devices/dev-1/screenshot?t=1700');
  assert.equal(withShot.screenshot_at, 1700);
  const noShot = mapDisplayRow(baseRow({ shot_at: null }), NP, 1000);
  assert.equal(noShot.screenshot_url, null);
  assert.equal(noShot.screenshot_at, null);
});

test('now_playing is passed through unchanged', () => {
  const np = { label: 'Clock', kind: 'widget', itemCount: 1 };
  const out = mapDisplayRow(baseRow(), np, 1000);
  assert.deepEqual(out.now_playing, np);
});

test('asset cache defaults to direct and preserves supplied mode', () => {
  assert.deepEqual(mapDisplayRow(baseRow(), NP, 1000).asset_cache, { mode: 'direct' });
  assert.deepEqual(
    mapDisplayRow(baseRow(), NP, 1000, { mode: 'local', base_url: 'http://10.0.0.5:8096' }).asset_cache,
    { mode: 'local', base_url: 'http://10.0.0.5:8096' },
  );
});
