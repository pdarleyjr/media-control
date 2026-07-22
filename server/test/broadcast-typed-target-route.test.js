const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '../routes/broadcast.js'), 'utf8');

test('broadcast route accepts typed targets alongside legacy device_ids', () => {
  assert.match(source, /targets:\s*target_refs/);
  assert.match(source, /resolveTypedBroadcastTargets\(\{/);
  assert.match(source, /typedRefs\.length > 0\s*\? typedResolution\.targets\s*:\s*legacyIds\.map\(String\)/);
});

test('layout revision conflicts are returned before any live target creation or display push side effect', () => {
  const resolveIndex = source.indexOf('resolveTypedBroadcastTargets({');
  const conflictReturnIndex = source.indexOf('if (!typedResolution.ok)', resolveIndex);
  const liveTargetIndex = source.indexOf('ensureLiveStreamDisplay(', conflictReturnIndex);
  const pushIndex = source.indexOf('sceneEngine.pushSourceToDevice(', conflictReturnIndex);

  assert.ok(resolveIndex >= 0, 'typed target resolver is called');
  assert.ok(conflictReturnIndex > resolveIndex, 'resolver errors are returned');
  assert.ok(liveTargetIndex > conflictReturnIndex, 'live display creation occurs only after conflict return');
  assert.ok(pushIndex > conflictReturnIndex, 'device push occurs only after conflict return');
});

test('Live Program creation and marking occur after target validation and confirm-all return', () => {
  const physicalValidationIndex = source.indexOf('resolveBroadcastTargets({');
  const targetValidationReturnIndex = source.indexOf('if (!resolvedTargets.ok)', physicalValidationIndex);
  const confirmGateIndex = source.indexOf("code: 'CONFIRM_ALL_REQUIRED'", targetValidationReturnIndex);
  const liveTargetIndex = source.indexOf('ensureLiveStreamDisplay(', confirmGateIndex);
  const liveMarkIndex = source.indexOf('markLiveContentChanged(', liveTargetIndex);
  const pushIndex = source.indexOf('sceneEngine.pushSourceToDevice(', liveMarkIndex);

  assert.ok(targetValidationReturnIndex > physicalValidationIndex, 'physical target validation returns before mutation');
  assert.ok(confirmGateIndex > targetValidationReturnIndex, 'confirmation gate follows validation');
  assert.ok(liveTargetIndex > confirmGateIndex, 'live display creation follows confirmation');
  assert.ok(liveMarkIndex > liveTargetIndex, 'live state marking follows creation');
  assert.ok(pushIndex > liveMarkIndex, 'display pushes follow all gates');
});
