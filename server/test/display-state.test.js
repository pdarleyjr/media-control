const { test } = require('node:test');
const assert = require('node:assert/strict');
const { nowPlayingFromSnapshot } = require('../lib/display-state');

test('null snapshot -> idle', () => {
  assert.deepEqual(nowPlayingFromSnapshot(null), { label: 'Idle', kind: 'idle', itemCount: 0 });
});

test('malformed snapshot -> idle (never throws)', () => {
  assert.equal(nowPlayingFromSnapshot('{not json').kind, 'idle');
});

// The REAL published_snapshot is a TOP-LEVEL ARRAY of item objects (verified
// against production: a broadcast of mbfd_logo(2).png produced exactly this).
test('REAL shape: top-level array, single image item -> filename + image kind', () => {
  const snap = JSON.stringify([
    { content_id: 'fa5b3a19', widget_id: null, zone_id: null, sort_order: 0, duration_sec: 10,
      fit_mode: null, filename: 'mbfd_logo(2).png', mime_type: 'image/png',
      filepath: 'd9f08ca7.png', remote_url: null },
  ]);
  const r = nowPlayingFromSnapshot(snap);
  assert.equal(r.label, 'mbfd_logo(2).png');
  assert.equal(r.kind, 'image');
  assert.equal(r.itemCount, 1);
  assert.equal(r.contentId, 'fa5b3a19');
});

test('top-level array: youtube item -> youtube kind', () => {
  const snap = JSON.stringify([{ remote_url: 'https://youtu.be/abc', mime_type: 'video/youtube', filename: 'Intro' }]);
  assert.equal(nowPlayingFromSnapshot(snap).kind, 'youtube');
});

test('top-level array: widget item -> widget kind, widget_name label', () => {
  const snap = JSON.stringify([{ widget_id: 'w1', widget_name: 'Clock', mime_type: null }]);
  const r = nowPlayingFromSnapshot(snap);
  assert.equal(r.kind, 'widget');
  assert.equal(r.label, 'Clock');
});

test('top-level array: multiple items -> playlist label with count', () => {
  const snap = JSON.stringify([{ filename: 'a' }, { filename: 'b' }, { filename: 'c' }]);
  const r = nowPlayingFromSnapshot(snap);
  assert.equal(r.kind, 'playlist');
  assert.equal(r.itemCount, 3);
  assert.match(r.label, /3/);
});

test('empty array -> idle', () => {
  assert.equal(nowPlayingFromSnapshot('[]').kind, 'idle');
});

// Defensive: a { items: [...] } wrapper is still tolerated.
test('defensive { items: [...] } wrapper still resolves', () => {
  const snap = JSON.stringify({ items: [{ filename: 'welcome.jpg', mime_type: 'image/jpeg' }] });
  const r = nowPlayingFromSnapshot(snap);
  assert.equal(r.label, 'welcome.jpg');
  assert.equal(r.kind, 'image');
});
