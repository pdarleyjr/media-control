// FROZEN player protocol. The player (server/player/index.html) and deployed
// TVs only react to THESE exact event strings. NEVER add or rename one here
// without changing the player in lockstep — TVs do not auto-update.
// Controller emits go over the /dashboard socket; the server relays them to the
// device room as the device:* events listed in comments.

export const DEVICE_COMMAND = 'dashboard:device-command'; // -> device:command {type,payload}
export const COMMAND_TYPES = Object.freeze({
  REFRESH: 'refresh', LAUNCH: 'launch',
  SCREEN_ON: 'screen_on', SCREEN_OFF: 'screen_off',
  TRANSPORT: 'transport', // payload: { action: 'next'|'prev'|'play_pause'|'restart'|'scroll_up'|'scroll_down' }
});
export const TRANSPORT_ACTIONS = Object.freeze(['next', 'prev', 'play_pause', 'restart', 'scroll_up', 'scroll_down']);

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
