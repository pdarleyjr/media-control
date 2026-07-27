'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { normalizeActivityDetails } = require('../lib/activity-details');

test('activity details bind as text even when a caller supplies structured metadata', () => {
  assert.equal(normalizeActivityDetails(null), null);
  assert.equal(normalizeActivityDetails('already text'), 'already text');
  assert.equal(
    normalizeActivityDetails({ content_id: 'image-1', filename: 'wall.png' }),
    '{"content_id":"image-1","filename":"wall.png"}',
  );
});

test('activity detail normalization remains best-effort for circular diagnostic objects', () => {
  const circular = {};
  circular.self = circular;
  assert.equal(normalizeActivityDetails(circular), '[object Object]');
});
