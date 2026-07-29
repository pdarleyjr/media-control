'use strict';

const path = require('path');

function thumbnailCacheIdentity(content, stat) {
  const generation = Number(content?.thumbnail_generation)
    || Number(content?.version)
    || 1;
  const fingerprint = Buffer.from(JSON.stringify([
    String(content?.id || ''),
    generation,
    Number(content?.updated_at) || 0,
    path.basename(String(content?.thumbnail_path || '')),
    Number(stat?.size) || 0,
  ])).toString('base64url');
  return {
    generation,
    etag: `W/"thumb-${fingerprint}"`,
    contentLocation: `/api/content/${encodeURIComponent(content.id)}/thumbnail?v=${generation}`,
  };
}

function requestMatchesEtag(ifNoneMatch, etag) {
  return String(ifNoneMatch || '')
    .split(',')
    .map((value) => value.trim())
    .some((value) => value === '*' || value === etag);
}

module.exports = {
  requestMatchesEtag,
  thumbnailCacheIdentity,
};
