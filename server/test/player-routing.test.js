const { test } = require('node:test');
const assert = require('node:assert/strict');
const PR = require('../player/player-routing.js');

// player-routing decides whether a web-page content item loads as a LIVE direct
// iframe (our own /player/* or /api/content/* page) or as a foreign-site
// screenshot. The regression it guards: our own pages are stored with ABSOLUTE
// URLs on one hostname (media.mbfdhub.com) but a display may load the player from
// a sibling host (media-control.mbfdhub.com) or a LAN/Tailscale origin — so they
// MUST still resolve to our own page, root-relative, and never be screenshotted.

test('ownPlayerPath: already root-relative paths pass through unchanged', () => {
  assert.equal(PR.ownPlayerPath('/player/grid.html?cells=abc'), '/player/grid.html?cells=abc');
  assert.equal(PR.ownPlayerPath('/player/hls.html?station=mbtv'), '/player/hls.html?station=mbtv');
  assert.equal(PR.ownPlayerPath('/api/content/123/file'), '/api/content/123/file');
});

test('ownPlayerPath: absolute URL on the SAME host → root-relative path+query', () => {
  assert.equal(
    PR.ownPlayerPath('https://media.mbfdhub.com/player/grid.html?cells=abc&x=1'),
    '/player/grid.html?cells=abc&x=1'
  );
  assert.equal(
    PR.ownPlayerPath('https://media.mbfdhub.com/player/oz.html?oid=EMB_X'),
    '/player/oz.html?oid=EMB_X'
  );
});

test('ownPlayerPath: absolute URL on a DIFFERENT host → still OUR root-relative path', () => {
  // The whole point: the display loads from a different origin than the row was
  // saved with. The host is discarded; we keep only our own path+query.
  assert.equal(
    PR.ownPlayerPath('https://media-control.mbfdhub.com/player/grid.html?cells=abc'),
    '/player/grid.html?cells=abc'
  );
  assert.equal(
    PR.ownPlayerPath('https://media.mbfdhub.com/player/hls.html?station=wsvn&label=WSVN'),
    '/player/hls.html?station=wsvn&label=WSVN'
  );
});

test('ownPlayerPath: a hostile host on our path can never make us fetch that host', () => {
  // Discarding the host means a row pointing at evil.example/player/grid.html
  // loads OUR /player/grid.html, not evil.example. Strictly safer than before.
  assert.equal(
    PR.ownPlayerPath('https://evil.example/player/grid.html?cells=abc'),
    '/player/grid.html?cells=abc'
  );
});

test('ownPlayerPath: path traversal is normalized away by URL() before the prefix check', () => {
  // new URL() collapses '..' so it cannot escape /player/ and still match.
  const out = PR.ownPlayerPath('https://media.mbfdhub.com/player/../secret');
  assert.equal(out, null);
});

test('ownPlayerPath: genuinely foreign sites and junk → null', () => {
  assert.equal(PR.ownPlayerPath('https://wall.mbfdhub.com/'), null);
  assert.equal(PR.ownPlayerPath('https://example.com/news'), null);
  assert.equal(PR.ownPlayerPath('https://youtube-nocookie.com/embed/abc123'), null);
  assert.equal(PR.ownPlayerPath(''), null);
  assert.equal(PR.ownPlayerPath(null), null);
  assert.equal(PR.ownPlayerPath('not a url'), null);
});

test('isExternalSite: our own pages are NEVER external (any host)', () => {
  // host = the display's own location.host (here: media-control.mbfdhub.com).
  const host = 'media-control.mbfdhub.com';
  assert.equal(PR.isExternalSite('https://media.mbfdhub.com/player/grid.html?cells=abc', host), false);
  assert.equal(PR.isExternalSite('https://media.mbfdhub.com/player/hls.html?station=mbtv', host), false);
  assert.equal(PR.isExternalSite('/player/grid.html?cells=abc', host), false);
});

test('isExternalSite: a real third-party site on another host → true', () => {
  assert.equal(PR.isExternalSite('https://wall.mbfdhub.com/', 'media.mbfdhub.com'), true);
  assert.equal(PR.isExternalSite('https://example.com/dashboard', 'media.mbfdhub.com'), true);
});

test('isExternalSite: same-host third-party page → false (direct iframe)', () => {
  assert.equal(PR.isExternalSite('https://media.mbfdhub.com/some/other/page', 'media.mbfdhub.com'), false);
});

test('isExternalSite: non-absolute / empty → false', () => {
  assert.equal(PR.isExternalSite('/player/deck/abc', 'media.mbfdhub.com'), false);
  assert.equal(PR.isExternalSite('', 'media.mbfdhub.com'), false);
});

test('isGridUrl: matches our multiview page (relative and absolute)', () => {
  assert.equal(PR.isGridUrl('/player/grid.html?cells=abc'), true);
  assert.equal(PR.isGridUrl('https://media.mbfdhub.com/player/grid.html?cells=abc'), true);
  assert.equal(PR.isGridUrl('/player/hls.html?station=mbtv'), false);
  assert.equal(PR.isGridUrl('/player/grid.htmlx'), false);
});

test('isFramableSite: our own *.mbfdhub.com dashboards iframe live; third-party + our /player do not', () => {
  // The ops wall + any org dashboard → iframe live (no X-Frame-Options), full-wall.
  assert.equal(PR.isFramableSite('https://wall.mbfdhub.com/'), true);
  assert.equal(PR.isFramableSite('https://mbfdhub.com/'), true);
  assert.equal(PR.isFramableSite('https://office.mbfdhub.com/dashboard'), true);
  // Our /player pages are handled by ownPlayerPath (root-relative), never here.
  assert.equal(PR.isFramableSite('https://media.mbfdhub.com/player/grid.html?cells=abc'), false);
  // Genuinely third-party → still screenshot (would blank in a frame).
  assert.equal(PR.isFramableSite('https://example.com/'), false);
  assert.equal(PR.isFramableSite('https://www.youtube.com/watch?v=x'), false);
  // Look-alike hosts must NOT match the suffix.
  assert.equal(PR.isFramableSite('https://evil-mbfdhub.com/'), false);
  assert.equal(PR.isFramableSite('https://notmbfdhub.com/'), false);
  // Non-absolute / empty.
  assert.equal(PR.isFramableSite('/player/deck/abc'), false);
  assert.equal(PR.isFramableSite(''), false);
});
