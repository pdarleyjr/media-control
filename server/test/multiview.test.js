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

// ---- per-cell media fit (Fill/Fit) — optional, backward compatible ----

test('isFit accepts only the two literal modes', () => {
  assert.ok(MV.isFit('cover'));
  assert.ok(MV.isFit('contain'));
  assert.ok(!MV.isFit('fill'));
  assert.ok(!MV.isFit('COVER'));
  assert.ok(!MV.isFit(''));
  assert.ok(!MV.isFit(true));
  assert.ok(!MV.isFit(undefined));
});

test('decodeCells keeps f when it is cover or contain, round-trips', () => {
  const map = {
    C1: { u: '/player/hls.html?station=cbs&fit=cover', l: 'CBS', k: 'i', f: 'cover' },
    L1: { u: '/player/oz.html?oid=EMB_A1', l: 'Cam', k: 'i', f: 'contain' },
  };
  const decoded = MV.decodeCells(MV.encodeCells(map));
  assert.deepEqual(decoded, map);
});

test('decodeCells DROPS any f value other than cover/contain', () => {
  const map = {
    C1: { u: '/player/oz.html?oid=EMB_A1', l: 'a', k: 'i', f: 'fill' },      // bogus mode
    C2: { u: '/player/oz.html?oid=EMB_A2', l: 'b', k: 'i', f: 'COVER' },     // wrong case
    R1: { u: '/player/oz.html?oid=EMB_A3', l: 'c', k: 'i', f: 1 },           // non-string
  };
  const decoded = MV.decodeCells(MV.encodeCells(map));
  // No cell may carry an `f` key, and an omitted f means default (cover) — so a
  // cell with a bad f decodes to exactly {u,l,k}.
  for (const id of ['C1', 'C2', 'R1']) {
    assert.deepEqual(Object.keys(decoded[id]).sort(), ['k', 'l', 'u'], `${id} kept bad f`);
  }
});

test('f does NOT relax the URL allowlist (foreign origins still rejected)', () => {
  // A valid fit on a disallowed URL must still drop the whole cell.
  const decoded = MV.decodeCells(MV.encodeCells({
    C1: { u: 'https://evil.example.com/x', l: 'bad', k: 'i', f: 'cover' },
  }));
  assert.deepEqual(decoded, {});
  // Sanity: the allowlist itself is byte-for-byte unchanged.
  assert.ok(MV.isAllowedCellUrl('/player/oz.html?oid=EMB_A1&fit=cover'));
  assert.ok(!MV.isAllowedCellUrl('https://evil.example.com/x'));
  assert.ok(!MV.isAllowedCellUrl('/player/../secret'));
});

test('f combines with geometry and round-trips', () => {
  const map = { C1: { u: '/player/cam.html?id=470&fit=cover', l: 'Cam', k: 'i', f: 'cover', x: 25, y: 0, w: 60, h: 55 } };
  const decoded = MV.decodeCells(MV.encodeCells(map));
  assert.deepEqual(decoded, map);
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

// ---- aspect-aware tiling: derive screen count + per-screen-aspect tile maps ----
// One physical screen is ~16:9; an N-screen wall has aspect ~= N*16/9. layoutForAspect
// returns ONLY the slots that have a tile on a given target, each cell equal to the
// per-screen aspect so the mosaic tiles the wall completely (contain pillarboxes ~3.4%).

test('normalizeAspect coerces strings and rejects junk to 16/9', () => {
  assert.equal(MV.normalizeAspect('5.7278'), 5.7278);
  assert.equal(MV.normalizeAspect(''), 16 / 9);
  assert.equal(MV.normalizeAspect('-1'), 16 / 9);
  assert.equal(MV.normalizeAspect(undefined), 16 / 9);
  assert.equal(MV.normalizeAspect(NaN), 16 / 9);
  assert.equal(MV.normalizeAspect(0), 16 / 9);
});

test('screensFor rounds aspect/16:9 to a screen count (min 1)', () => {
  assert.equal(MV.screensFor(16 / 9), 1);
  assert.equal(MV.screensFor(21 / 9), 1);          // 2.3333 -> 1.31 -> 1
  assert.equal(MV.screensFor(12372 / 2160), 3);    // 5.7278 -> 3.22 -> 3
  assert.equal(MV.screensFor(8248 / 2160), 2);     // 3.8185 -> 2.15 -> 2
  assert.equal(MV.screensFor(32 / 9), 2);          // 3.5556 -> 2.00 -> 2
});

test('layoutForAspect(16:9) is the unchanged fixed 4+2+4 (all 10 slots)', () => {
  const lay = MV.layoutForAspect(16 / 9);
  assert.equal(Object.keys(lay).length, 10);
  for (const s of MV.SLOTS) {
    assert.deepEqual(lay[s.id], { x: s.x, y: s.y, w: s.w, h: s.h }, `slot ${s.id}`);
  }
});

test('layoutForAspect(3-screen wall): center-primary + 2x2 flanks, fills the wall', () => {
  const A = 12372 / 2160;
  const lay = MV.layoutForAspect(A);
  assert.equal(lay.C2, undefined);                 // C2 has no tile on a 3-screen wall
  assert.equal(Object.keys(lay).length, 9);
  assert.deepEqual(lay.C1, { x: 100 / 3, y: 0, w: 100 / 3, h: 100 });
  // Tiles cover the whole canvas exactly.
  let area = 0;
  for (const id of Object.keys(lay)) area += lay[id].w * lay[id].h;
  assert.ok(Math.abs(area - 10000) < 1e-6, `area=${area}`);
  // No two tiles overlap.
  const ids = Object.keys(lay);
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      assert.ok(!MV.overlaps(lay[ids[i]], lay[ids[j]]), `${ids[i]} overlaps ${ids[j]}`);
    }
  }
  // Every present tile has the per-screen pixel aspect = wall_aspect/3.
  const perScreen = A / 3;
  for (const id of ids) {
    const r = lay[id];
    assert.ok(Math.abs(A * (r.w / r.h) - perScreen) < 1e-6, `${id} pixel aspect off`);
  }
});

