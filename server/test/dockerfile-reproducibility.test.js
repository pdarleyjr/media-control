const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const dockerfile = fs.readFileSync(path.join(__dirname, '..', '..', 'Dockerfile'), 'utf8');

test('production image installs the exact lockfile dependency graph', () => {
  assert.match(dockerfile, /RUN npm ci --omit=dev --no-audit --no-fund/);
  assert.doesNotMatch(dockerfile, /RUN npm install\b/);
});
