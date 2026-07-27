const assert = require('assert');
const fs = require('fs');
const path = require('path');
const test = require('node:test');

const api = fs.readFileSync(
  path.join(__dirname, '..', '..', 'frontend', 'js', 'api.js'),
  'utf8',
);

test('content writes reconcile ambiguous responses against authoritative state', () => {
  assert.match(api, /function contentMutationApplied\(current, desired = \{\}\)/);
  assert.match(api, /const current = await request\(`\/content\/\$\{id\}`\)/);
  assert.match(api, /if \(contentMutationApplied\(current, desired\)\) return current/);
  assert.match(api, /updateContent:[\s\S]*reconcileContentMutation/);
  assert.match(api, /archiveContent:[\s\S]*reconcileContentMutation/);
});

test('content write reconciliation never masks authorization failures', () => {
  assert.match(api, /error\?\.status === 401 \|\| error\?\.status === 403/);
  assert.match(api, /throw error/);
});
