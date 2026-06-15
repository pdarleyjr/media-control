// Resolve an Ozolio camera's live HLS URL via the relay init/open handshake.
// The server does this because Ozolio gates resolution on an allow-listed
// embedding document; the returned HLS playlist/segments are CORS-open.

const DOCUMENT = 'https://www.miamiandbeaches.com/';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const OID_RE = /^EMB_[A-Za-z0-9]{6,16}$/;
const TTL_MS = 90 * 1000;
const cache = new Map();

async function fetchJson(url, timeoutMs = 9000) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      headers: { 'User-Agent': UA, Referer: 'https://relay.ozolio.com/' },
      signal: ac.signal,
    });
    if (!response.ok) {
      const error = new Error(`upstream ${response.status}`);
      error.status = 502;
      throw error;
    }
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

function posterUrl(oid) {
  return OID_RE.test(oid) ? `https://relay.ozolio.com/pub.api?cmd=poster&oid=${oid}` : null;
}

async function resolveOzolioStream(oid) {
  if (!OID_RE.test(oid)) {
    const error = new Error('invalid oid');
    error.status = 400;
    throw error;
  }
  const hit = cache.get(oid);
  if (hit && hit.exp > Date.now()) return hit.data;

  const doc = encodeURIComponent(DOCUMENT);
  const init = await fetchJson(`https://relay.ozolio.com/ses.api?cmd=init&oid=${oid}&ver=5&channel=0&control=1&document=${doc}`);
  const sid = init && init.session && init.session.id;
  if (!sid || !/^[A-Za-z0-9_-]{4,64}$/.test(sid)) {
    const error = new Error('init: no session');
    error.status = 502;
    throw error;
  }

  const open = await fetchJson(`https://relay.ozolio.com/ses.api?cmd=open&oid=${sid}&output=1&format=M3U8&profile=`);
  const source = open && open.output && open.output.source;
  if (!source || !source.includes('.m3u8')) {
    const error = new Error('open: no m3u8 source');
    error.status = 502;
    throw error;
  }

  const data = { oid, source, poster: posterUrl(oid) };
  cache.set(oid, { data, exp: Date.now() + TTL_MS });
  return data;
}

module.exports = { resolveOzolioStream, posterUrl, OID_RE };
