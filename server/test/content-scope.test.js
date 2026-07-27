const { test } = require('node:test');
const assert = require('node:assert/strict');
const { ownedContentScope, libraryContentScope } = require('../lib/content-scope');
test('generic scope remains compatible with tables that have no access_level', () => {
  const s = ownedContentScope('ws1', 'u1');
  assert.match(s.clause, /workspace_id = \? AND user_id = \?/);
  assert.doesNotMatch(s.clause, /access_level/);
  assert.deepEqual(s.params, ['ws1', 'u1']);
});
test('scopes private content to owner while exposing workspace, organization, and platform visibility', () => {
  const s = libraryContentScope('ws1', 'u1');
  assert.match(s.clause, /workspace_id = \?/);
  assert.match(s.clause, /user_id = \?/);
  assert.match(s.clause, /access_level IN \('workspace','workspace_shared'\)/);
  assert.match(s.clause, /access_level IN \('organization','organization_shared'\)/);
  assert.match(s.clause, /organization_id/);
  assert.match(s.clause, /workspace_id IS NULL/);
  assert.deepEqual(s.params, ['ws1', 'u1', 'ws1']);
});
