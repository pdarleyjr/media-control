const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const dockerfile = fs.readFileSync(path.join(__dirname, '..', '..', 'Dockerfile'), 'utf8');

test('production image installs the exact lockfile dependency graph', () => {
  assert.match(dockerfile, /RUN npm ci --omit=dev --no-audit --no-fund/);
  assert.doesNotMatch(dockerfile, /RUN npm install\b/);
});

test('every Node base stage is pinned to one immutable OCI digest', () => {
  const stages = [...dockerfile.matchAll(/^FROM node:22-alpine@sha256:([a-f0-9]{64})(?: AS \w+)?\r?$/gm)];
  assert.equal(stages.length, 2);
  assert.equal(stages[0][1], stages[1][1]);
});
