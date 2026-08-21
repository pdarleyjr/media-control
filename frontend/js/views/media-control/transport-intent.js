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

/**
 * Track the latest intent per target so a command can be confirmed exactly
 * once and out-of-order confirmations are ignored. The computed command is
 * ALWAYS derived from the authoritative playback state passed in by the caller;
 * a prior optimistic guess is never fed back into the next command. The UI must
 * wait for the player/server to confirm a result before advancing again.
 */
export function createTransportIntentTracker({ maxEntries = 64, retentionMs = 2500 } = {}) {
  const entries = new Map();
  let sequence = 0;

  function prune() {
    while (entries.size > maxEntries) entries.delete(entries.keys().next().value);
  }

  return {
    resolve(targetKey, action, playback = {}) {
      const key = String(targetKey || 'default');
      const requestedAction = String(action || '').trim();
      const explicitAction = requestedAction === 'play_pause'
        ? ((playback?.paused === true) ? 'play' : 'pause')
        : requestedAction;
      const intent = resolveTransportIntent(explicitAction, playback || {});
      const nextSequence = ++sequence;
      entries.delete(key);
      entries.set(key, { sequence: nextSequence });
      prune();
      return {
        ...intent,
        sequence: nextSequence,
        targetKey: key,
      };
    },

    settle(targetKey, expectedSequence, result = {}) {
      const key = String(targetKey || 'default');
      const current = entries.get(key);
      if (!current || current.sequence !== expectedSequence) return false;
      if (result.ok === false) {
        entries.delete(key);
      } else {
        entries.set(key, {
          ...current,
          retainedUntil: Date.now() + Math.max(0, Number(retentionMs) || 0),
        });
      }
      return true;
    },

    clear() {
      entries.clear();
    },
  };
}
