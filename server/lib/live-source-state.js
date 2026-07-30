'use strict';

const VOLATILE_SIGNAL_FIELDS = new Set([
  'input_level_db',
  'mean_level_db',
  'last_audio_frame_at',
  'last_audio_measurement_at',
  'last_update',
]);

function persistedSignal(signal) {
  const stable = {};
  for (const [key, value] of Object.entries(signal && typeof signal === 'object' ? signal : {})) {
    if (!VOLATILE_SIGNAL_FIELDS.has(key)) stable[key] = value;
  }
  return stable;
}

module.exports = {
  persistedSignal,
};
