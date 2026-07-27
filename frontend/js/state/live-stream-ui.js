// Maps live-stream status/capability payloads into operator UI ladder labels.
// Tolerates both pre- and post-Agent-1 envelopes so the shell never invents greenery.

export const LIVE_LADDER = Object.freeze({
  NOT_CONFIGURED: 'Not configured',
  RECEIVER_OFFLINE: 'Receiver offline',
  OBS_UNAVAILABLE: 'OBS unavailable',
  PROGRAM_NOT_PREPARED: 'Program not prepared',
  SCENE_UNSAFE: 'Scene unsafe',
  READY: 'Ready',
  PREPARING: 'Preparing',
  STARTING: 'Starting',
  ON_AIR: 'On Air',
  STOPPING: 'Stopping',
  FAILED: 'Failed',
  UNKNOWN: 'Unknown',
});

function capsOf(status) {
  if (!status || typeof status !== 'object') return {};
  const nested = status.capabilities && typeof status.capabilities === 'object' ? status.capabilities : {};
  return { ...status, ...nested };
}

function directorData(status) {
  const d = status && status.ai_director && status.ai_director.data;
  return d && typeof d === 'object' ? d : null;
}

export function extractLiveError(errOrStatus) {
  if (!errOrStatus) return null;
  if (typeof errOrStatus === 'string') return { code: null, message: errOrStatus };
  const code = errOrStatus.code || errOrStatus.last_error_code || null;
  const message = errOrStatus.error
    || errOrStatus.message
    || errOrStatus.last_error_message
    || null;
  if (!code && !message) return null;
  return { code, message: message || code };
}

// Derives the actual capability reason a livestream cannot start from the
// publisher / compositor / camera_edge fields of the operator-state payload.
// Never references the retired AI Director; surfaces the concrete blocker so
// the operator can act on it (camera, PeerTube, duplicate publisher, OBS
// compositor). Falls back to a backend error message when present.
export function capabilityStartReason(c, data, lastErr) {
  const publisher = c && c.publisher && typeof c.publisher === 'object' ? c.publisher : null;
  const cameraEdge = c && c.camera_edge && typeof c.camera_edge === 'object' ? c.camera_edge : null;
  const compositor = c && c.compositor && typeof c.compositor === 'object' ? c.compositor : null;
  const publisherMode = (publisher && publisher.mode) || c.publisher_mode || null;

  // A publisher is already active on the other path (direct vs fixed).
  if ((publisher && publisher.active === true) || (cameraEdge && cameraEdge.livestreaming === true)) {
    return 'Direct publisher already active';
  }
  // Fixed compositor path requires the OBS compositor to be available.
  if (publisherMode === 'fixed_compositor' && compositor && compositor.available === false) {
    return 'OBS compositor unavailable';
  }
  // Camera edge is the program source for the direct path and the compositor
  // camera input; offline camera blocks both publisher modes.
  if ((cameraEdge && cameraEdge.camera_online === false) || c.obs_available === false) {
    return 'Camera unavailable';
  }
  if (c.peertube_configured === false) return 'PeerTube not configured';
  if (c.peertube_reachable === false) return 'PeerTube unreachable';
  if (lastErr && lastErr.message) return lastErr.message;
  return 'Livestream start is blocked by current capabilities';
}

export function deriveLiveLadder(status, { phase = null } = {}) {
  if (phase === 'preparing') return { state: LIVE_LADDER.PREPARING, canStart: false, reason: 'Preparing program…' };
  if (phase === 'starting') return { state: LIVE_LADDER.STARTING, canStart: false, reason: 'Starting stream…' };
  if (phase === 'stopping') return { state: LIVE_LADDER.STOPPING, canStart: false, reason: 'Stopping stream…' };

  const c = capsOf(status);
  const data = directorData(status);
  const streamActive = c.stream_state === 'on_air'
    || c.stream_state === 'live'
    || c.stream_active === true
    || !!(data && data.stream_active === true);

  if (streamActive) {
    return { state: LIVE_LADDER.ON_AIR, canStart: false, reason: 'Stream is on air' };
  }

  const lastErr = extractLiveError(c);
  if (lastErr && (c.stream_state === 'failed' || c.last_error_code)) {
    return {
      state: LIVE_LADDER.FAILED,
      canStart: false,
      reason: lastErr.message || lastErr.code,
      error: lastErr,
    };
  }

  const peertubeOk = c.peertube_configured !== false && c.peertube_reachable !== false;
  if (c.peertube_configured === false) {
    return { state: LIVE_LADDER.NOT_CONFIGURED, canStart: false, reason: 'PeerTube is not configured' };
  }
  if (c.peertube_reachable === false) {
    return { state: LIVE_LADDER.NOT_CONFIGURED, canStart: false, reason: 'PeerTube is unreachable' };
  }

  if (c.managed_receiver_online === false || c.receiver_online === false) {
    return { state: LIVE_LADDER.RECEIVER_OFFLINE, canStart: false, reason: 'Managed receiver is offline' };
  }

  if (c.obs_available === false || (data && data.obs === false)) {
    return { state: LIVE_LADDER.OBS_UNAVAILABLE, canStart: false, reason: capabilityStartReason(c, data, null) };
  }

  const prepared = c.program_prepared === true
    || c.program_content_active === true
    || !!(data && data.content_active === true);
  if (c.program_prepared === false || (c.program_prepared == null && c.program_content_active === false && !prepared && status && status.capabilities)) {
    // Only block when backend explicitly says unprepared; unknown caps stay permissive for legacy.
    if (c.program_prepared === false) {
      return { state: LIVE_LADDER.PROGRAM_NOT_PREPARED, canStart: false, reason: 'Program is not prepared' };
    }
  }

  if (c.program_scene_safe === false) {
    return { state: LIVE_LADDER.SCENE_UNSAFE, canStart: false, reason: 'Current program scene is unsafe for go-live' };
  }

  const operatorAllowed = c.operator_start_allowed;
  if (operatorAllowed === false) {
    const reason = capabilityStartReason(c, data, lastErr);
    return { state: LIVE_LADDER.FAILED, canStart: false, reason, error: lastErr };
  }

  if (!peertubeOk && status && Object.keys(c).length === 0) {
    return { state: LIVE_LADDER.UNKNOWN, canStart: true, reason: null };
  }

  return {
    state: LIVE_LADDER.READY,
    canStart: operatorAllowed !== false,
    reason: operatorAllowed === false ? 'Start not allowed' : null,
  };
}

export function formatLiveFailure(err) {
  const extracted = extractLiveError(err) || {};
  const parts = [];
  if (extracted.message) parts.push(extracted.message);
  else if (extracted.code) parts.push(extracted.code);
  else parts.push('Livestream action failed');
  if (extracted.code && extracted.message && !String(extracted.message).includes(extracted.code)) {
    parts.push(`(${extracted.code})`);
  }
  const text = parts.join(' ').trim();
  if (!text || /^request failed$/i.test(text)) {
    return extracted.code ? `Livestream failed (${extracted.code})` : 'Livestream failed — see system status';
  }
  return text;
}
