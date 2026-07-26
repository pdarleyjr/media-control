const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

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

test('embedded build provenance wins over mutable production environment overrides', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'media-control-provenance-'));
  const provenancePath = path.join(dir, 'build-provenance.json');
  fs.writeFileSync(provenancePath, JSON.stringify({
    git_commit: 'immutable-commit',
    git_tree: 'immutable-tree',
    branch: 'main',
    build_id: 'immutable-build',
    build_timestamp: '2026-07-26T12:00:00Z',
    image_tag: 'media-control:immutable-commit',
  }));

  try {
    const version = buildSystemVersion({
      provenancePath,
      env: {
        NODE_ENV: 'production',
        GIT_COMMIT: 'spoofed-commit',
        GIT_TREE: 'spoofed-tree',
        GIT_BRANCH: 'spoofed-branch',
        BUILD_ID: 'spoofed-build',
        BUILD_TIMESTAMP: '2099-01-01T00:00:00Z',
        IMAGE_TAG: 'spoofed-tag',
        IMAGE_DIGEST: 'sha256:spoofed',
      },
    });

    assert.equal(version.git_commit, 'immutable-commit');
    assert.equal(version.git_tree, 'immutable-tree');
    assert.equal(version.branch, 'main');
    assert.equal(version.build_id, 'immutable-build');
    assert.equal(version.build_timestamp, '2026-07-26T12:00:00Z');
    assert.equal(version.image_tag, 'media-control:immutable-commit');
    assert.equal(version.image_digest, null);
    assert.equal(version.provenance.mode, 'embedded');
    assert.equal(version.provenance.mutable_environment_ignored, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('production version fails closed when embedded provenance is absent', () => {
  assert.throws(
    () => buildSystemVersion({
      provenancePath: path.join(os.tmpdir(), 'missing-media-control-provenance.json'),
      env: {
        NODE_ENV: 'production',
        REQUIRE_EMBEDDED_PROVENANCE: 'true',
        GIT_COMMIT: 'mutable-only',
      },
    }),
    /embedded build provenance/i,
  );
});

test('supported bare-metal production reports mutable provenance without requiring an image file', () => {
  const version = buildSystemVersion({
    provenancePath: path.join(os.tmpdir(), 'missing-bare-metal-provenance.json'),
    env: {
      NODE_ENV: 'production',
      GIT_COMMIT: 'bare-metal-commit',
      GIT_TREE: 'bare-metal-tree',
      GIT_BRANCH: 'main',
      BUILD_ID: 'bare-metal-build',
      BUILD_TIMESTAMP: '2026-07-26T12:00:00Z',
      IMAGE_TAG: 'bare-metal',
    },
  });

  assert.equal(version.git_commit, 'bare-metal-commit');
  assert.equal(version.provenance.mode, 'development');
  assert.equal(version.provenance.mutable_environment_ignored, false);
});
