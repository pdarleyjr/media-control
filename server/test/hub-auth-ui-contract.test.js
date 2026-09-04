'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = (relative) => fs.readFileSync(path.join(__dirname, '..', '..', relative), 'utf8');

test('Hub-enabled login presents Hub as primary and local auth as Guest Access', () => {
  const source = read('frontend/js/views/login.js');
  assert.match(source, /Continue with MBFD Hub/);
  assert.match(source, /config\.localMode === 'guest_only'/);
  assert.match(source, /Guest Access/);
  assert.match(source, /guestOnly \? 'btn btn-secondary'/);
});
test('account-link page posts only existing account proof and redirects through secure session completion', () => {
  const source = read('frontend/js/hub-account-link.js');
  assert.match(source, /identifier:\s*identifier\.value\.trim\(\)/);
  assert.match(source, /password:\s*password\.value/);
  assert.doesNotMatch(source, /subject|hub_user|role|provider/i);
  assert.match(source, /credentials:\s*'same-origin'/);
  assert.match(source, /\/api\/auth\/hub\/complete/);
});

test('admin user management shows safe link status and supports controlled pre-provisioning', () => {
  const settings = read('frontend/js/views/settings.js');
  const api = read('frontend/js/api.js');
  assert.match(settings, /Hub-linked employee/);
  assert.match(settings, /Unlinked employee/);
  assert.match(settings, /Local guest/);
  assert.match(settings, /Provision employee account/);
  assert.match(settings, /api\.provisionUser/);
  assert.doesNotMatch(settings, /canonical_subject|hub-user:/);
  assert.match(api, /provisionUser:\s*\(data\)\s*=>\s*request\('\/auth\/users'/);
});