test('layoutForAspect(2-screen wall): two 2x2 screens, fills the wall', () => {
  const A = 8248 / 2160;
  const lay = MV.layoutForAspect(A);
  assert.equal(lay.C1, undefined);                 // both center slots omitted on a 2-screen wall
  assert.equal(lay.C2, undefined);
  assert.equal(Object.keys(lay).length, 8);
  let area = 0;
  for (const id of Object.keys(lay)) area += lay[id].w * lay[id].h;
  assert.ok(Math.abs(area - 10000) < 1e-6, `area=${area}`);
  const ids = Object.keys(lay);
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      assert.ok(!MV.overlaps(lay[ids[i]], lay[ids[j]]), `${ids[i]} overlaps ${ids[j]}`);
    }
  }
  const perScreen = A / 2;
  for (const id of ids) {
    const r = lay[id];
    assert.ok(Math.abs(A * (r.w / r.h) - perScreen) < 1e-6, `${id} pixel aspect off`);
  }
});

test('layoutForAspect(21:9, S=1) falls back to the fixed slots (no remap)', () => {
  const lay = MV.layoutForAspect(2.3333);
  assert.equal(Object.keys(lay).length, 10);
  for (const s of MV.SLOTS) {
    assert.deepEqual(lay[s.id], { x: s.x, y: s.y, w: s.w, h: s.h }, `slot ${s.id}`);
  }
});

test('rectForCell with a layout: operator geom wins, else the tile, else null', () => {
  const wallLayout = MV.layoutForAspect(12372 / 2160);
  // Operator-resized cell: its own geometry is returned as-is even with a layout.
  assert.deepEqual(MV.rectForCell('L1', { x: 5, y: 5, w: 20, h: 20 }, wallLayout), { x: 5, y: 5, w: 20, h: 20 });
  // A no-geometry cell takes the aspect tile for its slot.
  assert.deepEqual(MV.rectForCell('C1', { u: 'x' }, wallLayout), { x: 100 / 3, y: 0, w: 100 / 3, h: 100 });
  // A slot with no tile on this target returns null.
  assert.equal(MV.rectForCell('C2', { u: 'x' }, wallLayout), null);
  // Backward compatible: with NO layout arg, falls back to the fixed slot rect.
  assert.deepEqual(MV.rectForCell('L1', null), { x: 0, y: 0, w: 25, h: 25 });
});

// ---- wall audio: a single cell may carry sound; everything else stays muted ----
function enc(map) { return MV.encodeCells(map); }

test('decodeCells: keeps a:1 on an audio-capable cell (video / oz / hls)', () => {
  const d = MV.decodeCells(enc({
    C1: { u: '/player/hls.html?station=mbtv', l: 'MBTV', k: 'i', a: 1 },
    L1: { u: '/api/content/5/file', l: 'clip', k: 'v', a: 1 },
  }));
  assert.equal(d.C1.a, 1);
  assert.equal(d.L1.a, 1);
});

