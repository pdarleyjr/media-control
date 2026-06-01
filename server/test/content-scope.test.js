const { test } = require('node:test');
const assert = require('node:assert/strict');
const { ownedContentScope } = require('../lib/content-scope');
test('scopes to workspace+user, keeps NULL templates', () => {
  const s = ownedContentScope('ws1', 'u1');
  assert.match(s.clause, /workspace_id = \? AND user_id = \?/);
  assert.match(s.clause, /workspace_id IS NULL/);
  assert.deepEqual(s.params, ['ws1', 'u1']);
});
