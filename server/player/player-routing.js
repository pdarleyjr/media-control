/*
 * player-routing.js — how the display player decides where a web-page content
 * item actually loads from.
 *
 * ONE source of truth, loaded TWO ways (same pattern as multiview-core.js):
 *   • index.html loads it as a plain <script> (browser global `window.PlayerRouting`)
 *   • server/test/player-routing.test.js require()s it (CommonJS `module.exports`)
 *
 * THE BUG THIS FIXES: every player content row (news hls.html, cams oz.html /
 * cam.html, the multiview grid.html, decks) is stored with an ABSOLUTE url on
 * one hostname — e.g. `https://media.mbfdhub.com/player/grid.html?...`. But a
 * display can load the player from a DIFFERENT origin (the sibling hostname
 * `media-control.mbfdhub.com`, or a LAN / Tailscale / localhost address). When
 * the stored host differs from the display's own host, the old `isExternalSite`
 * test treated our OWN page as a third-party website and shunted it to the
 * server-side screenshot path (`/player/site.html`). That screenshot is a static
 * 16:9-clamped <img>: the multiview grid lost its `&aspect` (→ the tiny 4+2+4
 * fallback that wasted the whole video wall) and live news/cams became frozen
 * silent stills.
 *
 * FIX: our own `/player/*` and `/api/content/*` routes always load ROOT-RELATIVE
 * against the display's own origin, so they iframe LIVE and never screenshot —
 * regardless of which hostname the content row happened to be saved with. Only a
 * genuinely foreign site (a pasted third-party URL) still takes the screenshot
 * path. Discarding the stored host and using only the path is also strictly
 * safer: a row pointing at `https://evil.example/player/grid.html` can no longer
 * make the server fetch evil.example — we load our own `/player/grid.html`.
 *
 * Vanilla ES5 (var/function) so it parses on the same old WebKit forks the player
 * targets (Tizen, old WebOS, Fire TV).
 */
;(function (root, factory) {
  'use strict';
  var mod = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = mod;
  if (root) root.PlayerRouting = mod;
})(typeof window !== 'undefined' ? window : (typeof global !== 'undefined' ? global : this), function () {
  'use strict';

  // Path prefixes that are OUR OWN same-app pages (live, direct-iframe, never a
  // foreign-site screenshot). Mirrors the cell-URL allowlist in multiview-core.js.
  var OWN_PREFIXES = ['/player/', '/api/content/'];

  function startsWithOwn(path) {
    if (typeof path !== 'string') return false;
    for (var i = 0; i < OWN_PREFIXES.length; i++) {
      if (path.indexOf(OWN_PREFIXES[i]) === 0) return true;
    }
    return false;
  }

  // The root-relative path+query for one of our own player/content URLs — whether
  // it arrived already root-relative ("/player/hls.html?...") or absolute on any
  // host ("https://media.mbfdhub.com/player/hls.html?..."). Returns null for
  // anything that is not one of our own routes. new URL() normalizes the path, so
  // a "/player/../.." traversal can never slip past the prefix check.
  function ownPlayerPath(u) {
    if (typeof u !== 'string' || !u) return null;
    if (startsWithOwn(u)) return u;                       // already root-relative
    if (/^https?:\/\//i.test(u)) {
      try {
        var p = new URL(u);
        if (startsWithOwn(p.pathname)) return p.pathname + p.search;
      } catch (e) { /* not a parseable URL */ }
    }
    return null;
  }

  // A genuinely third-party website: an absolute http(s) URL on a host that is
  // NOT the display's own host AND is NOT one of our own player/content routes.
  // Only these get the server-side screenshot (X-Frame-Options bypass). `host` is
  // the display's own location.host (passed in so this stays pure / testable).
  function isExternalSite(u, host) {
    if (!u || !/^https?:\/\//i.test(u)) return false;
    if (ownPlayerPath(u)) return false;                   // our own page is never "external"
    try { return new URL(u).host !== host; } catch (e) { return false; }
  }

  // Our multiview composite page (so the player can append the wall's &aspect).
  function isGridUrl(u) {
    return typeof u === 'string' && /\/player\/grid\.html(\?|$)/.test(u);
  }

  // The org's OWN dashboards (any *.mbfdhub.com page that isn't one of our /player
  // routes — e.g. the live ops wall at wall.mbfdhub.com). They send no
  // X-Frame-Options / CSP frame-ancestors, so we iframe them LIVE at the display's
  // full size instead of the server-side screenshot (which clamps width to 3840px
  // and centered the ops wall on the 12372px video wall). Third-party sites are NOT
  // framable (they blank in an iframe) and still take the screenshot path. Checked
  // AFTER ownPlayerPath() (our /player pages), so it only ever sees bare dashboards.
  function isFramableSite(u) {
    if (typeof u !== 'string' || !/^https?:\/\//i.test(u)) return false;
    if (ownPlayerPath(u)) return false;                   // our /player pages route root-relative, not here
    try {
      var h = new URL(u).host.toLowerCase();
      return h === 'mbfdhub.com' || h.slice(-12) === '.mbfdhub.com';
    } catch (e) { return false; }
  }

  return {
    OWN_PREFIXES: OWN_PREFIXES,
    ownPlayerPath: ownPlayerPath,
    isExternalSite: isExternalSite,
    isGridUrl: isGridUrl,
    isFramableSite: isFramableSite
  };
});
