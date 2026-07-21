'use strict';

function firstDefined(...values) {
  for (const value of values) {
    if (value === undefined || value === null) continue;
    const text = String(value).trim();
    if (text) return text;
  }
  return '';
}

function normalizePlayerAccessQuery(query) {
  const q = query || {};
  return {
    deviceId: firstDefined(q.device_id, q.deviceId),
    token: firstDefined(q.token, q.device_token, q.deviceToken),
    audioEnabled:
      q.audio_enabled === '1' || q.audio_enabled === 1 || q.audioEnabled === '1' || q.audioEnabled === 1,
  };
}

module.exports = {
  normalizePlayerAccessQuery,
};
