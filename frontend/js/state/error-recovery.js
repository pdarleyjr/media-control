// Error prevention & recovery model (task §13).
//
// Every operational failure maps to a structured Recovery object so the UI can
// present, without ever showing a generic "Something went wrong":
//   { whatHappened, remainsActive, operatorAction, retrySafe }
//
// The catalogue keys off the room contract's observable signals (device
// status, command ack status, revision mismatch, livestream/stream/recording
// slices). Labels are i18n keys; the visible text is color-independent.

export const ERROR_CODES = Object.freeze({
  DISPLAY_OFFLINE: 'display_offline',
  STALE_ROOM_STATE: 'stale_room_state',
  CONFLICTING_COMMAND: 'conflicting_command',
  UNAUTHORIZED_ACTION: 'unauthorized_action',
  CONTENT_PROCESSING: 'content_processing',
  INCOMPATIBLE_MEDIA: 'incompatible_media',
  SCREEN_SHARE_NO_AUDIO: 'screen_share_no_audio',
  CAMERA_DISCONNECTED: 'camera_disconnected',
  FAILED_LAYOUT: 'failed_layout',
  PEERTUBE_UNAVAILABLE: 'peertube_unavailable',
  OBS_UNAVAILABLE: 'obs_unavailable',
  RECORDING_FAILURE: 'recording_failure',
  REVISION_MISMATCH: 'revision_mismatch',
  UNKNOWN: 'unknown_error',
});

// Each entry: titleKey, whatHappenedKey, remainsActiveKey, actionKey, retrySafe.
export const ERROR_RECOVERY = Object.freeze({
  [ERROR_CODES.DISPLAY_OFFLINE]: {
    titleKey: 'mc.e.err.display_offline.title',
    whatHappenedKey: 'mc.e.err.display_offline.what',
    remainsActiveKey: 'mc.e.err.display_offline.active',
    actionKey: 'mc.e.err.display_offline.action',
    retrySafe: true,
  },
  [ERROR_CODES.STALE_ROOM_STATE]: {
    titleKey: 'mc.e.err.stale_room_state.title',
    whatHappenedKey: 'mc.e.err.stale_room_state.what',
    remainsActiveKey: 'mc.e.err.stale_room_state.active',
    actionKey: 'mc.e.err.stale_room_state.action',
    retrySafe: true,
  },
  [ERROR_CODES.CONFLICTING_COMMAND]: {
    titleKey: 'mc.e.err.conflicting_command.title',
    whatHappenedKey: 'mc.e.err.conflicting_command.what',
    remainsActiveKey: 'mc.e.err.conflicting_command.active',
    actionKey: 'mc.e.err.conflicting_command.action',
    retrySafe: false,
  },
  [ERROR_CODES.UNAUTHORIZED_ACTION]: {
    titleKey: 'mc.e.err.unauthorized.title',
    whatHappenedKey: 'mc.e.err.unauthorized.what',
    remainsActiveKey: 'mc.e.err.unauthorized.active',
    actionKey: 'mc.e.err.unauthorized.action',
    retrySafe: false,
  },
  [ERROR_CODES.CONTENT_PROCESSING]: {
    titleKey: 'mc.e.err.content_processing.title',
    whatHappenedKey: 'mc.e.err.content_processing.what',
    remainsActiveKey: 'mc.e.err.content_processing.active',
    actionKey: 'mc.e.err.content_processing.action',
    retrySafe: true,
  },
  [ERROR_CODES.INCOMPATIBLE_MEDIA]: {
    titleKey: 'mc.e.err.incompatible_media.title',
    whatHappenedKey: 'mc.e.err.incompatible_media.what',
    remainsActiveKey: 'mc.e.err.incompatible_media.active',
    actionKey: 'mc.e.err.incompatible_media.action',
    retrySafe: false,
  },
  [ERROR_CODES.SCREEN_SHARE_NO_AUDIO]: {
    titleKey: 'mc.e.err.ss_no_audio.title',
    whatHappenedKey: 'mc.e.err.ss_no_audio.what',
    remainsActiveKey: 'mc.e.err.ss_no_audio.active',
    actionKey: 'mc.e.err.ss_no_audio.action',
    retrySafe: true,
  },
  [ERROR_CODES.CAMERA_DISCONNECTED]: {
    titleKey: 'mc.e.err.camera_disconnected.title',
    whatHappenedKey: 'mc.e.err.camera_disconnected.what',
    remainsActiveKey: 'mc.e.err.camera_disconnected.active',
    actionKey: 'mc.e.err.camera_disconnected.action',
    retrySafe: true,
  },
  [ERROR_CODES.FAILED_LAYOUT]: {
    titleKey: 'mc.e.err.failed_layout.title',
    whatHappenedKey: 'mc.e.err.failed_layout.what',
    remainsActiveKey: 'mc.e.err.failed_layout.active',
    actionKey: 'mc.e.err.failed_layout.action',
    retrySafe: true,
  },
  [ERROR_CODES.PEERTUBE_UNAVAILABLE]: {
    titleKey: 'mc.e.err.peertube_unavailable.title',
    whatHappenedKey: 'mc.e.err.peertube_unavailable.what',
    remainsActiveKey: 'mc.e.err.peertube_unavailable.active',
    actionKey: 'mc.e.err.peertube_unavailable.action',
    retrySafe: true,
  },
  [ERROR_CODES.OBS_UNAVAILABLE]: {
    titleKey: 'mc.e.err.obs_unavailable.title',
    whatHappenedKey: 'mc.e.err.obs_unavailable.what',
    remainsActiveKey: 'mc.e.err.obs_unavailable.active',
    actionKey: 'mc.e.err.obs_unavailable.action',
    retrySafe: true,
  },
  [ERROR_CODES.RECORDING_FAILURE]: {
    titleKey: 'mc.e.err.recording_failure.title',
    whatHappenedKey: 'mc.e.err.recording_failure.what',
    remainsActiveKey: 'mc.e.err.recording_failure.active',
    actionKey: 'mc.e.err.recording_failure.action',
    retrySafe: true,
  },
  [ERROR_CODES.REVISION_MISMATCH]: {
    titleKey: 'mc.e.err.revision_mismatch.title',
    whatHappenedKey: 'mc.e.err.revision_mismatch.what',
    remainsActiveKey: 'mc.e.err.revision_mismatch.active',
    actionKey: 'mc.e.err.revision_mismatch.action',
    retrySafe: true,
  },
  [ERROR_CODES.UNKNOWN]: {
    titleKey: 'mc.e.err.unknown.title',
    whatHappenedKey: 'mc.e.err.unknown.what',
    remainsActiveKey: 'mc.e.err.unknown.active',
    actionKey: 'mc.e.err.unknown.action',
    retrySafe: true,
  },
});

