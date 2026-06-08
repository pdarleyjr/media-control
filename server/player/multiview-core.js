/*
 * multiview-core.js — shared spec for the "Multiview Layout" composite player.
 *
 * ONE source of truth, loaded TWO ways so the security boundary can never drift:
 *   • grid.html loads it as a plain <script> (browser global `window.Multiview`)
 *   • server/test/multiview.test.js require()s it (CommonJS `module.exports`)
 * The command-center composer (frontend/js/views/media-control/multiview.js)
 * mirrors SLOTS + the cell-URL rules; the Playwright render test feeds a
 * composer-encoded URL through grid.html, which catches any mismatch.
 *
 * Vanilla ES5 (var/function, no arrow/const) so grid.html boots on the same
 * ancient WebKit forks the main player targets (Tizen 4, old WebOS, Fire TV).
 */
;(function (root, factory) {
  'use strict';
  var mod = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = mod;
  if (root) root.Multiview = mod;
})(typeof window !== 'undefined' ? window : (typeof global !== 'undefined' ? global : this), function () {
  'use strict';

  // The 4-left / 2-center / 4-right mosaic, in PERCENT of the canvas. On a 16:9
  // canvas EVERY cell is itself exactly 16:9: the side columns are 25% wide x
  // 25% tall (-> 480x270 on 1920x1080) and the two center cells are 50% wide x
  // 50% tall (-> 960x540) — i.e. 2x the linear size / 4x the area of a side
  // cell, which is what makes the center the "large" frames. Left+center+right
  // widths sum to 100; each column's heights sum to 100, so the cells tile the
  // canvas with no gaps. KEEP IN SYNC with SLOTS in the composer (multiview.js).
  var SLOTS = [
    { id: 'L1', x: 0,  y: 0,  w: 25, h: 25, side: 'left'   },
    { id: 'L2', x: 0,  y: 25, w: 25, h: 25, side: 'left'   },
    { id: 'L3', x: 0,  y: 50, w: 25, h: 25, side: 'left'   },
    { id: 'L4', x: 0,  y: 75, w: 25, h: 25, side: 'left'   },
    { id: 'C1', x: 25, y: 0,  w: 50, h: 50, side: 'center' },
    { id: 'C2', x: 25, y: 50, w: 50, h: 50, side: 'center' },
    { id: 'R1', x: 75, y: 0,  w: 25, h: 25, side: 'right'  },
    { id: 'R2', x: 75, y: 25, w: 25, h: 25, side: 'right'  },
    { id: 'R3', x: 75, y: 50, w: 25, h: 25, side: 'right'  },
    { id: 'R4', x: 75, y: 75, w: 25, h: 25, side: 'right'  }
  ];

  var SLOT_BY_ID = {};
  for (var i = 0; i < SLOTS.length; i++) SLOT_BY_ID[SLOTS[i].id] = SLOTS[i];

  // Cell render kinds: i = iframe (camera/news/youtube/deck), v = <video> file,
  // m = <img> (image file). Unknown kinds fall back to iframe. The special kind
  // 'share' marks a screen-share frame: it carries NO url (the share is a WebRTC
  // overlay the receiver mounts on top of the cell rect — see screen-share
  // wall-tile mode), so grid.html renders a labelled placeholder behind it.
  var KINDS = { i: 1, v: 1, m: 1 };

  var LABEL_MAX = 80;

  // Reactive-layout geometry. A cell MAY carry its own {x,y,w,h} percent rect
  // (operator resized it); when absent the cell uses its fixed SLOT rect, so a
  // default 4+2+4 layout encodes/decodes byte-identically (no regression).
  var MIN_PCT = 5;                                   // smallest tile edge, percent
  function isPct(n) { return typeof n === 'number' && isFinite(n) && n >= 0 && n <= 100; }
  function clampPct(v) { return Math.max(0, Math.min(100, v)); }

  // Per-cell media fit. The default (omitted) is 'cover' — content FILLS the cell
  // (grid.html's base object-fit), so a 16:9 feed in a now-ultra-wide cell uses the
  // whole frame instead of letterboxing. 'contain' opts a single cell back into
  // no-crop letterbox. Only those two strings are ever honored.
  function isFit(v) { return v === 'cover' || v === 'contain'; }

  // ---- the SECURITY BOUNDARY ----------------------------------------------
  // grid.html renders these URLs on a CSP-free /player page (iframe/video/img),
  // so a cell URL may ONLY be a same-origin player/content path or a
  // youtube-nocookie embed. Everything else is rejected and the cell renders a
  // labelled placeholder — never an attacker-chosen origin. Mirrors the OID_RE
  // / station-whitelist philosophy of oz.html / hls.html: the client never gets
  // to point a tile at an arbitrary URL.
  //
  // Composer normalizes same-origin absolutes to ROOT-RELATIVE ("/player/...",
  // "/api/content/...") before encoding, so only those relative forms and the
  // absolute youtube-nocookie embed need to be allowed here.
  var BAD_CHARS = /[\s<>"'`\\]/;            // whitespace / markup / quote / backslash
  function hasControlChar(u) {
    for (var i = 0; i < u.length; i++) { if (u.charCodeAt(i) < 0x20) return true; }
    return false;
  }
  function isAllowedCellUrl(u) {
    if (typeof u !== 'string' || !u) return false;
    if (u.indexOf('..') !== -1) return false;                       // no traversal
    if (BAD_CHARS.test(u) || hasControlChar(u)) return false;       // no markup/control chars
    if (u.indexOf('/player/') === 0) return true;                   // oz.html / hls.html / cam.html / deck/<id>
    if (u.indexOf('/api/content/') === 0) return true;              // uploaded file / thumbnail
    return /^https:\/\/(www\.)?youtube-nocookie\.com\/embed\/[A-Za-z0-9_-]{6,15}(\?[^\s]*)?$/.test(u);
  }

  // base64url <-> string (UTF-8 safe). Works in browser (btoa/atob over an
  // escaped UTF-8 byte string) and in Node (Buffer).
  function toB64(bytes) {
    if (typeof Buffer !== 'undefined') return Buffer.from(bytes, 'utf8').toString('base64');
    return btoa(unescape(encodeURIComponent(bytes)));
  }
  function fromB64(b64) {
    if (typeof Buffer !== 'undefined') return Buffer.from(b64, 'base64').toString('utf8');
    return decodeURIComponent(escape(atob(b64)));
  }
  function b64urlEncode(str) {
    return toB64(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  function b64urlDecode(s) {
    var b = String(s).replace(/-/g, '+').replace(/_/g, '/');
    while (b.length % 4) b += '=';
    return fromB64(b);
  }

  // Encode a {slotId: {u,l,k}} map to a compact base64url query value.
  function encodeCells(map) {
    return b64urlEncode(JSON.stringify(map || {}));
  }

  // Decode + SANITIZE a cells param into a clean {slotId: {u,l,k[,f][,x,y,w,h]}} map.
  // Drops unknown slots, disallowed URLs, and bad kinds; passes per-cell geometry
  // through ONLY when all four are valid percentages (else omits it entirely, so a
  // default-layout cell decodes to exactly {u,l,k}). The optional media-fit `f` is
  // kept ONLY when it is the literal 'cover' or 'contain' (any other value is
  // dropped; an omitted `f` means default = cover). Never throws.
  function decodeCells(param) {
    var out = {};
    if (!param) return out;
    var raw;
    try { raw = JSON.parse(b64urlDecode(param)); } catch (e) { return out; }
    if (!raw || typeof raw !== 'object') return out;
    for (var id in raw) {
      if (!Object.prototype.hasOwnProperty.call(raw, id)) continue;
      if (!SLOT_BY_ID[id]) continue;
      var c = raw[id];
      if (!c || typeof c !== 'object') continue;
      var label = typeof c.l === 'string' ? c.l.slice(0, LABEL_MAX) : '';
      var cell;
      if (c.k === 'share') {
        // Screen-share placeholder: no URL (the share is a WebRTC overlay).
        cell = { l: label, k: 'share' };
      } else {
        if (!isAllowedCellUrl(c.u)) continue;
        var kind = (typeof c.k === 'string' && KINDS[c.k]) ? c.k : 'i';
        cell = { u: c.u, l: label, k: kind };
      }
      // Optional media-fit — kept ONLY when explicitly 'cover' or 'contain'.
      if (isFit(c.f)) cell.f = c.f;
      // Optional reactive geometry — only when all four are valid, positive %.
      if (isPct(c.x) && isPct(c.y) && isPct(c.w) && isPct(c.h) && c.w > 0 && c.h > 0) {
        cell.x = +c.x; cell.y = +c.y; cell.w = +c.w; cell.h = +c.h;
      }
      out[id] = cell;
    }
    return out;
  }

  // ---- reactive tiling geometry (pure — shared by the composer + unit tests) --
  // The effective rect of a cell: its own {x,y,w,h} when present, else its fixed
  // SLOT rect. Keeps grid.html + the composer agreeing on geometry.
  function rectForCell(id, cell) {
    if (cell && isPct(cell.x) && isPct(cell.y) && cell.w > 0 && cell.h > 0) {
      return { x: cell.x, y: cell.y, w: cell.w, h: cell.h };
    }
    var s = SLOT_BY_ID[id];
    return s ? { x: s.x, y: s.y, w: s.w, h: s.h } : { x: 0, y: 0, w: 100, h: 100 };
  }

  function overlaps(a, b) {
    return !(a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y);
  }

  // SHRINK-only reflow. After the active rect changes, every OTHER rect that
  // overlaps it is shrunk along its least-penetration axis so its NEAR edge abuts
  // the active rect — its FAR edge never moves, so reflow introduces NO new
  // overlap between neighbours (no cascade) and nothing leaves 0..100. The active
  // rect is pinned (operator intent wins). `rects` = { id: {x,y,w,h} }; returns a
  // fresh map. Tiles that get fully covered collapse to a MIN_PCT sliver at the
  // active edge rather than inverting.
  function reflowAroundActive(rects, activeId) {
    var out = {};
    for (var k in rects) out[k] = { x: rects[k].x, y: rects[k].y, w: rects[k].w, h: rects[k].h };
    var a = out[activeId];
    if (!a) return out;
    for (var id in out) {
      if (id === activeId) continue;
      var b = out[id];
      if (!overlaps(a, b)) continue;
      var ox = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
      var oy = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
      if (ox <= 0 || oy <= 0) continue;
      if (ox <= oy) {
        // horizontal: keep b's far edge, push its near edge to a's edge
        if ((b.x + b.w / 2) >= (a.x + a.w / 2)) { var right = b.x + b.w; b.x = a.x + a.w; b.w = right - b.x; }
        else { b.w = a.x - b.x; }
      } else {
        // vertical
        if ((b.y + b.h / 2) >= (a.y + a.h / 2)) { var bottom = b.y + b.h; b.y = a.y + a.h; b.h = bottom - b.y; }
        else { b.h = a.y - b.y; }
      }
      if (b.w < MIN_PCT) b.w = MIN_PCT;
      if (b.h < MIN_PCT) b.h = MIN_PCT;
      b.x = clampPct(b.x); b.y = clampPct(b.y);
      if (b.x + b.w > 100) b.x = Math.max(0, 100 - b.w);
      if (b.y + b.h > 100) b.y = Math.max(0, 100 - b.h);
    }
    return out;
  }

  return {
    SLOTS: SLOTS,
    SLOT_BY_ID: SLOT_BY_ID,
    KINDS: KINDS,
    LABEL_MAX: LABEL_MAX,
    MIN_PCT: MIN_PCT,
    isPct: isPct,
    clampPct: clampPct,
    isFit: isFit,
    isAllowedCellUrl: isAllowedCellUrl,
    b64urlEncode: b64urlEncode,
    b64urlDecode: b64urlDecode,
    encodeCells: encodeCells,
    decodeCells: decodeCells,
    rectForCell: rectForCell,
    overlaps: overlaps,
    reflowAroundActive: reflowAroundActive
  };
});
