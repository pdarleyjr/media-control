const PREPARING_VIDEO_STATUSES = new Set(['uploaded', 'probing', 'processing']);

function normalizedStatus(content) {
  return String(content?.processing_status || '').trim().toLowerCase();
}

function isLocallyFinalizedVideo(content) {
  const mimeType = String(content?.mime_type || '').trim().toLowerCase();
  return mimeType.startsWith('video/')
    && mimeType !== 'video/youtube'
    && !content?.remote_url;
}

function normalizedProgress(value) {
  const progress = Number(value);
  if (!Number.isFinite(progress)) return null;
  return Math.max(0, Math.min(100, Math.round(progress)));
}

/**
 * Turn the persisted media-normalization lifecycle into the user-facing send
 * gate. Legacy rows without a status remain sendable; every new local video
 * carries an explicit status from upload through finalization.
 */
export function getContentReadiness(content) {
  if (!isLocallyFinalizedVideo(content)) {
    return { state: 'ready', sendEnabled: true, progress: 100, reason: '' };
  }

  const status = normalizedStatus(content);
  if (status === 'failed') {
    return {
      state: 'failed',
      sendEnabled: false,
      progress: null,
      reason: String(content?.processing_error || '').trim(),
    };
  }
  if (PREPARING_VIDEO_STATUSES.has(status)) {
    return {
      state: 'preparing',
      sendEnabled: false,
      progress: normalizedProgress(
        content?.processing_progress
        ?? content?.processing_percent
        ?? content?.progress,
      ),
      reason: '',
    };
  }

  return { state: 'ready', sendEnabled: true, progress: 100, reason: '' };
}

/**
 * Apply a dashboard content-updated payload without allowing an unrelated
 * workspace item to mutate the card. The finalizer publishes generation as
 * the canonical content version.
 */
export function applyContentUpdate(content, update) {
  if (!content || String(content.id) !== String(update?.content_id || '')) return content;
  const generation = Number(update?.generation);
  return {
    ...content,
    ...(update?.processing_status ? { processing_status: update.processing_status } : {}),
    ...(Object.prototype.hasOwnProperty.call(update || {}, 'processing_error')
      ? { processing_error: update.processing_error }
      : {}),
    ...(Number.isFinite(generation) ? { version: generation, generation } : {}),
  };
}
