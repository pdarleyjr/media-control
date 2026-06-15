// hls-proxy.js — a minimal, host-locked HLS relay for the WSVN 7News feed.
//
// WSVN's Brightcove->Syncbak stream is AES-128 encrypted and its master, variant
// (/media.m3u8) AND decryption key (/aeskey) are all served from the Syncbak host
// with `Access-Control-Allow-Origin: https://wsvn.com` (not *), so hls.js running
// on our origin cannot fetch them. The .ts segments, however, live on CloudFront
// with ACAO:* and play directly. So this proxy relays ONLY the small playlist +
// key responses (re-emitting ACAO:*), rewrites their internal URIs back through
// itself, and leaves the heavy segment traffic to go direct to CloudFront.
//
// SSRF model (mirrors ozolio-resolve's whitelist): the client never passes a URL.
// It passes `p` = a base64url path that is ALWAYS fetched against the single fixed
// SYNCBAK_HOST; `p` must decode to an absolute path ("/...") with a safe charset.
// No host, scheme, or "../" escape is possible.

const SYNCBAK_HOST = 'dai2-playlistserver.aws.syncbak.com';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const PATH_RE = /^\/[A-Za-z0-9/_\-.~%?&=:]*$/; // absolute path + querystring only
const PROXY_BASE = '/player/hls-proxy';

function b64urlEncode(s) { return Buffer.from(s, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
function b64urlDecode(s) { return Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'); }

// Build the same-origin proxy URL for a Syncbak absolute path (used by the resolver
// and the manifest rewriter).
function buildProxyUrl(absPath) { return `${PROXY_BASE}?p=${b64urlEncode(absPath)}`; }

// Rewrite a playlist body so every Syncbak-hosted child (variant playlist, AES key,
// any root-relative URI) is routed back through this proxy, while absolute CDN
// segment URLs (CloudFront, ACAO:*) are left untouched to stream direct.
function rewriteManifest(body, currentPath) {
  const baseDir = currentPath.replace(/\?.*$/, '').replace(/\/[^/]*$/, '/'); // dir of the current m3u8
  const proxyOne = (uri) => {
    if (/^https?:\/\//i.test(uri)) return uri;          // absolute (CloudFront segments) -> leave
    let abs;
    if (uri.startsWith('/')) abs = uri;                 // domain-root (Syncbak /media.m3u8, /aeskey)
    else abs = baseDir + uri;                            // relative -> resolve under Syncbak dir
    return buildProxyUrl(abs);
  };
  return body.split('\n').map((line) => {
    const t = line.trim();
    if (!t) return line;
    if (t.charAt(0) !== '#') return proxyOne(t);        // a URI line (variant or segment)
    // Rewrite URI="..." attributes (EXT-X-KEY, EXT-X-MAP, EXT-X-MEDIA).
    if (/URI="/.test(t)) return line.replace(/URI="([^"]+)"/g, (_m, u) => `URI="${proxyOne(u)}"`);
    return line;
  }).join('\n');
}

// Express handler for GET /player/hls-proxy?p=<b64url path>
async function handleProxy(req, res) {
  let path;
  try { path = b64urlDecode(req.query.p || ''); } catch (_) { return res.status(400).type('text/plain').send('bad p'); }
  if (!path || !PATH_RE.test(path) || path.includes('..')) return res.status(400).type('text/plain').send('bad path');

  const upstream = `https://${SYNCBAK_HOST}${path}`;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 15000);
  try {
    const r = await fetch(upstream, {
      headers: { 'User-Agent': UA, Origin: 'https://wsvn.com', Referer: 'https://wsvn.com/' },
      signal: ac.signal,
    });
    res.setHeader('Access-Control-Allow-Origin', '*');
    if (!r.ok) return res.status(r.status === 404 ? 404 : 502).type('text/plain').send('upstream ' + r.status);

    const ct = (r.headers.get('content-type') || '').toLowerCase();
    const isManifest = ct.includes('mpegurl') || /\.m3u8(\?|$)/.test(path);
    if (isManifest) {
      const body = await r.text();
      res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
      res.setHeader('Cache-Control', 'no-cache');
      return res.send(rewriteManifest(body, path));
    }
    // AES key (or any other small asset): pass bytes through unchanged.
    const buf = Buffer.from(await r.arrayBuffer());
    res.setHeader('Content-Type', ct || 'application/octet-stream');
    res.setHeader('Cache-Control', 'no-cache');
    return res.send(buf);
  } catch (e) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    return res.status(502).type('text/plain').send('proxy error');
  } finally { clearTimeout(timer); }
}

module.exports = { handleProxy, buildProxyUrl, rewriteManifest, SYNCBAK_HOST, b64urlEncode, b64urlDecode };
