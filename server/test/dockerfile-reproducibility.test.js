const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const dockerfile = fs.readFileSync(path.join(__dirname, '..', '..', 'Dockerfile'), 'utf8');
const workflow = fs.readFileSync(
  path.join(__dirname, '..', '..', '.github', 'workflows', 'release-gate.yml'),
  'utf8',
);
const rollbackRunbook = fs.readFileSync(
  path.join(__dirname, '..', '..', 'docs', 'MBFD_MEDIA_CONTROL_ROLLBACK.md'),
  'utf8',
);

test('production image installs the exact lockfile dependency graph', () => {
  assert.match(dockerfile, /RUN npm ci --omit=dev --no-audit --no-fund/);
  assert.doesNotMatch(dockerfile, /RUN npm install\b/);
});

test('every Node base stage is pinned to one immutable OCI digest', () => {
  const stages = [...dockerfile.matchAll(/^FROM node:22-alpine@sha256:([a-f0-9]{64})(?: AS \w+)?\r?$/gm)];
  assert.equal(stages.length, 2);
  assert.equal(stages[0][1], stages[1][1]);
});

test('production image embeds build provenance instead of trusting runtime environment', () => {
  assert.match(dockerfile, /build-provenance\.json/);
  assert.match(dockerfile, /org\.opencontainers\.image\.revision=\$GIT_COMMIT/);
  assert.match(dockerfile, /org\.opencontainers\.image\.created=\$BUILD_TIMESTAMP/);
  assert.doesNotMatch(dockerfile, /ENV GIT_COMMIT=/);
  assert.doesNotMatch(dockerfile, /ENV GIT_TREE=/);
  assert.doesNotMatch(dockerfile, /ENV BUILD_ID=/);
  assert.doesNotMatch(dockerfile, /ENV IMAGE_TAG=/);
  assert.match(dockerfile, /ENV REQUIRE_EMBEDDED_PROVENANCE=true/);
});

test('release gate runs the image and verifies exact commit provenance', () => {
  assert.match(workflow, /docker run/);
  assert.match(workflow, /api\/system\/version/);
  assert.match(workflow, /GIT_COMMIT/);
  assert.match(workflow, /docker image inspect/);
  assert.match(workflow, /upload-artifact@/);
  assert.match(workflow, /image-provenance/);
});

test('production build and rollback commands provide every required provenance argument', () => {
  const requiredArgs = [
    'GIT_COMMIT',
    'GIT_TREE',
    'GIT_BRANCH',
    'BUILD_TIMESTAMP',
    'BUILD_ID',
    'IMAGE_TAG',
  ];

  for (const arg of requiredArgs) {
    const occurrences = rollbackRunbook.match(new RegExp(`--build-arg ${arg}=`, 'g')) || [];
    assert.ok(occurrences.length >= 2, `${arg} must be set by deploy and rollback commands`);
  }
});
