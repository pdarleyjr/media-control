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

function _clearForTests() {
  registry.clear();
}

module.exports = { record, get, _clearForTests };
