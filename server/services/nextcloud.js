// MBFD Media Control Studio — Nextcloud WebDAV client (server-side).
// Service-account creds come from config.nextcloud (set in .env, NEVER repo).
// Inert until configured (NEXTCLOUD_URL/USER/PASS). Used by routes/files.js for
// the in-app Files browser and (later) deck export sync.
//
// NOTE for the operator: Nextcloud at cloud.mbfdhub.com sits behind Cloudflare
// Access (human OTP). A server-to-server WebDAV call with Basic auth will be
// redirected to the OTP wall unless you EITHER (a) point NEXTCLOUD_URL at an
// internal origin that bypasses CF Access, OR (b) add a CF Access service-token
// bypass for /remote.php/dav. A Nextcloud app-password is recommended over the
// account password.

const config = require('../config');

function nc() { return config.nextcloud || {}; }
function isConfigured() { const c = nc(); return !!(c.url && c.user && c.pass); }
function authHeader() { const c = nc(); return 'Basic ' + Buffer.from(`${c.user}:${c.pass}`).toString('base64'); }
function davRoot() { const c = nc(); return c.url.replace(/\/+$/, '') + '/remote.php/dav/files/' + encodeURIComponent(c.user); }
function pathPrefix() { return davRoot().replace(/^https?:\/\/[^/]+/, ''); } // e.g. /remote.php/dav/files/peter
function clean(p) { let s = '/' + String(p || '').replace(/^\/+/, ''); s = s.replace(/\/+/g, '/'); return s === '/' ? '' : s.replace(/\/$/, ''); }

async function list(relPath = '') {
  if (!isConfigured()) throw new Error('Nextcloud not configured');
  const url = davRoot() + encodeURI(clean(relPath)) + '/';
  const res = await fetch(url, {
    method: 'PROPFIND',
    headers: { Authorization: authHeader(), Depth: '1', 'Content-Type': 'application/xml' },
    body: '<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:getcontentlength/><d:getcontenttype/><d:getlastmodified/><d:resourcetype/></d:prop></d:propfind>',
    signal: AbortSignal.timeout(15000),
  });
  if (res.status === 401) throw new Error('Nextcloud auth failed — check service credentials');
  if (res.status === 302 || res.status === 303) throw new Error('Nextcloud redirected to login (Cloudflare Access?) — use an internal URL or an Access service-token bypass');
  if (!res.ok) throw new Error('Nextcloud WebDAV ' + res.status);
  const xml = await res.text();
  const prefix = pathPrefix();
  const reqPath = clean(relPath);
  const items = [];
  const re = /<d:response>([\s\S]*?)<\/d:response>/g;
  let m;
  while ((m = re.exec(xml))) {
    const blk = m[1];
    const hrefRaw = (blk.match(/<d:href>([\s\S]*?)<\/d:href>/) || [])[1] || '';
    let href = decodeURIComponent(hrefRaw);
    const isDir = /<d:collection\s*\/?>/.test(blk);
    const size = parseInt((blk.match(/<d:getcontentlength>(\d+)<\/d:getcontentlength>/) || [])[1] || '0', 10);
    const modified = (blk.match(/<d:getlastmodified>([\s\S]*?)<\/d:getlastmodified>/) || [])[1] || '';
    // Relative path within the user's files root.
    let rel = href.replace(prefix, '').replace(/\/$/, '');
    if (rel === reqPath) continue; // skip the listed directory itself
    let name = rel.substring(rel.lastIndexOf('/') + 1);
    if (!name) continue;
    items.push({ name, is_dir: isDir, size, modified, path: rel });
  }
  // Folders first, then alpha.
  items.sort((a, b) => (a.is_dir === b.is_dir ? a.name.localeCompare(b.name) : a.is_dir ? -1 : 1));
  return items;
}

// Stream a file from Nextcloud (used by the download proxy route).
async function fetchFile(relPath) {
  if (!isConfigured()) throw new Error('Nextcloud not configured');
  const url = davRoot() + encodeURI(clean(relPath));
  const res = await fetch(url, { headers: { Authorization: authHeader() }, signal: AbortSignal.timeout(60000) });
  if (!res.ok) throw new Error('Nextcloud download ' + res.status);
  return res;
}

// MKCOL — create a folder (idempotent: 405 = already exists).
async function mkcol(relPath) {
  if (!isConfigured()) throw new Error('Nextcloud not configured');
  const res = await fetch(davRoot() + encodeURI(clean(relPath)), { method: 'MKCOL', headers: { Authorization: authHeader() }, signal: AbortSignal.timeout(15000) });
  if (!res.ok && res.status !== 405) throw new Error('Nextcloud MKCOL ' + res.status);
  return true;
}

// PUT — upload bytes.
async function put(relPath, buffer, contentType) {
  if (!isConfigured()) throw new Error('Nextcloud not configured');
  const res = await fetch(davRoot() + encodeURI(clean(relPath)), { method: 'PUT', headers: { Authorization: authHeader(), 'Content-Type': contentType || 'application/octet-stream' }, body: buffer, signal: AbortSignal.timeout(60000) });
  if (!res.ok) throw new Error('Nextcloud PUT ' + res.status);
  return true;
}

async function ping() {
  if (!isConfigured()) return { configured: false };
  try { await list(''); return { configured: true, ok: true }; }
  catch (e) { return { configured: true, ok: false, error: String(e.message || e) }; }
}

module.exports = { isConfigured, list, fetchFile, mkcol, put, ping, clean };
