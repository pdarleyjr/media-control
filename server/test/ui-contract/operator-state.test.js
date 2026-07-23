const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { importModule } = require('./lib/esm-bundle.js');

const STATE = path.join(__dirname, '../../../frontend/js/state/operator-state.js');

test('operator state vocabulary is frozen and exhaustive', async () => {
  const m = await importModule(STATE);
  assert.deepEqual([...m.OPERATOR_STATES].sort(), [
    'confirmed', 'failed', 'offline', 'pending', 'requested', 'stale', 'standby',
  ]);
  assert.equal(Object.isFrozen(m.OPERATOR_STATE), true);
  assert.equal(Object.isFrozen(m.OPERATOR_STATES), true);
});

test('every state has a non-color-only meta (tone + glyph + label key)', async () => {
  const m = await importModule(STATE);
  for (const s of m.OPERATOR_STATES) {
    const meta = m.OPERATOR_STATE_META[s];
    assert.ok(meta, `missing meta for ${s}`);
    assert.ok(typeof meta.tone === 'string' && meta.tone.length, `${s} missing tone`);
    assert.ok(typeof meta.glyph === 'string' && meta.glyph.length, `${s} missing glyph`);
    assert.ok(typeof meta.labelKey === 'string' && meta.labelKey.startsWith('mc.e.op_state.'), `${s} missing label key`);
  }
});

test('displayOperatorState maps confirmed/pending/offline/failed/stale', async () => {
  const m = await importModule(STATE);
  assert.equal(m.displayOperatorState(null), m.OPERATOR_STATE.STANDBY);
  assert.equal(m.displayOperatorState({ status: 'offline' }), m.OPERATOR_STATE.OFFLINE);
  assert.equal(m.displayOperatorState({ status: 'online', contentId: 'c1' }, []), m.OPERATOR_STATE.CONFIRMED);
  assert.equal(m.displayOperatorState({ status: 'online' }, [{ status: 'sent' }]), m.OPERATOR_STATE.PENDING);
  assert.equal(m.displayOperatorState({ status: 'online' }, [{ status: 'failed' }]), m.OPERATOR_STATE.FAILED);
  assert.equal(m.displayOperatorState({ status: 'online' }, [{ ok: false }]), m.OPERATOR_STATE.FAILED);
  assert.equal(m.displayOperatorState({ status: 'online' }, [{ status: 'timeout' }]), m.OPERATOR_STATE.STALE);
  assert.equal(m.displayOperatorState({ status: 'online', contentId: 'c1' }, [{ status: 'acked' }]), m.OPERATOR_STATE.CONFIRMED);
});

test('commandOperatorState maps command status vocabulary', async () => {
  const m = await importModule(STATE);
  assert.equal(m.commandOperatorState({ status: 'sent' }), m.OPERATOR_STATE.PENDING);
  // §8: a player ACK proves RECEIPT only — it is NOT physical confirmation.
  // ACKNOWLEDGED stays PENDING until a matching player-state report arrives.
  assert.equal(m.commandOperatorState({ status: 'acked' }), m.OPERATOR_STATE.PENDING);
  assert.equal(m.commandOperatorState({ status: 'acknowledged' }), m.OPERATOR_STATE.PENDING);
  // CONFIRMED requires an explicit server-side state-match reconciliation
  // (matching paused/currentTime/content_instance_id) — never reached on ack alone.
  assert.equal(m.commandOperatorState({ status: 'confirmed' }), m.OPERATOR_STATE.CONFIRMED);
  assert.equal(m.commandOperatorState({ status: 'timeout' }), m.OPERATOR_STATE.STALE);
  assert.equal(m.commandOperatorState({ status: 'failed' }), m.OPERATOR_STATE.FAILED);
  assert.equal(m.commandOperatorState({ ok: false }), m.OPERATOR_STATE.FAILED);
  assert.equal(m.commandOperatorState({ status: 'queued' }), m.OPERATOR_STATE.PENDING);
});

test('highestState surfaces the most attention-worthy state', async () => {
  const m = await importModule(STATE);
  assert.equal(m.highestState([m.OPERATOR_STATE.STANDBY, m.OPERATOR_STATE.CONFIRMED]), m.OPERATOR_STATE.CONFIRMED);
  assert.equal(m.highestState([m.OPERATOR_STATE.CONFIRMED, m.OPERATOR_STATE.FAILED]), m.OPERATOR_STATE.FAILED);
  assert.equal(m.highestState([m.OPERATOR_STATE.OFFLINE, m.OPERATOR_STATE.FAILED]), m.OPERATOR_STATE.OFFLINE);
  assert.equal(m.highestState([]), m.OPERATOR_STATE.STANDBY);
});
