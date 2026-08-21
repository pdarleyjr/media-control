'use strict';

const CACHE_PROTOCOL_VERSION = 2;

function authoritativeManifestItems(payload) {
  if (!payload || payload.protocol_version !== CACHE_PROTOCOL_VERSION || payload.authoritative !== true || !Array.isArray(payload.items)) {
    return null;
  }
  return payload.items;
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

module.exports = { CACHE_PROTOCOL_VERSION, authoritativeManifestItems, purgeAcknowledgement };
