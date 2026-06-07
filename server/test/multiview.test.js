const { test } = require('node:test');
const assert = require('node:assert/strict');
const MV = require('../player/multiview-core.js');

// The Multiview layout's geometry + cell-URL allowlist are the contract grid.html
// renders against and the composer encodes to. These tests lock both: the 4+2+4
// slots must tile a 16:9 canvas with every cell itself 16:9, and only same-origin
// player/content paths + youtube-nocookie embeds may ever become a cell.

test('SLOTS: 10 frames, 4 left / 2 center / 4 right', () => {
  assert.equal(MV.SLOTS.length, 10);
  const bySide = (s) => MV.SLOTS.filter((z) => z.side === s).length;
  assert.equal(bySide('left'), 4);
  assert.equal(bySide('center'), 2);
  assert.equal(bySide('right'), 4);
});

test('SLOTS: every cell is square in percent space (=> 16:9 on a 16:9 canvas)', () => {
  // A w% x h% rect on a 16:9 canvas has pixel ratio (w*16):(h*9); it equals 16:9
  // exactly when w === h. All ten cells must satisfy that.
  for (const s of MV.SLOTS) assert.equal(s.w, s.h, `slot ${s.id} not square`);
});

test('SLOTS: columns tile the canvas with no gaps or overlap', () => {
  // Each column's heights sum to 100; the three columns' widths sum to 100 at
  // every row band.
  const left = MV.SLOTS.filter((s) => s.side === 'left');
  const right = MV.SLOTS.filter((s) => s.side === 'right');
  const center = MV.SLOTS.filter((s) => s.side === 'center');
  const sumH = (arr) => arr.reduce((a, s) => a + s.h, 0);
  assert.equal(sumH(left), 100);
  assert.equal(sumH(right), 100);
  assert.equal(sumH(center), 100);
  // Left col at x=0 w=25, center x=25 w=50, right x=75 w=25 => spans 0..100.
  assert.ok(left.every((s) => s.x === 0 && s.w === 25));
  assert.ok(center.every((s) => s.x === 25 && s.w === 50));
  assert.ok(right.every((s) => s.x === 75 && s.w === 25));
});

test('isAllowedCellUrl accepts same-origin player/content paths', () => {
  assert.ok(MV.isAllowedCellUrl('/player/oz.html?oid=EMB_RANL0000044E'));
  assert.ok(MV.isAllowedCellUrl('/player/hls.html?station=cbs&audio=1'));
  assert.ok(MV.isAllowedCellUrl('/player/cam.html?id=470'));
  assert.ok(MV.isAllowedCellUrl('/player/deck/abc-123'));
  assert.ok(MV.isAllowedCellUrl('/api/content/abc-123/file'));
});

test('isAllowedCellUrl accepts youtube-nocookie embeds only', () => {
  assert.ok(MV.isAllowedCellUrl('https://www.youtube-nocookie.com/embed/4UzQd1dVPlo?autoplay=1&mute=1'));
  assert.ok(MV.isAllowedCellUrl('https://youtube-nocookie.com/embed/4UzQd1dVPlo'));
  assert.ok(!MV.isAllowedCellUrl('https://www.youtube.com/watch?v=4UzQd1dVPlo'));
  assert.ok(!MV.isAllowedCellUrl('https://www.youtube.com/embed/4UzQd1dVPlo'));
});

test('isAllowedCellUrl rejects foreign origins, schemes, traversal, junk', () => {
  assert.ok(!MV.isAllowedCellUrl('https://evil.example.com/x'));
  assert.ok(!MV.isAllowedCellUrl('http://media.mbfdhub.com/player/oz.html')); // http, not relative/nocookie
  assert.ok(!MV.isAllowedCellUrl('javascript:alert(1)'));
  assert.ok(!MV.isAllowedCellUrl('data:text/html,<h1>x</h1>'));
  assert.ok(!MV.isAllowedCellUrl('/player/../secret'));
  assert.ok(!MV.isAllowedCellUrl('/player/oz.html"><img src=x>'));
  assert.ok(!MV.isAllowedCellUrl('/player/oz.html onload'));   // space
  assert.ok(!MV.isAllowedCellUrl(''));
  assert.ok(!MV.isAllowedCellUrl(null));
  assert.ok(!MV.isAllowedCellUrl(undefined));
});

test('encodeCells -> decodeCells round-trips a clean map', () => {
  const map = {
    C1: { u: '/player/hls.html?station=cbs', l: 'CBS News Miami', k: 'i' },
    L1: { u: '/player/oz.html?oid=EMB_RANL0000044E', l: 'Ocean Drive', k: 'i' },
    R4: { u: '/api/content/v1/file', l: 'Promo', k: 'v' },
  };
  const decoded = MV.decodeCells(MV.encodeCells(map));
  assert.deepEqual(decoded, map);
});

test('decodeCells sanitizes: drops bad slots/urls, defaults kind, truncates label', () => {
  const longLabel = 'x'.repeat(200);
  const map = {
    C1: { u: '/player/oz.html?oid=EMB_A1', l: longLabel, k: 'zzz' }, // bad kind -> i, label trunc
    ZZ: { u: '/player/oz.html', l: 'unknown slot', k: 'i' },        // unknown slot -> dropped
    L2: { u: 'https://evil.com/x', l: 'bad url', k: 'i' },          // disallowed -> dropped
  };
  const decoded = MV.decodeCells(MV.encodeCells(map));
  assert.deepEqual(Object.keys(decoded), ['C1']);
  assert.equal(decoded.C1.k, 'i');
  assert.equal(decoded.C1.l.length, MV.LABEL_MAX);
});

