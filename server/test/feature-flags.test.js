'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  buildEnterpriseOperatorUiFlag,
  authorizeFlag,
  resolveFeatureFlags,
  parseAllowlist,
} = require('../lib/feature-flags');

const CANARY = 'user-canary-001';
const OTHER = 'user-other-002';

test('flag defaults off when ENTERPRISE_OPERATOR_UI_ENABLED is undefined', () => {
  const flag = buildEnterpriseOperatorUiFlag({});
  assert.equal(flag.enabled, false);
  assert.equal(authorizeFlag(flag, CANARY).authorized, false);
});

test('flag is off for malformed enabled value (only true/1 accepted)', () => {
  for (const v of ['yes', 'on', 'TRUE-ish', '2', 'false', '0']) {
    assert.equal(buildEnterpriseOperatorUiFlag({ ENTERPRISE_OPERATOR_UI_ENABLED: v }).enabled, false);
  }
  assert.equal(buildEnterpriseOperatorUiFlag({ ENTERPRISE_OPERATOR_UI_ENABLED: 'true' }).enabled, true);
  assert.equal(buildEnterpriseOperatorUiFlag({ ENTERPRISE_OPERATOR_UI_ENABLED: '1' }).enabled, true);
});

test('feature globally off: no user is authorized even if in allowlist', () => {
  const flag = buildEnterpriseOperatorUiFlag({
    ENTERPRISE_OPERATOR_UI_ENABLED: 'false',
    ENTERPRISE_OPERATOR_UI_USERS: CANARY,
  });
  assert.equal(authorizeFlag(flag, CANARY).authorized, false);
  assert.equal(authorizeFlag(flag, CANARY).enabled, false);
});

test('empty allowlist is fail-closed: nobody authorized even with flag on', () => {
  for (const raw of ['', '   ', ',,,,', undefined]) {
    const flag = buildEnterpriseOperatorUiFlag({
      ENTERPRISE_OPERATOR_UI_ENABLED: 'true',
      ENTERPRISE_OPERATOR_UI_USERS: raw,
    });
    assert.equal(flag.allowAll, false, `allowAll for ${JSON.stringify(raw)}`);
    assert.equal(flag.allowlist.length, 0, `allowlist for ${JSON.stringify(raw)}`);
    assert.equal(authorizeFlag(flag, CANARY).authorized, false);
    assert.equal(authorizeFlag(flag, OTHER).authorized, false);
  }
});

test('malformed allowlist (garbage, no real id, no *) is fail-closed', () => {
  const flag = buildEnterpriseOperatorUiFlag({
    ENTERPRISE_OPERATOR_UI_ENABLED: 'true',
    ENTERPRISE_OPERATOR_UI_USERS: '!!!, ???, ,  ',
  });
  assert.equal(flag.allowAll, false);
  assert.equal(authorizeFlag(flag, CANARY).authorized, false);
  assert.equal(authorizeFlag(flag, OTHER).authorized, false);
  // No real user id can match pure-garbage entries.
  for (const id of flag.allowlist) {
    assert.ok(!/^[a-zA-Z0-9_-]+$/.test(id), `garbage entry should not look like an id: ${id}`);
  }
});

test('authorized canary user: explicit id match authorizes only that user', () => {
  const flag = buildEnterpriseOperatorUiFlag({
    ENTERPRISE_OPERATOR_UI_ENABLED: 'true',
    ENTERPRISE_OPERATOR_UI_USERS: CANARY,
  });
  assert.equal(authorizeFlag(flag, CANARY).authorized, true);
  assert.equal(authorizeFlag(flag, OTHER).authorized, false);
});

test('authenticated non-canary user is denied (not in allowlist, no *)', () => {
  const flag = buildEnterpriseOperatorUiFlag({
    ENTERPRISE_OPERATOR_UI_ENABLED: 'true',
    ENTERPRISE_OPERATOR_UI_USERS: CANARY,
  });
  assert.equal(authorizeFlag(flag, OTHER).authorized, false);
});

test('wildcard "*" allows every authenticated user (explicit opt-in)', () => {
  const flag = buildEnterpriseOperatorUiFlag({
    ENTERPRISE_OPERATOR_UI_ENABLED: 'true',
    ENTERPRISE_OPERATOR_UI_USERS: '*',
  });
  assert.equal(flag.allowAll, true);
  assert.equal(authorizeFlag(flag, CANARY).authorized, true);
  assert.equal(authorizeFlag(flag, OTHER).authorized, true);
});

test('"*" mixed with explicit ids still allows everyone', () => {
  const flag = buildEnterpriseOperatorUiFlag({
    ENTERPRISE_OPERATOR_UI_ENABLED: 'true',
    ENTERPRISE_OPERATOR_UI_USERS: `${CANARY}, *`,
  });
  assert.equal(flag.allowAll, true);
  assert.deepEqual(flag.allowlist, [CANARY]);
  assert.equal(authorizeFlag(flag, OTHER).authorized, true);
});

test('foreign-workspace user id is not special: only canonical id match counts', () => {
  const flag = buildEnterpriseOperatorUiFlag({
    ENTERPRISE_OPERATOR_UI_ENABLED: 'true',
    ENTERPRISE_OPERATOR_UI_USERS: CANARY,
  });
  assert.equal(authorizeFlag(flag, 'prefix-' + CANARY).authorized, false);
  assert.equal(authorizeFlag(flag, CANARY + '-suffix').authorized, false);
  assert.equal(authorizeFlag(flag, CANARY.toUpperCase()).authorized, false);
});

test('resolveFeatureFlags maps all flags and never discloses the allowlist', () => {
  const flags = {
    enterpriseOperatorUi: buildEnterpriseOperatorUiFlag({
      ENTERPRISE_OPERATOR_UI_ENABLED: 'true',
      ENTERPRISE_OPERATOR_UI_USERS: CANARY,
    }),
  };
  const out = resolveFeatureFlags(flags, CANARY);
  assert.deepEqual(out.enterpriseOperatorUi, { enabled: true, authorized: true });
  const outOther = resolveFeatureFlags(flags, OTHER);
  assert.deepEqual(outOther.enterpriseOperatorUi, { enabled: true, authorized: false });
  // Response shape is only { enabled, authorized } — no allowlist leak.
  assert.ok(!('allowlist' in out.enterpriseOperatorUi));
  assert.ok(!('allowAll' in out.enterpriseOperatorUi));
});

test('parseAllowlist trims and drops empties but keeps real ids', () => {
  const r = parseAllowlist(' a ,, , b ,');
  assert.deepEqual(r.allowlist, ['a', 'b']);
  assert.equal(r.allowAll, false);
});

test('feature-endpoint-failure semantics: a missing/undefined flag resolves off', () => {
  // Simulates a config where the flag object is absent (e.g. feature discovery
  // failure). resolveFeatureFlags must not throw and must report enabled=false.
  const out = resolveFeatureFlags({ enterpriseOperatorUi: undefined }, CANARY);
  assert.equal(out.enterpriseOperatorUi.enabled, false);
  assert.equal(out.enterpriseOperatorUi.authorized, false);
});
