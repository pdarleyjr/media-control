const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(
  path.join(__dirname, '..', '..', 'scripts', 'live-wall-fanout-smoke.js'),
  'utf8',
);

test('live wall smoke uses a revision-bound typed wall target', () => {
  assert.match(source, /type:\s*'wall'/);
  assert.match(source, /layout_revision:\s*layoutRevision/);
  assert.doesNotMatch(source, /device_ids/);
});

test('live wall smoke requires every member to confirm probe and restore', () => {
  assert.match(source, /body\.sent !== expectedTargetCount/);
  assert.match(source, /body\.total !== expectedTargetCount/);
  assert.match(source, /waitForDeliveryConfirmation/);
  assert.match(source, /request\.status === 'confirmed'/);
  assert.match(source, /request\.devices\.length === expectedTargetCount/);
  assert.match(source, /waitForPhysicalState/);
  assert.match(source, /waitForTimeAdvance/);
});

test('live wall smoke reads the persisted media clock instead of SQLite CURRENT_TIME', () => {
  const quotedClockReads = source.match(/"current_time" AS current_time/g) || [];
  assert.equal(quotedClockReads.length, 2);
});
