// FROZEN player protocol core. The player (server/player/index.html) and deployed
// TVs only react to THESE exact event strings for socket events. TRANSPORT action
// names below are the shared vocabulary between controller UI and player.
// Controller emits over the /dashboard socket; the server relays them to the
// device room as the device:* events listed in comments.

export const DEVICE_COMMAND = 'dashboard:device-command'; // -> device:command {type,payload}
export const COMMAND_TYPES = Object.freeze({
  REFRESH: 'refresh', LAUNCH: 'launch',
  SCREEN_ON: 'screen_on', SCREEN_OFF: 'screen_off',
  TRANSPORT: 'transport', // payload.action is one of TRANSPORT_ACTIONS
});

// Classic bar actions retained for deployed operators; expanded set used by
// explicit slide/video controls. Player accepts all of these.
export const TRANSPORT_ACTIONS = Object.freeze([
  'next', 'prev', 'play_pause', 'restart', 'scroll_up', 'scroll_down',
  'play', 'pause', 'resume', 'stop',
  'seek', 'seek_forward', 'seek_backward',
  'go_to_slide', 'mute', 'unmute', 'volume',
  'next_slide', 'previous_slide', 'restart_deck',
]);

// Authoritative classroom transport command lifecycle. UI must not show success
// merely because Socket.IO delivered the envelope — CONFIRMATION comes from
// player-reported state matching the requested outcome (command:ack ok:true).
export const COMMAND_LIFECYCLE = Object.freeze({
  REQUESTED: 'REQUESTED',
  DELIVERED: 'DELIVERED',
  PENDING: 'PENDING',
  ACKNOWLEDGED: 'ACKNOWLEDGED',
  CONFIRMED: 'CONFIRMED',
  FAILED: 'FAILED',
  STALE: 'STALE',
  OFFLINE: 'OFFLINE',
});

// Explicit target fields that every playback command should carry when known.
// The player rejects ambiguous multi-zone control without these.
export const TARGET_FIELDS = Object.freeze([
  'workspace_id',
  'room_id',
  'wall_id',
  'device_id',
  'zone_id',
  'cell_id',
  'content_instance_id',
  'content_id',
  'expected_revision',
  'command_id',
]);

export const DEFAULT_COMMAND_TIMEOUT_MS = 8000;

export function isTransportAction(action) {
  return TRANSPORT_ACTIONS.includes(String(action || '').trim());
}

/** Build target metadata payload fragment without inventing a display id. */
export function buildTransportTarget(target = {}) {
  const out = {};
  for (const key of TARGET_FIELDS) {
    if (key === 'command_id') continue;
    const value = target[key] ?? target[key.replace(/_([a-z])/g, (_, c) => c.toUpperCase())];
    if (value != null && value !== '') out[key] = value;
  }
  return out;
}

// Whiteboard (NOTE the asymmetry: controller emits dashboard:wb-START, the
// player receives device:wb-SHOW; the other four keep their suffix).
export const WB = Object.freeze({
  START: 'dashboard:wb-start', STROKE: 'dashboard:wb-stroke',
  CLEAR: 'dashboard:wb-clear', UNDO: 'dashboard:wb-undo', STOP: 'dashboard:wb-stop',
});

// Screen-share signaling (broadcaster -> server -> device:screen-share-*).
export const SS = Object.freeze({
  START: 'screen-share:start', OFFER: 'screen-share:offer',
  ICE: 'screen-share:ice-candidate', FRAME: 'screen-share:frame',
  STOP: 'screen-share:stop',
});

export const FIT_MODES = Object.freeze(['cover', 'contain', 'fill', 'none', 'scale-down']);
export function isValidFit(m) { return FIT_MODES.includes(m); }