export function recoveryForCode(code) {
  return ERROR_RECOVERY[code] || ERROR_RECOVERY[ERROR_CODES.UNKNOWN];
}

// Derive an error code from a raw failure signal (HTTP code / ack reason /
// room contract slice). Used by adapters to normalize before rendering.
export function deriveErrorCode(signal = {}) {
  const status = Number(signal.status) || 0;
  if (status === 401 || status === 403 || /forbidden|unauthor/i.test(String(signal.reason))) {
    return ERROR_CODES.UNAUTHORIZED_ACTION;
  }
  if (status === 409) {
    if (/revision|layout/i.test(String(signal.code || signal.reason))) return ERROR_CODES.REVISION_MISMATCH;
    return ERROR_CODES.CONFLICTING_COMMAND;
  }
  if (signal.code === 'LAYOUT_REVISION_CONFLICT') return ERROR_CODES.REVISION_MISMATCH;
  if (signal.code === 'CONFIRM_ALL_REQUIRED') return ERROR_CODES.CONFLICTING_COMMAND;
  if (/peertube/i.test(String(signal.service || signal.reason))) return ERROR_CODES.PEERTUBE_UNAVAILABLE;
  if (/obs|director/i.test(String(signal.service || signal.reason))) return ERROR_CODES.OBS_UNAVAILABLE;
  if (signal.reason === 'offline' || signal.offline === true) return ERROR_CODES.DISPLAY_OFFLINE;
  if (signal.status === 'timeout' || signal.stale === true) return ERROR_CODES.STALE_ROOM_STATE;
  if (signal.processing === true) return ERROR_CODES.CONTENT_PROCESSING;
  return ERROR_CODES.UNKNOWN;
}
