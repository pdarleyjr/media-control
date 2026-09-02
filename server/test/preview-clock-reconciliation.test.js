const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

async function loadModule() {
  const source = fs.readFileSync(
    path.join(__dirname, '../../frontend/js/views/media-control/preview-clock-reconciliation.js'),
    'utf8',
  );
  return import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
}

test('an unchanged running report is applied once and never creates a preview seek sawtooth', async () => {
  const { reconcilePreviewClock } = await loadModule();
  const first = reconcilePreviewClock({
    previousAnchor: null,
    currentTime: 45,
    reportedTime: 40,
    paused: false,
    updatedAt: 20_000_001_000,
    nowMs: 20_000_011_000,
    duration: 240,
  });

  assert.equal(first.anchor, '40|playing');
  assert.equal(first.stateChanged, true);
  assert.equal(first.targetTime, 45);
  assert.equal(first.shouldSeek, false);

  const repeated = reconcilePreviewClock({
    previousAnchor: first.anchor,
    currentTime: 46.6,
    reportedTime: 40,
    paused: false,
    updatedAt: 20_000_001_000,
    nowMs: 20_000_012_600,
    duration: 240,
  });

  assert.equal(repeated.stateChanged, false);
  assert.equal(repeated.shouldSeek, false, 'a stale heartbeat must not rewind an autonomous preview');
});

test('a genuinely new report can correct drift once', async () => {
  const { reconcilePreviewClock } = await loadModule();
  const decision = reconcilePreviewClock({
    previousAnchor: '40|playing',
    currentTime: 47,
    reportedTime: 60,
    paused: false,
    updatedAt: 20_000_020_000,
    nowMs: 20_000_021_000,
    duration: 240,
  });

  assert.equal(decision.anchor, '60|playing');
  assert.equal(decision.stateChanged, true);
  assert.equal(decision.targetTime, 61);
  assert.equal(decision.shouldSeek, true);
});

test('pause and resume transitions remain authoritative even at the same position', async () => {
  const { reconcilePreviewClock } = await loadModule();
  const paused = reconcilePreviewClock({
    previousAnchor: '60|playing',
    currentTime: 61,
    reportedTime: 60,
    paused: true,
    updatedAt: 20_000_021_000,
    nowMs: 20_000_022_000,
    duration: 240,
  });
  const resumed = reconcilePreviewClock({
    previousAnchor: paused.anchor,
    currentTime: 61,
    reportedTime: 60,
    paused: false,
    updatedAt: 20_000_022_000,
    nowMs: 20_000_023_000,
    duration: 240,
  });

  assert.equal(paused.anchor, '60|paused');
  assert.equal(paused.stateChanged, true);
  assert.equal(paused.targetTime, 60);
  assert.equal(resumed.anchor, '60|playing');
  assert.equal(resumed.stateChanged, true);
});
