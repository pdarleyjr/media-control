const { test } = require('node:test');
const assert = require('node:assert/strict');

const { parseArgs } = require('../scripts/repair-display-topology');

test('topology repair CLI rejects missing option values', () => {
  for (const option of ['--db', '--plan', '--backup-dir', '--actor', '--run-id', '--rollback']) {
    assert.throws(() => parseArgs([option]), new RegExp(`${option} requires a value`));
  }
});

test('topology repair CLI rejects conflicting mutation modes and unsafe run identifiers', () => {
  assert.throws(
    () => parseArgs(['--apply', '--rollback', 'run-1']),
    /cannot be used together/i
  );
  assert.throws(
    () => parseArgs(['--rollback', '../../escape']),
    /safe identifier/i
  );
  assert.throws(
    () => parseArgs(['--run-id', 'unsafe/path']),
    /safe identifier/i
  );
});

test('topology repair CLI accepts a single explicit mode with contained identifiers', () => {
  assert.deepEqual(parseArgs(['--db', 'state.db']), { apply: false, dbPath: 'state.db' });
  assert.deepEqual(parseArgs(['--apply', '--db', 'state.db', '--run-id', 'repair-2026.07.22']), {
    apply: true,
    dbPath: 'state.db',
    runId: 'repair-2026.07.22',
  });
});
