function asMap(value) {
  if (value instanceof Map) return value;
  if (Array.isArray(value)) return new Map(value.filter(Boolean).map((row) => [row.id, row]));
  return new Map();
}

/**
 * Adapt the compact authoritative room contract to the richer legacy display
 * view-model used by Command Center. The snapshot owns membership and
 * confirmed values; REST-only presentation fields are retained per display.
 */
export function projectRoomDisplays(snapshot, priorDisplays = new Map(), options = {}) {
  const confirmed = snapshot?.confirmedState?.displays;
  if (!Array.isArray(confirmed)) return null;
  const priorById = asMap(priorDisplays);
  const deviceById = new Map(
    (Array.isArray(snapshot?.deviceStates?.displays) ? snapshot.deviceStates.displays : [])
      .filter((device) => device && typeof device.id === 'string')
      .map((device) => [device.id, device]),
  );
  const screenshotUrlForId = typeof options.screenshotUrlForId === 'function'
    ? options.screenshotUrlForId
    : () => null;

  return new Map(confirmed
    .filter((display) => display && typeof display.id === 'string' && display.id)
    .map((display) => {
      const prior = priorById.get(display.id) || {};
      const device = deviceById.get(display.id) || {};
      const priorContentId = prior.now_playing?.contentId
        ?? prior.now_playing?.content_id
        ?? null;
      const contentId = display.contentId
        ?? priorContentId
        ?? null;
      // A room snapshot can arrive between the player confirmation and the
      // richer REST refresh. Content-bound presentation fields from the prior
      // item (especially remoteUrl/poster_url) must never cross that identity
      // boundary: doing so rendered the newly confirmed Guest Computer ID with
      // the previous Anpviz iframe URL in Command Center.
      const contentIdentityChanged = priorContentId != null
        && contentId != null
        && String(priorContentId) !== String(contentId);
      const nowPlaying = {
        ...(contentIdentityChanged ? {} : (prior.now_playing || {})),
        contentId,
        content_id: contentId,
        kind: (contentIdentityChanged || (priorContentId == null && contentId != null))
          ? (display.contentType || prior.now_playing?.kind || 'idle')
          : (prior.now_playing?.kind || display.contentType || 'idle'),
        paused: display.paused ?? prior.now_playing?.paused ?? null,
        slideIndex: display.slideIndex ?? prior.now_playing?.slideIndex ?? null,
        slideCount: display.slideCount ?? prior.now_playing?.slideCount ?? null,
        currentTime: display.currentTime ?? prior.now_playing?.currentTime ?? null,
        duration: display.duration ?? prior.now_playing?.duration ?? null,
      };
      const fallbackScreenshot = device.screenshotAt != null
        ? screenshotUrlForId(display.id, device.screenshotAt)
        : null;

      return [display.id, {
        ...prior,
        ...display,
        online: display.status === 'online',
        // Blank state belongs to the player's confirmed display-state report.
        // devices.screenOn is legacy delivery intent and must never be projected
        // as physical truth. A missing confirmation remains explicitly unknown.
        screen_on: typeof display.screenOn === 'boolean' ? display.screenOn : null,
        command_revision: display.commandRevision ?? null,
        state_revision: Number(display.stateRevision) || 0,
        error_state: display.errorState ?? null,
        screen_width: device.width ?? prior.screen_width ?? null,
        screen_height: device.height ?? prior.screen_height ?? null,
        wall_id: display.wallId ?? device.wallId ?? prior.wall_id ?? null,
        layout_id: display.layoutId ?? device.layoutId ?? prior.layout_id ?? null,
        screenshot_url: prior.screenshot_url || fallbackScreenshot,
        screenshot_at: prior.screenshot_at ?? device.screenshotAt ?? null,
        now_playing: nowPlaying,
      }];
    }));
}
