function text(value) {
  return value == null ? '' : String(value);
}

function stateContentIdentities(state) {
  return new Set([
    state?.content_instance_id,
    state?.contentInstanceId,
    state?.current_content_id,
    state?.currentContentId,
    state?.content_id,
    state?.contentId,
  ].map(text).filter(Boolean));
}

/**
 * Confirm only the exact device/content/command outcome while accepting the
 * snake_case device contract and camelCase dashboard-store projection.
 */
export function matchesExpectedTransportState(entry, state) {
  if (!entry || !state || typeof state !== 'object') return false;

  const expectedDevice = text(entry.deviceId || entry.device_id);
  const actualDevice = text(state.device_id || state.deviceId);
  if (expectedDevice && actualDevice && actualDevice !== expectedDevice) return false;

  const expectedRegion = text(entry.regionId || entry.region_id);
  const actualRegion = text(state.region_id || state.regionId);
  if (expectedRegion && actualRegion !== expectedRegion) return false;

  const expectedCommand = text(entry.commandId || entry.command_id);
  const actualCommand = text(
    state.command_revision
      || state.commandRevision
      || state.last_command_id
      || state.telemetry?.last_command_id,
  );
  if (expectedCommand && actualCommand && actualCommand !== expectedCommand) return false;

  const expectedContent = text(entry.contentInstanceId || entry.content_instance_id);
  const contentIdentities = stateContentIdentities(state);
  if (expectedContent && !contentIdentities.has(expectedContent)) return false;

  const action = text(entry.action);
  if (action === 'pause') return state.paused === true;
  if (action === 'play') return state.paused === false;
  if (action === 'stop') return state.kind === 'idle' || state.paused === true || !state.kind;
  if (action === 'seek') {
    const target = entry.payload?.seconds ?? entry.payload?.position_seconds;
    const currentTime = state.currentTime ?? state.current_time;
    return target != null
      && currentTime != null
      && Math.abs(Number(currentTime) - Number(target)) <= 2;
  }
  if (action === 'go_to_slide') {
    const target = entry.payload?.slide ?? entry.payload?.slide_index;
    const currentSlide = state.slide_index ?? state.slideIndex ?? state.page;
    return target != null && currentSlide != null && Number(currentSlide) === Number(target);
  }

  return true;
}
