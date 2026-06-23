const path = require('path');

function normalizeBaseUrl(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  try {
    const url = new URL(raw);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return '';
    url.hash = '';
    url.search = '';
    url.pathname = url.pathname.replace(/\/+$/, '');
    return url.toString().replace(/\/$/, '');
  } catch {
    return '';
  }
}

function localContentBaseUrlFromEnv(env = process.env) {
  const explicit = normalizeBaseUrl(env.LOCAL_CONTENT_BASE_URL || '');
  if (explicit) return explicit;

  const host = String(env.LOCAL_PROXY_IP || env.LOCAL_CONTENT_HOST || '').trim();
  if (!host) return '';
  const protocol = String(env.LOCAL_PROXY_PROTOCOL || 'http').replace(/:$/, '');
  if (protocol !== 'http' && protocol !== 'https') return '';
  const port = String(env.LOCAL_PROXY_PORT || env.PORT || '3001').trim();
  return normalizeBaseUrl(`${protocol}://${host}${port ? `:${port}` : ''}`);
}

function withLocalAssetUrls(assignments, baseUrl) {
  const base = normalizeBaseUrl(baseUrl);
  if (!base || !Array.isArray(assignments)) return assignments;

  return assignments.map((item) => {
    if (!item || typeof item !== 'object') return item;
    if (!item.filepath || item.remote_url) return item;
    const filename = path.basename(String(item.filepath));
    if (!filename) return item;
    return {
      ...item,
      asset_url: `${base}/uploads/content/${encodeURIComponent(filename)}`,
      asset_proxy: 'local',
    };
  });
}

function publicContentAssetUrl(item) {
  if (!item || typeof item !== 'object') return '';
  if (!item.content_id || item.remote_url || item.asset_url) return '';
  return `/api/content/${encodeURIComponent(String(item.content_id))}/file`;
}

// Classroom-only: rewrite each playable item's asset_url to the on-box room-agent
// READ-THROUGH cache, keyed by content_id (the agent serves cached bytes locally
// and proxies a miss from this server, then caches it). Only items that have a
// content_id and a local file (filepath) and no remote_url are rewritten; remote
// items (YouTube/website) are left alone. The player keeps an automatic origin
// fallback, so a down/empty cache can never blank a wall. `base` is the agent's
// HTTP base (e.g. http://127.0.0.1:8097) — empty disables (no-op).
function withClassroomCacheUrls(assignments, base) {
  const b = normalizeBaseUrl(base);
  if (!b || !Array.isArray(assignments)) return assignments;
  return assignments.map((item) => {
    if (!item || typeof item !== 'object') return item;
    if (!item.content_id || item.remote_url || !item.filepath) return item;
    return {
      ...item,
      asset_url: `${b}/content/${encodeURIComponent(String(item.content_id))}/file`,
      asset_proxy: 'local',
    };
  });
}

function withPublicContentAssetUrls(assignments) {
  if (!Array.isArray(assignments)) return assignments;

  return assignments.map((item) => {
    const assetUrl = publicContentAssetUrl(item);
    if (!assetUrl) return item;
    return {
      ...item,
      asset_url: assetUrl,
      asset_proxy: 'public-content',
    };
  });
}

module.exports = {
  normalizeBaseUrl,
  localContentBaseUrlFromEnv,
  withLocalAssetUrls,
  withClassroomCacheUrls,
  publicContentAssetUrl,
  withPublicContentAssetUrls,
};
