// Frontend feature-flag gate (task §6).
//
// Fetches server-controlled feature flags from GET /api/features (auth
// required). The enterprise operator UI route is only exposed when the server
// reports the flag as enabled AND the caller is authorized. A query-param
// cannot enable it — authorization is server-side only.
//
// The result is cached for the page lifetime. If the fetch fails (network,
// 401, etc.) the flag is treated as OFF and the existing interface is used —
// a failed enterprise UI load falls back safely.

let _cache = null;
let _fetching = null;

function authHeaders() {
  try {
    const token = localStorage.getItem('token');
    return token ? { Authorization: `Bearer ${token}` } : {};
  } catch {
    return {};
  }
}

async function fetchFeatures() {
  try {
    const res = await fetch('/api/features', {
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
    });
    if (res.status === 401) { _cache = {}; return _cache; }
    if (!res.ok) { _cache = {}; return _cache; }
    const body = await res.json();
    _cache = (body && body.features) || {};
    return _cache;
  } catch {
    _cache = {};
    return _cache;
  }
}

export async function isEnterpriseUiEnabled() {
  if (_cache) return !!(_cache.enterpriseOperatorUi && _cache.enterpriseOperatorUi.authorized);
  if (!_fetching) _fetching = fetchFeatures();
  const features = await _fetching;
  return !!(features.enterpriseOperatorUi && features.enterpriseOperatorUi.authorized);
}

// Classroom Mode (task §7). When the server reports this flag as authorized,
// the dashboard hides livestream/AI/camera nav items and shows a banner —
// without requiring a refresh. The backing services are also stopped
// server-side, so the flag is a UI affordance, not the enforcement boundary.
export async function isClassroomModeEnabled() {
  if (_cache) return !!(_cache.classroomMode && _cache.classroomMode.authorized);
  if (!_fetching) _fetching = fetchFeatures();
  const features = await _fetching;
  return !!(features.classroomMode && features.classroomMode.authorized);
}

export function clearFeatureCache() { _cache = null; _fetching = null; }

export default { isEnterpriseUiEnabled, isClassroomModeEnabled, clearFeatureCache };