test('decodeCells: DROPS a:1 on a non-audio cell (image / cam / youtube / doc)', () => {
  const d = MV.decodeCells(enc({
    L1: { u: '/api/content/9/file', l: 'pic', k: 'm', a: 1 },          // image
    L2: { u: '/player/cam.html?id=470', l: 'cam', k: 'i', a: 1 },      // jpeg snapshot
    L3: { u: 'https://www.youtube-nocookie.com/embed/abc123', l: 'yt', k: 'i', a: 1 },
  }));
  assert.equal(d.L1.a, undefined);
  assert.equal(d.L2.a, undefined);
  assert.equal(d.L3.a, undefined);
});

test('audioSlotId: returns the first (SLOT-order) cell flagged a:1, else null', () => {
  // R1 comes after C1 in SLOT order, so C1 wins even though both are flagged.
  const both = MV.decodeCells(enc({
    R1: { u: '/player/oz.html?oid=X', l: 'cam', k: 'i', a: 1 },
    C1: { u: '/player/hls.html?station=mbtv', l: 'MBTV', k: 'i', a: 1 },
  }));
  assert.equal(MV.audioSlotId(both), 'C1');
  // None flagged → null (the whole wall is muted, the default).
  const none = MV.decodeCells(enc({ C1: { u: '/player/hls.html?station=mbtv', l: 'x', k: 'i' } }));
  assert.equal(MV.audioSlotId(none), null);
  assert.equal(MV.audioSlotId({}), null);
});

test('isAudioCapable: video + oz/hls only', () => {
  assert.equal(MV.isAudioCapable('v', '/api/content/1/file'), true);
  assert.equal(MV.isAudioCapable('i', '/player/hls.html?station=mbtv'), true);
  assert.equal(MV.isAudioCapable('i', '/player/oz.html?oid=X'), true);
  assert.equal(MV.isAudioCapable('i', '/player/cam.html?id=1'), false);
  assert.equal(MV.isAudioCapable('m', '/api/content/1/file'), false);
  assert.equal(MV.isAudioCapable('i', 'https://www.youtube-nocookie.com/embed/abc123'), false);
});

// ---- single-spanning-device column split (&split=N) -------------------------
// A wall driven by ONE device (Mosaic) is split into N independently-droppable
// full-height columns. grid.html forces splitColumnsLayout() when &split=N, so the
// halves render edge-to-edge (NOT the aspect mosaic, which would put them in the
// top corners). These lock the geometry + that the ids are real SLOTs decodeCells keeps.
test('splitColumnsLayout(2): two full-height halves at L1/R1, tiling the canvas', () => {
  const lay = MV.splitColumnsLayout(2);
  assert.deepEqual(Object.keys(lay).sort(), ['L1', 'R1']);
  assert.deepEqual(lay.L1, { x: 0, y: 0, w: 50, h: 100 });
  assert.deepEqual(lay.R1, { x: 50, y: 0, w: 50, h: 100 });
  assert.ok(!MV.overlaps(lay.L1, lay.R1));
  assert.equal(lay.L1.w * lay.L1.h + lay.R1.w * lay.R1.h, 10000);   // full coverage, no gaps
});

test('splitColumnsLayout(3): three full-height thirds at L1/C1/R1', () => {
  const lay = MV.splitColumnsLayout(3);
  assert.deepEqual(Object.keys(lay).sort(), ['C1', 'L1', 'R1']);
  for (const id of ['L1', 'C1', 'R1']) assert.equal(lay[id].h, 100);
  assert.ok(Math.abs(lay.L1.w - 100 / 3) < 1e-9);
  assert.ok(Math.abs(lay.C1.x - 100 / 3) < 1e-9);
});

test('splitColumnIds: clamped 2..4 and every id is a real SLOT (decodeCells keeps it)', () => {
  assert.deepEqual(MV.splitColumnIds(1), ['L1', 'R1']);   // clamps up to 2
  assert.deepEqual(MV.splitColumnIds(9), MV.splitColumnIds(4)); // clamps down to 4
  for (const n of [2, 3, 4]) {
    for (const id of MV.splitColumnIds(n)) assert.ok(MV.SLOT_BY_ID[id], `${id} is a SLOT`);
  }
});

test('decodeCells round-trips a 2-column split payload (L1/R1 kept, allowlisted)', () => {
  const enc = (m) => MV.encodeCells(m);
  const out = MV.decodeCells(enc({
    L1: { u: '/api/content/abc/file', l: 'Left', k: 'm' },
    R1: { u: '/player/hls.html?station=mbtv', l: 'Right', k: 'i' },
  }));
  assert.deepEqual(Object.keys(out).sort(), ['L1', 'R1']);
  assert.equal(out.L1.u, '/api/content/abc/file');
  assert.equal(out.R1.u, '/player/hls.html?station=mbtv');
});
