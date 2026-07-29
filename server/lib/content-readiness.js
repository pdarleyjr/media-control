'use strict';

function contentBroadcastReadiness(db, content) {
  if (content
      && content.content_type === 'peertube-replay'
      && !String(content.filepath || '').trim()) {
    return {
      ready: false,
      status: 409,
      code: 'PEERTUBE_LOCALIZATION_REQUIRED',
      error: 'PeerTube replay must be prepared as one local classroom asset before broadcasting',
      processing_status: String(content.processing_status || 'remote'),
    };
  }
  if (!content || !content.filepath || !String(content.mime_type || '').startsWith('video/')) {
    return { ready: true };
  }
  const status = String(content.processing_status || 'uploaded');
  if (status === 'failed') {
    return {
      ready: false,
      status: 422,
      code: 'CONTENT_PROCESSING_FAILED',
      error: 'Video normalization failed; replace the file before broadcasting',
      processing_error: content.processing_error || null,
    };
  }
  if (status !== 'ready') {
    return {
      ready: false,
      status: 409,
      code: 'CONTENT_PROCESSING',
      error: 'Video is still being normalized for browser playback',
      processing_status: status,
    };
  }

  let manifest = null;
  try {
    manifest = db.prepare(`
      SELECT generation, sha256, size_bytes, canonical_path
      FROM asset_checksums
      WHERE content_id=?
    `).get(content.id);
  } catch (_) {
    manifest = null;
  }
  const generation = Math.max(1, Number(content.version) || 1);
  if (!manifest
    || Number(manifest.generation) !== generation
    || !/^[0-9a-f]{64}$/i.test(String(manifest.sha256 || ''))
    || Number(manifest.size_bytes) <= 0
    || String(manifest.canonical_path || '') !== String(content.filepath)) {
    return {
      ready: false,
      status: 409,
      code: 'CONTENT_MANIFEST_PENDING',
      error: 'The final video generation is not ready for delivery',
      processing_status: status,
    };
  }
  return { ready: true };
}

module.exports = { contentBroadcastReadiness };
