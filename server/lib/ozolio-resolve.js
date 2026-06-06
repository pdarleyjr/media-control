// ozolio-resolve.js — resolve an Ozolio camera's live HLS (.m3u8) URL via the
// relay's init->open session handshake.
//
// WHY server-side: Ozolio's relay gates stream resolution on the embedding page's
// "document" param — only allow-listed host sites (e.g. miamiandbeaches.com) get a
// 200; arbitrary origins (our media.mbfdhub.com) get 403, so the bare relay embed
// renders black. We do the handshake here with the allow-listed document, then
// /player/oz.html plays the returned .m3u8 with hls.js (the relay serves the
// playlist + segments with Access-Control-Allow-Origin:* so they play from any
// origin — no media proxy needed). Ports the proven pattern from mbfd-ops-wall.
//
// Used by the public /player/oz-stream + /player/oz-poster routes (server.js).

const DOCUMENT = 'https://www.miamiandbeaches.com/';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
// EMB_ is the only OID form the relay resolves (CID_/raw 404). Strict whitelist —
// the oid is interpolated into the upstream URL, so this also blocks SSRF/injection.
const OID_RE = /^EMB_[A-Za-z0-9]{6,16}$/;
const TTL_MS = 90 * 1000;        // re-resolve at most ~every 90s per cam
const cache = new Map();          // oid -> { data, exp }

async function fetchJson(url, timeoutMs = 9000) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const r = await fetch(url, {
      headers: { 'User-Agent': UA, Referer: 'https://relay.ozolio.com/' },
      signal: ac.signal,
    });
    if (!r.ok) { const e = new Error(`upstream ${r.status}`); e.status = 502; throw e; }
    return await r.json();
  } finally { clearTimeout(timer); }
}

function posterUrl(oid) {
  return OID_RE.test(oid) ? `https://relay.ozolio.com/pub.api?cmd=poster&oid=${oid}` : null;
}

async function resolveOzolioStream(oid) {
  if (!OID_RE.test(oid)) { const e = new Error('invalid oid'); e.status = 400; throw e; }
  const hit = cache.get(oid);
  if (hit && hit.exp > Date.now()) return hit.data;

  const doc = encodeURIComponent(DOCUMENT);
  const init = await fetchJson(`https://relay.ozolio.com/ses.api?cmd=init&oid=${oid}&ver=5&channel=0&control=1&document=${doc}`);
  const sid = init && init.session && init.session.id;
  if (!sid || !/^[A-Za-z0-9_-]{4,64}$/.test(sid)) { const e = new Error('init: no session'); e.status = 502; throw e; }

  const open = await fetchJson(`https://relay.ozolio.com/ses.api?cmd=open&oid=${sid}&output=1&format=M3U8&profile=`);
  const source = open && open.output && open.output.source;
  if (!source || !source.includes('.m3u8')) { const e = new Error('open: no m3u8 source'); e.status = 502; throw e; }

  const data = { oid, source, poster: posterUrl(oid) };
  cache.set(oid, { data, exp: Date.now() + TTL_MS });
  return data;
}

module.exports = { resolveOzolioStream, posterUrl, OID_RE };
