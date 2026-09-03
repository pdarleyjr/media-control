'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('the exhaustive release gate independently runs the dedicated player audio-policy suite', () => {
  const root = path.join(__dirname, '..', '..');
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'server', 'package.json'), 'utf8'));
  const workflow = fs.readFileSync(path.join(root, '.github', 'workflows', 'release-gate.yml'), 'utf8');

  assert.equal(pkg.scripts['test:player-audio'], 'node e2e/real-app/run-playwright-config.js playwright.player-audio.config.js');
  assert.match(workflow, /suite: player-audio-policy/);
  assert.match(workflow, /script: test:player-audio/);
  assert.match(workflow, /browsers: chromium/);
});
