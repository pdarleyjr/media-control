'use strict';

// Single source of truth for the enterprise operator UI feature flag:
// env parsing (at boot, used by server/config.js) and per-user authorization
// (per request, used by server/server.js). Fail-closed by design: an empty
// or malformed allowlist authorizes NO ONE while the flag is on; an explicit
// "*" is required to allow every authenticated workspace member.

function parseEnabledFlag(raw) {
  return ['true', '1'].includes(String(raw || '').toLowerCase());
}

function parseAllowlist(raw) {
  const entries = String(raw || '')
    .split(',')
    .map((s) => s.trim());
  const allowAll = entries.includes('*');
  const allowlist = entries.filter((s) => Boolean(s) && s !== '*');
  return { allowAll, allowlist };
}

function buildEnterpriseOperatorUiFlag(env) {
  const e = env || {};
  return {
    enabled: parseEnabledFlag(e.ENTERPRISE_OPERATOR_UI_ENABLED),
    ...parseAllowlist(e.ENTERPRISE_OPERATOR_UI_USERS),
  };
}

// Resolve a single flag to { enabled, authorized } for a canonical user id.
// Fail-closed: empty/malformed allowlist authorizes no one unless allowAll.
function authorizeFlag(flag, userId) {
  const enabled = !!(flag && flag.enabled);
  const allowAll = !!(flag && flag.allowAll);
  const allowlist = Array.isArray(flag && flag.allowlist) ? flag.allowlist : [];
  const userAllowed = enabled && (allowAll || allowlist.includes(userId));
  return { enabled, authorized: userAllowed };
}

function resolveFeatureFlags(featuresConfig, userId) {
  const out = {};
  for (const [key, flag] of Object.entries(featuresConfig || {})) {
    out[key] = authorizeFlag(flag, userId);
  }
  return out;
}

module.exports = {
  parseEnabledFlag,
  parseAllowlist,
  buildEnterpriseOperatorUiFlag,
  authorizeFlag,
  resolveFeatureFlags,
};
