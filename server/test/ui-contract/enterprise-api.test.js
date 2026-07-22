const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

// enterprise-api.js is now load-safe in node (lazy api import). Load directly.
// Each test that needs a specific MOCK_ONLY state uses a unique URI fragment so
// Node's ESM cache treats it as a fresh module evaluation. The MOCK_ONLY
// constant is evaluated at import time — the flag must be set BEFORE import.
const API_SRC = fs.readFileSync(path.join(__dirname, '../../../frontend/js/state/enterprise-api.js'), 'utf8');
const baseUri = `data:text/javascript;base64,${Buffer.from(API_SRC).toString('base64')}`;
let _uriSeq = 0;
function freshUri() { return `${baseUri}#t${++_uriSeq}`; }

test('layout catalog contains all required operator-facing layouts', async () => {
  const m = await import(freshUri());
  const keys = m.enterpriseApi.layouts.catalog.map((c) => c.key);
  const required = ['single', 'mirror', 'span-two', 'span-three', 'span-five', 'two-plus-one', 'independent', 'content-fullscreen', 'content-with-camera-pip', 'camera-fullscreen', 'camera-with-content-pip', 'side-by-side', 'custom-saved', 'clear', 'restore-previous'];
  for (const k of required) assert.ok(keys.includes(k), `missing layout ${k}`);
});

test('layout availability disables layouts needing more displays with a reason', async () => {
  const m = await import(freshUri());
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
  try {
    const m = await import(freshUri());
    const all = await m.enterpriseApi.content.list({});
    assert.ok(all.length > 0);
    const mine = await m.enterpriseApi.content.list({ mine: true });
    assert.ok(mine.every((i) => i.owner === 'me'));
    assert.equal(mine.length, 1);
  } finally { delete globalThis.__MC_ENTERPRISE_MOCK_ONLY; }
});

test('mock screen-share diagnostics flag a degraded fallback', async () => {
  globalThis.__MC_ENTERPRISE_MOCK_ONLY = true;
  try {
    const m = await import(freshUri());
    const diag = m.enterpriseApi.screenShare.diagnostics(null);
    assert.equal(diag.degraded, true);
    assert.ok(diag.degradedReasons.includes('no_audio'));
  } finally { delete globalThis.__MC_ENTERPRISE_MOCK_ONLY; }
});

test('privacy adapters resolve in mock mode', async () => {
  globalThis.__MC_ENTERPRISE_MOCK_ONLY = true;
  try {
    const m = await import(freshUri());
    const r = await m.enterpriseApi.privacy.requestOrganizationPublication('c1');
    assert.equal(r.status, 'requested');
    const v = await m.enterpriseApi.privacy.setVisibility('c1', 'workspace_shared');
    assert.equal(v.visibility, 'workspace_shared');
  } finally { delete globalThis.__MC_ENTERPRISE_MOCK_ONLY; }
});

// ---------------------------------------------------------------------------
// Production-safety tests (task §8): prove production mode NEVER falls back to
// mocks or fake success. A missing/failing backend contract must throw an
// explicit error with a code — not return mock data or { ok: true }.
// ---------------------------------------------------------------------------

test('production: rooms.list throws ROOMS_CATALOG_UNAVAILABLE (no mock fallback)', async () => {
  assert.equal(globalThis.__MC_ENTERPRISE_MOCK_ONLY, undefined);
  const m = await import(freshUri());
  await assert.rejects(
    () => m.enterpriseApi.rooms.list(),
    (err) => err.code === 'ROOMS_CATALOG_UNAVAILABLE',
  );
});

test('production: privacy.requestOrganizationPublication throws (no fake success)', async () => {
  assert.equal(globalThis.__MC_ENTERPRISE_MOCK_ONLY, undefined);
  const m = await import(freshUri());
  // Must reject — never resolve with { ok: true, status: 'requested' }
  await assert.rejects(() => m.enterpriseApi.privacy.requestOrganizationPublication('c1'));
});

test('production: privacy.setVisibility throws (no fake success)', async () => {
  assert.equal(globalThis.__MC_ENTERPRISE_MOCK_ONLY, undefined);
  const m = await import(freshUri());
  // Must reject — never resolve with { ok: true, visibility }
  await assert.rejects(() => m.enterpriseApi.privacy.setVisibility('c1', 'workspace_shared'));
});

test('production: screenShare.diagnostics throws without engine (no mock fallback)', async () => {
  assert.equal(globalThis.__MC_ENTERPRISE_MOCK_ONLY, undefined);
  const m = await import(freshUri());
  assert.throws(
    () => m.enterpriseApi.screenShare.diagnostics(null),
    (err) => err.code === 'SCREENSHARE_DIAGNOSTICS_UNAVAILABLE',
  );
});

test('production: content.list throws on real API failure (no mock fallback)', async () => {
  assert.equal(globalThis.__MC_ENTERPRISE_MOCK_ONLY, undefined);
  const m = await import(freshUri());
  await assert.rejects(
    () => m.enterpriseApi.content.list({}),
    // Import of ../api.js fails in the test env — that's a real failure,
    // and it must propagate, not return MOCK_CONTENT_FIXTURE.
    () => true,
  );
});
