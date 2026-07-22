const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

// enterprise-api.js is now load-safe in node (lazy api import). Load directly.
const API_SRC = fs.readFileSync(path.join(__dirname, '../../../frontend/js/state/enterprise-api.js'), 'utf8');
const uri = `data:text/javascript;base64,${Buffer.from(API_SRC).toString('base64')}`;

test('layout catalog contains all required operator-facing layouts', async () => {
  const m = await import(uri);
  const keys = m.enterpriseApi.layouts.catalog.map((c) => c.key);
  const required = ['single', 'mirror', 'span-two', 'span-three', 'span-five', 'two-plus-one', 'independent', 'content-fullscreen', 'content-with-camera-pip', 'camera-fullscreen', 'camera-with-content-pip', 'side-by-side', 'custom-saved', 'clear', 'restore-previous'];
  for (const k of required) assert.ok(keys.includes(k), `missing layout ${k}`);
});

test('layout availability disables layouts needing more displays with a reason', async () => {
  const m = await import(uri);
  const avail = m.enterpriseApi.layouts.availability(1);
  const spanTwo = avail.find((c) => c.key === 'span-two');
  assert.equal(spanTwo.available, false);
  assert.equal(spanTwo.unavailableReason, 'needs_more_displays');
  const single = avail.find((c) => c.key === 'single');
  assert.equal(single.available, true);
  assert.equal(single.unavailableReason, null);
});

test('mock content fixture returns items and honors mine filter (no cross-user private leak)', async () => {
  globalThis.__MC_ENTERPRISE_MOCK_ONLY = true;
  const m = await import(uri);
  const all = await m.enterpriseApi.content.list({});
  assert.ok(all.length > 0);
  const mine = await m.enterpriseApi.content.list({ mine: true });
  assert.ok(mine.every((i) => i.owner === 'me'));
  assert.equal(mine.length, 1);
  delete globalThis.__MC_ENTERPRISE_MOCK_ONLY;
});

test('mock screen-share diagnostics flag a degraded fallback', async () => {
  globalThis.__MC_ENTERPRISE_MOCK_ONLY = true;
  const m = await import(uri);
  const diag = m.enterpriseApi.screenShare.diagnostics(null);
  assert.equal(diag.degraded, true);
  assert.ok(diag.degradedReasons.includes('no_audio'));
  delete globalThis.__MC_ENTERPRISE_MOCK_ONLY;
});

test('privacy adapters resolve in mock mode', async () => {
  globalThis.__MC_ENTERPRISE_MOCK_ONLY = true;
  const m = await import(uri);
  const r = await m.enterpriseApi.privacy.requestOrganizationPublication('c1');
  assert.equal(r.status, 'requested');
  const v = await m.enterpriseApi.privacy.setVisibility('c1', 'workspace_shared');
  assert.equal(v.visibility, 'workspace_shared');
  delete globalThis.__MC_ENTERPRISE_MOCK_ONLY;
});
