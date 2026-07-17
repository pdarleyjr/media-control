const test = require('node:test');
const assert = require('node:assert/strict');

const contract = require('../player/device-contract');

test('creates a canonical versioned device command with a unique command id', () => {
  const first = contract.createCommand({
    device_id: 'display-1',
    target_scope: 'display',
    payload: { action: 'next' },
  });
  const second = contract.createCommand({
    device_id: 'display-1',
    target_scope: 'display',
    payload: { action: 'next' },
  });

  assert.equal(first.version, 1);
  assert.equal(first.type, 'device:command');
  assert.equal(first.device_id, 'display-1');
  assert.equal(first.payload.action, 'next');
  assert.match(first.command_id, /^[0-9a-f-]{36}$/i);
  assert.notEqual(first.command_id, second.command_id);
  assert.ok(Number.isFinite(Date.parse(first.issued_at)));
});

test('normalizes the legacy transport envelope at the boundary', () => {
  const normalized = contract.normalizeCommand({
    type: 'transport',
    command_id: 'legacy-command',
    payload: { action: 'go_to_slide', slide: 7 },
  }, { device_id: 'display-2' });

  assert.equal(normalized.ok, true);
  assert.equal(normalized.legacy, true);
  assert.equal(normalized.value.type, 'device:command');
  assert.equal(normalized.value.payload.action, 'go_to_slide');
  assert.equal(normalized.value.payload.slide, 7);
  assert.equal(normalized.value.device_id, 'display-2');
});

test('rejects malformed canonical commands and invalid action parameters', () => {
  const missingId = contract.normalizeCommand({
    version: 1,
    type: 'device:command',
    target_scope: 'display',
    device_id: 'display-1',
    payload: { action: 'next' },
  });
  assert.equal(missingId.ok, false);
  assert.equal(missingId.error.code, 'invalid_command_id');

  const badSlide = contract.createCommand({
    device_id: 'display-1',
    payload: { action: 'go_to_slide', slide: 0 },
  });
  const validation = contract.validateCommand(badSlide);
  assert.equal(validation.ok, false);
  assert.equal(validation.error.code, 'invalid_slide');

  const badSeek = contract.createCommand({
    device_id: 'display-1',
    payload: { action: 'seek', position_normalized: 1.1 },
  });
  const seekValidation = contract.validateCommand(badSeek);
  assert.equal(seekValidation.ok, false);
  assert.equal(seekValidation.error.code, 'invalid_seek');
});

test('accepts absolute, normalized, and percentage seek targets', () => {
  for (const payload of [
    { action: 'seek', position_seconds: 12.5 },
    { action: 'seek', position_normalized: 0.5 },
    { action: 'seek', position_percent: 75 },
  ]) {
    const command = contract.createCommand({ device_id: 'display-1', payload });
    assert.equal(contract.validateCommand(command).ok, true);
  }
});

test('creates structured acknowledgements and serialized playback state', () => {
  const state = contract.normalizeState({
    device_id: 'display-1',
    playback_status: 'paused',
    slide_index: 3,
    state_revision: 9,
    muted: false,
  });
  const ack = contract.createAck({
    command_id: 'command-1',
    device_id: 'display-1',
    ok: true,
    state,
  });

  assert.equal(ack.version, 1);
  assert.equal(ack.type, 'device:ack');
  assert.equal(ack.error, null);
  assert.equal(ack.state.state_revision, 9);
  assert.equal(ack.state.muted, false);
  assert.ok(Number.isFinite(Date.parse(ack.completed_at)));
});
