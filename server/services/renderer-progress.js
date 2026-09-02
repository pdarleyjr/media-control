'use strict';

const { RendererProgressRegistry } = require('../lib/media-progress');

// This is an intentionally ephemeral read model. It is bounded and fed only by
// existing device state reports; no progress sample writes a database row.
const registry = new RendererProgressRegistry({ maxEntries: 50 });

function record(deviceId, report) {
  return registry.record(deviceId, report);
}

function get(deviceId) {
  return registry.get(deviceId);
}

function clear(deviceId) {
  if (deviceId == null) return;
  registry.entries.delete(String(deviceId));
}

function _clearForTests() {
  registry.clear();
}

module.exports = { record, get, clear, _clearForTests };
