function asNullableNumber(value) {
  if (value == null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

export function regionPlaybackState(display, target) {
  if (!display || !target) return null;
  const regionId = String(target.region_id || target.id || '');
  const zoneId = String(target.zone_id || '');
  const state = (Array.isArray(display.region_states) ? display.region_states : []).find((entry) => (
    (regionId && String(entry?.region_id || '') === regionId)
    || (zoneId && String(entry?.zone_id || '') === zoneId)
  ));
  if (!state) return null;
  const contentId = state.current_content_id || null;
  return {
    contentId,
    content_id: contentId,
    content_instance_id: state.content_instance_id || null,
    kind: state.content_type || 'content',
    paused: state.paused == null ? null : !!state.paused,
    currentTime: asNullableNumber(state.current_time),
    duration: asNullableNumber(state.duration),
    slideIndex: asNullableNumber(state.slide_index),
    slideCount: asNullableNumber(state.slide_total ?? state.slide_count),
    region_id: state.region_id || null,
    zone_id: state.zone_id || null,
    render_state: state.render_state || null,
  };
}

export function transportContextForTarget(target, display) {
  if (!target || !['region', 'wall-region'].includes(String(target.type || ''))) return null;
  const playback = regionPlaybackState(display, target);
  return {
    deviceId: String(target.device_id || target.player_device_id || ''),
    regionId: String(target.region_id || target.id || ''),
    zoneId: String(target.zone_id || ''),
    wallId: String(target.wall_id || ''),
    expectedRevision: Number(target.layout_revision ?? target.layoutRevision) || 0,
    contentInstanceId: playback?.content_instance_id || null,
    playback,
  };
}
