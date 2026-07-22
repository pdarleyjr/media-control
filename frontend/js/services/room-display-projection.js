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
      const contentId = display.contentId
        ?? prior.now_playing?.contentId
        ?? prior.now_playing?.content_id
        ?? null;
      const nowPlaying = {
        ...(prior.now_playing || {}),
        contentId,
        content_id: contentId,
        kind: display.contentType || prior.now_playing?.kind || 'idle',
        paused: display.paused ?? prior.now_playing?.paused ?? null,
        slideIndex: display.slideIndex ?? prior.now_playing?.slideIndex ?? null,
        slideCount: display.slideCount ?? prior.now_playing?.slideCount ?? null,
        currentTime: display.currentTime ?? prior.now_playing?.currentTime ?? null,
        duration: display.duration ?? prior.now_playing?.duration ?? null,
      };
      const fallbackScreenshot = screenshotUrlForId(display.id);

      return [display.id, {
        ...prior,
        ...display,
        online: display.status === 'online',
        screen_on: device.screenOn ?? prior.screen_on ?? null,
        screen_width: device.width ?? prior.screen_width ?? null,
        screen_height: device.height ?? prior.screen_height ?? null,
        wall_id: display.wallId ?? device.wallId ?? prior.wall_id ?? null,
        layout_id: display.layoutId ?? device.layoutId ?? prior.layout_id ?? null,
        screenshot_url: prior.screenshot_url || fallbackScreenshot,
        now_playing: nowPlaying,
      }];
    }));
}

