const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { importModule } = require('./lib/esm-bundle.js');

const ERR = path.join(__dirname, '../../../frontend/js/state/error-recovery.js');

test('every error code has a recovery entry with the four required fields', async () => {
  const m = await importModule(ERR);
  for (const code of Object.values(m.ERROR_CODES)) {
    const r = m.recoveryForCode(code);
    assert.ok(r, `missing recovery for ${code}`);
    for (const f of ['titleKey', 'whatHappenedKey', 'remainsActiveKey', 'actionKey']) {
      assert.ok(typeof r[f] === 'string' && r[f].length, `${code} missing ${f}`);
    }
    assert.equal(typeof r.retrySafe, 'boolean', `${code} retrySafe must be boolean`);
  }
});

test('recovery never returns generic copy — keys are structured', async () => {
  const m = await importModule(ERR);
  const r = m.recoveryForCode(m.ERROR_CODES.DISPLAY_OFFLINE);
  assert.ok(!/something went wrong/i.test(r.whatHappenedKey));
});

test('deriveErrorCode maps HTTP/ack signals to specific codes', async () => {
  const m = await importModule(ERR);
  assert.equal(m.deriveErrorCode({ status: 403 }), m.ERROR_CODES.UNAUTHORIZED_ACTION);
  assert.equal(m.deriveErrorCode({ status: 401 }), m.ERROR_CODES.UNAUTHORIZED_ACTION);
  assert.equal(m.deriveErrorCode({ status: 409, code: 'LAYOUT_REVISION_CONFLICT' }), m.ERROR_CODES.REVISION_MISMATCH);
  assert.equal(m.deriveErrorCode({ status: 409, code: 'CONFIRM_ALL_REQUIRED' }), m.ERROR_CODES.CONFLICTING_COMMAND);
  assert.equal(m.deriveErrorCode({ reason: 'offline' }), m.ERROR_CODES.DISPLAY_OFFLINE);
  assert.equal(m.deriveErrorCode({ status: 'timeout' }), m.ERROR_CODES.STALE_ROOM_STATE);
  assert.equal(m.deriveErrorCode({ service: 'peertube' }), m.ERROR_CODES.PEERTUBE_UNAVAILABLE);
  assert.equal(m.deriveErrorCode({ service: 'obs' }), m.ERROR_CODES.OBS_UNAVAILABLE);
});
