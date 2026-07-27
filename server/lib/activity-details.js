'use strict';

function normalizeActivityDetails(details) {
  if (details == null) return null;
  if (typeof details === 'string') return details;
  try {
    return JSON.stringify(details);
  } catch (_) {
    return String(details);
  }
}

module.exports = { normalizeActivityDetails };
