const test = require('node:test');
const assert = require('node:assert/strict');

const { createScreenStateController } = require('../player/screen-state');

function controller(initialState = null) {
  const applied = [];
  const persisted = [];
  const instance = createScreenStateController({
    initialState,
    apply(screenOn) { applied.push(screenOn); },
    persist(state) { persisted.push(state); },
  });
  return { instance, applied, persisted };
}

test('screen_off is idempotent across five duplicate deliveries', () => {
  const { instance, applied } = controller({ screen_on: true, target_revision: 0 });
  for (let revision = 1; revision <= 5; revision += 1) {
    const result = instance.applyCommand({
      command_id: `off-${revision}`,
      target_revision: revision,
      screen_on: false,
    });
    assert.equal(result.applied, true);
    assert.equal(result.state.screen_on, false);
  }
  assert.deepEqual(applied, [true, false, false, false, false, false]);
});

test('screen_on is idempotent across five duplicate deliveries', () => {
  const { instance, applied } = controller({ screen_on: false, target_revision: 5 });
  for (let revision = 6; revision <= 10; revision += 1) {
    const result = instance.applyCommand({
      command_id: `on-${revision}`,
      target_revision: revision,
      screen_on: true,
    });
    assert.equal(result.applied, true);
    assert.equal(result.state.screen_on, true);
  }
  assert.deepEqual(applied, [false, true, true, true, true, true]);
});

test('late OFF cannot reverse a newer ON command', () => {
  const { instance } = controller({ screen_on: true, target_revision: 0 });
  assert.equal(instance.applyCommand({ command_id: 'on-2', target_revision: 2, screen_on: true }).applied, true);
  const stale = instance.applyCommand({ command_id: 'off-1', target_revision: 1, screen_on: false });
  assert.equal(stale.applied, false);
  assert.equal(stale.reason, 'stale_revision');
  assert.equal(instance.snapshot().screen_on, true);
  assert.equal(instance.snapshot().command_revision, 'on-2');
});

test('late ON cannot reverse a newer OFF command', () => {
  const { instance } = controller({ screen_on: true, target_revision: 0 });
  assert.equal(instance.applyCommand({ command_id: 'off-2', target_revision: 2, screen_on: false }).applied, true);
  const stale = instance.applyCommand({ command_id: 'on-1', target_revision: 1, screen_on: true });
  assert.equal(stale.applied, false);
  assert.equal(instance.snapshot().screen_on, false);
  assert.equal(instance.snapshot().command_revision, 'off-2');
});

test('duplicate command replay preserves the requested state', () => {
  const { instance } = controller();
  const command = { command_id: 'off-7', target_revision: 7, screen_on: false };
  assert.equal(instance.applyCommand(command).applied, true);
  assert.equal(instance.applyCommand(command).applied, true);
  assert.equal(instance.snapshot().screen_on, false);
});

test('persisted blank state survives controller recreation', () => {
  const first = controller();
  first.instance.applyCommand({ command_id: 'off-4', target_revision: 4, screen_on: false });
  const restored = controller(first.persisted.at(-1));
  assert.equal(restored.instance.snapshot().screen_on, false);
  assert.equal(restored.instance.snapshot().target_revision, 4);
  assert.deepEqual(restored.applied, [false]);
});

test('confirmed server restore re-applies blank state when local storage is empty', () => {
  const { instance, applied } = controller();
  const result = instance.restoreConfirmed({ screen_on: false, command_revision: 'off-11' });
  assert.equal(result.restored, true);
  assert.equal(instance.snapshot().screen_on, false);
  assert.equal(instance.snapshot().command_revision, 'off-11');
  assert.deepEqual(applied, [true, false]);
});

test('older conflicting server restore cannot replace persisted local command state', () => {
  const { instance } = controller({ screen_on: true, target_revision: 12, command_revision: 'on-12' });
  const result = instance.restoreConfirmed({ screen_on: false, command_revision: 'off-11' });
  assert.equal(result.restored, false);
  assert.equal(result.reason, 'command_conflict');
  assert.equal(instance.snapshot().screen_on, true);
});
