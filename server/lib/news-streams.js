// news-streams.js — resolve a whitelisted Miami live-NEWS channel key to a
// playable HLS .m3u8 for the Camera Feeds "Live News" folder.
//
// The display player has no native HLS branch, so each news feed is a text/html
// content row whose remote_url is /player/hls.html?station=<key>; that page asks
// /player/news-stream?station=<key> (this module) for { source } and plays it
// with hls.js. Station is a SERVER-SIDE whitelisted key — never a raw URL — so
// there is no SSRF / open-embed surface (mirrors lib/ozolio-resolve.js).
//
// Most stations are a direct master .m3u8 the browser fetches itself (the CDNs
// send ACAO:* or reflect the Origin, and segments are ACAO:*). Two need help:
//   • local10: its CloudFront master path rotates, so we re-scrape it from
//     www.local10.com/live at play time (cached), with a static fallback.
//   • wsvn: AES-128 encrypted with a CORS-locked key + variant, so we resolve the
//     Brightcove->Syncbak master and hand back a /player/hls-proxy URL (see
//     lib/hls-proxy.js) that relays the playlist + key with ACAO:*.
//
// All resolution runs on the in-market Miami box, so US/FL geo is satisfied.

const { buildProxyUrl, SYNCBAK_HOST } = require('./hls-proxy');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const TTL_MS = 90 * 1000;
const cache = new Map(); // key -> { source, exp }

// NBC6 + Telemundo Xumo masters 400 without the ads.* params — keep them verbatim.
const NBC6_SRC = 'https://d4whmvwm0rdvi.cloudfront.net/10007/99951167/hls/master.m3u8?ads.xumo_channelId=99951167&ads.asnw=169843&ads.afid=314827096&ads.sfid=17135549&ads.csid=xumo_web_NBCNFL_ssai_cro&ads._fw_did=48345275-0612-4d84-a99e-35fc587196f3&ads.appName=xumo&ads.xumo_contentId=3823&ads.xumo_contentName=NBCNFL';
const TELEMUNDO_SRC = 'https://d2kowtvrzzi7ps.cloudfront.net/11602/88889703/hls/master.m3u8?ads.csid=nbc_us_PLATFORM_telemundonoticiasfl_ssai&ads._fw_devicetype=3-Connected_TV&ads._fw_h_x_country=US&ads.xumo_channelId=88889703a&ads.xumo_streamId=88889703&ads.appName=web&ads.appVersion=1.0';
const LOCAL10_FALLBACK = 'https://d2jy668awuauer.cloudfront.net/v1/master/77872db67918a151b697b5fbc23151e5765767dc/wplginc_PROD_wplg_9a735077-eccb-4adb-9630-34d51840431c_LE/live/out/wplginc-wplgott-hls-v7/live.m3u8';

const STATIONS = {
  mbtv:        { title: 'MBTV · Miami Beach', kind: 'direct', src: 'https://edge-f.swagit.com/live/miamibeachfl/live-1-a/playlist.m3u8' },
  cbs:         { title: 'CBS News Miami', kind: 'direct', src: 'https://cbsn-mia.cbsnstream.cbsnews.com/out/v1/ac174b7938264d24ae27e56f6584bca0/master.m3u8' },
  nbc6:        { title: 'NBC6 South Florida', kind: 'direct', src: NBC6_SRC },
  local10:     { title: 'Local 10 · WPLG', kind: 'local10' },
  univision23: { title: 'Univisión 23', kind: 'direct', src: 'https://streaming-live-fcdn.api.prd.univisionnow.com/wltv/wltv.isml/hls/wltv.m3u8' },
  telemundo51: { title: 'Telemundo 51', kind: 'direct', src: TELEMUNDO_SRC },
  wsvn:        { title: 'WSVN 7News', kind: 'wsvn' },
};

function isValidStation(key) { return Object.prototype.hasOwnProperty.call(STATIONS, key); }

async function fetchText(url, headers, timeoutMs = 12000) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const r = await fetch(url, { headers: { 'User-Agent': UA, ...(headers || {}) }, signal: ac.signal });
    if (!r.ok) { const e = new Error(`upstream ${r.status}`); e.status = 502; throw e; }
    return await r.text();
  } finally { clearTimeout(timer); }
}

// Local 10: scrape the current CloudFront master from the station's own /live page.
async function resolveLocal10() {
  try {
    const html = await fetchText('https://www.local10.com/live/', { Referer: 'https://www.local10.com/' });
    const m = html.match(/https:\/\/[a-z0-9]+\.cloudfront\.net\/v1\/master\/[^"'\\\s]+\.m3u8/i);
    if (m && m[0]) return m[0];
  } catch (_) { /* fall through to the last-known-good URL */ }
  return LOCAL10_FALLBACK;
}

// WSVN: Brightcove playback API -> Syncbak master, then hand back a proxied URL
// (the master/variant/AES-key are CORS-locked to wsvn.com and must be relayed).
let wsvnPk = { value: null, exp: 0 };
async function wsvnPolicyKey() {
  if (wsvnPk.value && wsvnPk.exp > Date.now()) return wsvnPk.value;
  const cfg = await fetchText('https://players.brightcove.net/4368278029001/HyZhqV2ePb_default/config.json');
  const m = cfg.match(/BCpk[A-Za-z0-9_-]{40,}/);
  if (!m) { const e = new Error('wsvn: no policy key'); e.status = 502; throw e; }
  wsvnPk = { value: m[0], exp: Date.now() + 6 * 60 * 60 * 1000 }; // 6h
  return wsvnPk.value;
}
async function resolveWsvn() {
  const pk = await wsvnPolicyKey();
  const json = await fetchText(
    'https://edge.api.brightcove.com/playback/v1/accounts/4368278029001/videos/6024028001001',
    { Accept: `application/json;pk=${pk}`, Origin: 'https://wsvn.com', Referer: 'https://wsvn.com/' }
  );
  let master = '';
  try {
    const d = JSON.parse(json);
    const s = (d.sources || []).find((x) => /\.m3u8/.test(String(x.src || '')));
    master = s ? s.src : '';
  } catch (_) { /* */ }
  if (!master) { const e = new Error('wsvn: no master'); e.status = 502; throw e; }
  // The master must live on the Syncbak host the proxy whitelists.
  let path;
  try { const u = new URL(master); if (u.host !== SYNCBAK_HOST) { const e = new Error('wsvn: unexpected host'); e.status = 502; throw e; } path = u.pathname + u.search; }
  catch (e) { e.status = e.status || 502; throw e; }
  return buildProxyUrl(path); // /player/hls-proxy?p=<b64(path)>
}

async function resolveNewsStream(key) {
  if (!isValidStation(key)) { const e = new Error('unknown station'); e.status = 404; throw e; }
  const st = STATIONS[key];
  if (st.kind === 'direct') return { station: key, source: st.src };

  const hit = cache.get(key);
  if (hit && hit.exp > Date.now()) return { station: key, source: hit.source };

  let source;
  if (st.kind === 'local10') source = await resolveLocal10();
  else if (st.kind === 'wsvn') source = await resolveWsvn();
  else { const e = new Error('unknown station kind'); e.status = 500; throw e; }

  cache.set(key, { source, exp: Date.now() + TTL_MS });
  return { station: key, source };
}

module.exports = { resolveNewsStream, isValidStation, STATIONS };
