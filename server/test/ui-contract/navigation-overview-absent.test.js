const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { importModule } = require('./lib/esm-bundle.js');

const MEDIA_CONTROL = path.join(__dirname, '../../../frontend/js/views/media-control.js');
const TARGET_SELECTOR = path.join(__dirname, '../../../frontend/js/views/media-control/target-selector.js');
const COMMAND_CENTER_STATE = path.join(__dirname, '../../../frontend/js/services/command-center-state.js');

const mcSource = fs.readFileSync(MEDIA_CONTROL, 'utf8');
const tsSource = fs.readFileSync(TARGET_SELECTOR, 'utf8');

test('Room Overview / Focus View mode toggle is removed from the operator UI', () => {
  // No mode-toggle buttons in the canonical render template.
  assert.doesNotMatch(mcSource, /mc-cc-view-switch/);
  assert.doesNotMatch(mcSource, />Room Overview</);
  assert.doesNotMatch(mcSource, />Focus View</);
  assert.doesNotMatch(mcSource, /data-mc-view-mode=/);
  // No Room Overview surface/host elements (must not occupy layout or focus).
  assert.doesNotMatch(mcSource, /mc-room-overview-surface/);
  assert.doesNotMatch(mcSource, /mc-room-overview-host/);
  // The overview-mounting functions and the mode-toggle wiring are gone.
  assert.doesNotMatch(mcSource, /\bactivateRoomOverview\b/);
  assert.doesNotMatch(mcSource, /\bmountRoomOverviewSurface\b/);
  assert.doesNotMatch(mcSource, /\bpaintViewModeControls\b/);
  assert.doesNotMatch(mcSource, /\bsetViewModeSurfaces\b/);
});

test('the app always opens in a focused view and restores the last target', () => {
  assert.match(mcSource, /restoreLastFocusedTarget\(\)/);
  assert.match(mcSource, /function chooseDefaultFocusTarget/);
  // Default fallback chain names Primary Wall then Secondary Wall explicitly.
  assert.match(mcSource, /findWallByName\('Primary Wall'\)/);
  assert.match(mcSource, /findWallByName\('Secondary Wall'\)/);
  // Restoring must not write a preference or emit a command.
  assert.match(mcSource, /restoringTarget/);
});

test('command-center-state defaults to FOCUS (overview is not the default mode)', async () => {
  const m = await importModule(COMMAND_CENTER_STATE);
  assert.equal(m.createCommandCenterState().viewMode, m.VIEW_MODE.FOCUS);
});

test('quick-focus tabs always include Primary + Secondary Wall defaults', () => {
  // defaultPinRefs identifies the two walls by name and orders Primary first.
  assert.match(tsSource, /find\('Primary Wall'\)/);
  assert.match(tsSource, /find\('Secondary Wall'\)/);
  // A "Customize quick views" action exists and is keyboard/touch reachable.
  assert.match(tsSource, /data-customize/);
  assert.match(tsSource, /Customize quick views/);
  // The dropdown still carries every remaining authorized target.
  assert.match(tsSource, /mc-target-select/);
});

test('selecting a target emits no playback command (view-only contract preserved)', () => {
  assert.match(tsSource, /VIEW-ONLY/);
  // The selector reports selection via onTargetChange only; no sendCommand import.
  assert.doesNotMatch(tsSource, /sendCommand/);
});
