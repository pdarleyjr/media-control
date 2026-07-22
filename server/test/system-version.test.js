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
      GIT_TREE: 'tree789',
      GIT_BRANCH: 'main',
      BUILD_TIMESTAMP: '2026-07-10T12:00:00.000Z',
      BUILD_ID: 'build-1',
      IMAGE_DIGEST: 'sha256:deadbeef',
      IMAGE_TAG: 'enterprise-test',
    },
  });

  assert.equal(version.git_commit, 'abc123def456');
  assert.equal(version.git_tree, 'tree789');
  assert.equal(version.branch, 'main');
  assert.equal(version.build_id, 'build-1');
  assert.equal(version.image_digest, 'sha256:deadbeef');
  assert.equal(version.image_tag, 'enterprise-test');
  assert.equal(version.hash, 'frontend123');
  assert.equal(version.frontend_bundle_hash, 'frontend123');
  assert.equal(version.player_bundle_hash, 'player456');
  assert.equal(version.player_hash, 'player456');
  assert.equal(version.command_contract_version, 1);
  assert.equal(version.contract_version, 1);
  assert.equal(version.database_schema.count, 42);
  assert.equal(JSON.stringify(version).includes('token'), false);
});
