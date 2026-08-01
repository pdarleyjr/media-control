function positiveInteger(value) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : null;
}

function isPresentation(playback) {
  const kind = String(
    playback?.kind
      || playback?.content_type
      || playback?.media_type
      || '',
  ).toLowerCase();
  return kind === 'document'
    || kind === 'pdf'
    || kind === 'presentation'
    || kind === 'powerpoint';
}

/**
 * Convert relative presentation controls to an absolute slide destination.
 * Absolute go_to_slide commands are idempotent across every span/group member
 * and can be confirmed against the exact player state.
 */
export function resolveTransportIntent(action, playback) {
  const requestedAction = String(action || '').trim();
  if (
    !isPresentation(playback)
    || !['next', 'prev', 'restart'].includes(requestedAction)
  ) {
    return { action: requestedAction, payload: {}, noOp: false };
  }

  const current = positiveInteger(
    playback?.slideIndex
      ?? playback?.slide_index
      ?? playback?.page
      ?? playback?.current_time,
  );
  const total = positiveInteger(
    playback?.slideCount
      ?? playback?.slide_count
      ?? playback?.slideTotal
      ?? playback?.slide_total
      ?? playback?.total_pages
      ?? playback?.duration,
  );
  if (!current) {
    return { action: requestedAction, payload: {}, noOp: false };
  }

  let slide = current;
  if (requestedAction === 'restart') slide = 1;
  else if (requestedAction === 'next') slide = total
    ? Math.min(total, current + 1)
    : current + 1;
  else if (requestedAction === 'prev') slide = Math.max(1, current - 1);

  return {
    action: 'go_to_slide',
    payload: { slide },
    noOp: slide === current,
  };
}
