const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '../..');
const source = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');

test('Media Library shows read-only preflight before every direct content send', () => {
  const api = source('frontend/js/api.js');
  const library = source('frontend/js/views/content-library.js');
  assert.match(api, /broadcastPreflight:/);
  assert.match(library, /async function showBroadcastPreflight/);
  assert.match(library, /api\.broadcastPreflight/);
  assert.match(library, /expected_target_count/);
  assert.match(library, /layout_revisions/);
  assert.match(library, /estimated_cold_transfer_bytes/);
  assert.match(library, /showBroadcastPreflight\(content,\s*route\)/);
});

test('temporary send-when-ready state warns that the tab must remain open', () => {
  const library = source('frontend/js/views/content-library.js');
  const english = source('frontend/js/i18n/en.js');
  assert.match(library, /content\.auto_send_temporary_warning/);
  assert.match(english, /'content\.auto_send_temporary_warning':/);
});

test('Media Library exposes one-item and bulk Prepare for class actions with truthful P3 state', () => {
  const api = source('frontend/js/api.js');
  const library = source('frontend/js/views/content-library.js');
  const socket = source('frontend/js/socket.js');
  assert.match(api, /prepareContentForClass:/);
  assert.match(api, /getClassroomPreparation:/);
  assert.match(library, /data-prepare-content/);
  assert.match(library, /data-bulk-prepare/);
  assert.match(library, /classroomPreparationById/);
  assert.match(library, /cache_hit_observed/);
  assert.match(library, /content\.classroom_cache_hit_pending/);
  assert.match(socket, /dashboard:content-preparation/);
  assert.match(socket, /emit\('content-preparation'/);
});