test('decodeCells never throws on garbage', () => {
  assert.deepEqual(MV.decodeCells(''), {});
  assert.deepEqual(MV.decodeCells('not-valid-base64url!!!'), {});
  assert.deepEqual(MV.decodeCells('Zm9v'), {});           // "foo" — not an object
  assert.deepEqual(MV.decodeCells(undefined), {});
});

// ---- reactive layout: optional per-cell geometry (backward compatible) ----

test('decodeCells carries valid per-cell geometry, round-trips', () => {
  const map = {
    C1: { u: '/player/hls.html?station=cbs', l: 'CBS', k: 'i', x: 25, y: 0, w: 60, h: 55 },
    L1: { u: '/player/oz.html?oid=EMB_A1', l: 'Cam', k: 'i' }, // no geometry -> stays {u,l,k}
  };
  const decoded = MV.decodeCells(MV.encodeCells(map));
  assert.deepEqual(decoded, map);
  // The no-geometry cell must NOT gain geometry keys (preserves the default-layout
  // byte-identical contract).
  assert.deepEqual(Object.keys(decoded.L1).sort(), ['k', 'l', 'u']);
});

test('decodeCells drops invalid/out-of-range geometry entirely', () => {
  const map = {
    C1: { u: '/player/oz.html?oid=EMB_A1', l: 'a', k: 'i', x: -5, y: 0, w: 50, h: 50 },   // x<0
    C2: { u: '/player/oz.html?oid=EMB_A2', l: 'b', k: 'i', x: 0, y: 0, w: 0, h: 50 },     // w=0
    R1: { u: '/player/oz.html?oid=EMB_A3', l: 'c', k: 'i', x: 10, y: 10, w: 'big', h: 5 },// NaN
  };
  const decoded = MV.decodeCells(MV.encodeCells(map));
  for (const id of ['C1', 'C2', 'R1']) {
    assert.deepEqual(Object.keys(decoded[id]).sort(), ['k', 'l', 'u'], `${id} kept bad geometry`);
  }
});

test('decodeCells supports a share cell (no url) with optional geometry', () => {
  const map = { C1: { l: 'Screen Share', k: 'share', x: 25, y: 0, w: 50, h: 50 } };
  const decoded = MV.decodeCells(MV.encodeCells(map));
  assert.deepEqual(decoded, map);
  // A share cell with NO url is still kept (the share is a WebRTC overlay).
  const bare = MV.decodeCells(MV.encodeCells({ R2: { l: 'Share', k: 'share' } }));
  assert.deepEqual(bare, { R2: { l: 'Share', k: 'share' } });
});

// ---- reactive layout: reflow geometry ----

test('rectForCell uses cell geometry when valid, else the fixed slot', () => {
  assert.deepEqual(MV.rectForCell('C1', { x: 10, y: 20, w: 30, h: 40 }), { x: 10, y: 20, w: 30, h: 40 });
  assert.deepEqual(MV.rectForCell('C1', { u: 'x' }), { x: 25, y: 0, w: 50, h: 50 }); // C1 slot
  assert.deepEqual(MV.rectForCell('L1', null), { x: 0, y: 0, w: 25, h: 25 });        // L1 slot
});

test('reflowAroundActive: growing a tile leaves NO overlap with it and stays in 0..100', () => {
  // Start from the fixed 4+2+4 slot rects, then grow C1 (center-top) to 60x60.
  const rects = {};
  for (const s of MV.SLOTS) rects[s.id] = { x: s.x, y: s.y, w: s.w, h: s.h };
  rects.C1 = { x: 20, y: 0, w: 60, h: 60 };
  const out = MV.reflowAroundActive(rects, 'C1');
  const A = out.C1;
  for (const id of Object.keys(out)) {
    const r = out[id];
    assert.ok(r.x >= 0 && r.y >= 0 && r.x + r.w <= 100.001 && r.y + r.h <= 100.001, `${id} out of bounds: ${JSON.stringify(r)}`);
    assert.ok(r.w >= MV.MIN_PCT - 1e-9 && r.h >= MV.MIN_PCT - 1e-9, `${id} below min size`);
    if (id === 'C1') continue;
    assert.ok(!MV.overlaps(A, r), `${id} still overlaps the active tile: ${JSON.stringify(r)}`);
  }
  // The active tile is pinned (unchanged).
  assert.deepEqual(out.C1, { x: 20, y: 0, w: 60, h: 60 });
});

test('reflowAroundActive: a non-overlapping resize leaves neighbors untouched', () => {
  const rects = {};
  for (const s of MV.SLOTS) rects[s.id] = { x: s.x, y: s.y, w: s.w, h: s.h };
  // Shrink C1 to 40x40 (no new overlap — it only frees space).
  rects.C1 = { x: 25, y: 0, w: 40, h: 40 };
  const out = MV.reflowAroundActive(rects, 'C1');
  for (const s of MV.SLOTS) {
    if (s.id === 'C1') continue;
    assert.deepEqual(out[s.id], { x: s.x, y: s.y, w: s.w, h: s.h }, `${s.id} should be untouched`);
  }
});
