'use strict';

const CACHE_PROTOCOL_VERSION = 2;
const MAX_LEGACY_MANIFEST_ITEMS = 10_000;

function authoritativeManifestItems(payload) {
  if (!payload || payload.protocol_version !== CACHE_PROTOCOL_VERSION || payload.authoritative !== true || !Array.isArray(payload.items)) {
    return null;
  }
  return payload.items;
}

function legacyManifestItems(payload) {
  if (!Array.isArray(payload)) return null;
  return payload.slice(0, MAX_LEGACY_MANIFEST_ITEMS);
}

function purgeAcknowledgement(result, details = {}) {
  const absentVerified = result?.ok === true;
  return {
    ...details,
    ...result,
    ok: absentVerified,
    purged: absentVerified,
    absent_verified: absentVerified,
  };
}

module.exports = {
  CACHE_PROTOCOL_VERSION,
  authoritativeManifestItems,
  legacyManifestItems,
  purgeAcknowledgement,
};
