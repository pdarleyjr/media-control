const { test } = require('node:test');
const assert = require('node:assert/strict');
const { nowPlayingFromSnapshot } = require('../lib/display-state');

test('null snapshot -> idle', () => {
  assert.deepEqual(nowPlayingFromSnapshot(null), { label: 'Idle', kind: 'idle', itemCount: 0 });
});

test('malformed snapshot -> idle (never throws)', () => {
  assert.equal(nowPlayingFromSnapshot('{not json').kind, 'idle');
});

test('single image item -> its filename', () => {
  const snap = JSON.stringify({ items: [{ content_id: 'c1', filename: 'welcome.jpg', mime_type: 'image/jpeg' }] });
  const r = nowPlayingFromSnapshot(snap);
  assert.equal(r.label, 'welcome.jpg');
  assert.equal(r.kind, 'image');
  assert.equal(r.itemCount, 1);
});

test('youtube remote_url -> youtube kind', () => {
  const snap = JSON.stringify({ items: [{ remote_url: 'https://youtu.be/abc', mime_type: 'video/youtube', filename: 'Intro' }] });
  assert.equal(nowPlayingFromSnapshot(snap).kind, 'youtube');
});

test('multiple items -> playlist label with count', () => {
  const snap = JSON.stringify({ items: [{ filename: 'a' }, { filename: 'b' }, { filename: 'c' }] });
  const r = nowPlayingFromSnapshot(snap);
  assert.equal(r.kind, 'playlist');
  assert.equal(r.itemCount, 3);
  assert.match(r.label, /3/);
});
