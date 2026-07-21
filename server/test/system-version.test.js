const test = require('node:test');
const assert = require('node:assert/strict');

const { buildSystemVersion } = require('../lib/system-version');

test('system version exposes deploy and compatibility identifiers without secrets', () => {
  const fakeDb = {
    prepare() {
      return { get: () => ({ count: 42, latest: 'display_state_revision' }) };
    },
  };
  const version = buildSystemVersion({
    db: fakeDb,
    frontendHash: 'frontend123',
    playerHash: 'player456',
    env: {
      GIT_COMMIT: 'abc123def456',
      GIT_BRANCH: 'main',
      BUILD_TIMESTAMP: '2026-07-10T12:00:00.000Z',
    },
  });

  assert.equal(version.git_commit, 'abc123def456');
  assert.equal(version.branch, 'main');
  assert.equal(version.frontend_bundle_hash, 'frontend123');
  assert.equal(version.player_bundle_hash, 'player456');
  assert.equal(version.command_contract_version, 1);
  assert.equal(version.database_schema.count, 42);
  assert.equal(JSON.stringify(version).includes('token'), false);
});
