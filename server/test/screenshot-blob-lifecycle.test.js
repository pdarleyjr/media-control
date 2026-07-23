import { afterEach, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';

let originalFetch;
let originalCreateObjectURL;
let originalRevokeObjectURL;
let originalLocalStorage;
let originalWindow;
let fetchCalls;
let created;
let revoked;
let getScreenshotBlobMetrics;
let revokeAllScreenshotObjectUrls;
let secureScreenshotUrl;

before(async () => {
  const priorLocalStorage = globalThis.localStorage;
  originalWindow = globalThis.window;
  globalThis.localStorage = { getItem: () => null };
  globalThis.window = {
    location: { pathname: '/command-center' },
    addEventListener: () => {},
  };
  ({
    getScreenshotBlobMetrics,
    revokeAllScreenshotObjectUrls,
    secureScreenshotUrl,
  } = await import('../../frontend/js/services/display-state.js'));
  if (priorLocalStorage === undefined) delete globalThis.localStorage;
  else globalThis.localStorage = priorLocalStorage;
  if (originalWindow === undefined) delete globalThis.window;
  else globalThis.window = originalWindow;
});

beforeEach(() => {
  revokeAllScreenshotObjectUrls();
  fetchCalls = [];
  created = [];
  revoked = [];
  originalFetch = globalThis.fetch;
  originalCreateObjectURL = globalThis.URL.createObjectURL;
  originalRevokeObjectURL = globalThis.URL.revokeObjectURL;
  originalLocalStorage = globalThis.localStorage;
  globalThis.localStorage = { getItem: () => 'test-session-token' };
  globalThis.URL.createObjectURL = () => {
    const value = `blob:test-${created.length + 1}`;
    created.push(value);
    return value;
  };
  globalThis.URL.revokeObjectURL = (value) => revoked.push(value);
  globalThis.fetch = async (url, options) => {
    fetchCalls.push({ url, options });
    return {
      ok: true,
      status: 200,
      blob: async () => ({ revision: String(url) }),
    };
  };
});

afterEach(() => {
  revokeAllScreenshotObjectUrls();
  globalThis.fetch = originalFetch;
  globalThis.URL.createObjectURL = originalCreateObjectURL;
  globalThis.URL.revokeObjectURL = originalRevokeObjectURL;
  if (originalLocalStorage === undefined) delete globalThis.localStorage;
  else globalThis.localStorage = originalLocalStorage;
});

test('a newer screenshot revision refetches, replaces, and revokes the old Blob URL', async () => {
  const first = await secureScreenshotUrl('/api/devices/front-center/screenshot?t=1');
  const second = await secureScreenshotUrl('/api/devices/front-center/screenshot?t=2');
  assert.equal(fetchCalls.length, 2);
  assert.notEqual(second, first);
  assert.deepEqual(revoked, [first]);
  assert.equal(getScreenshotBlobMetrics().cachedObjectUrls, 1);
});

test('concurrent fetches for the identical screenshot revision are deduplicated', async () => {
  let release;
  globalThis.fetch = async (url, options) => {
    fetchCalls.push({ url, options });
    await new Promise((resolve) => { release = resolve; });
    return {
      ok: true,
      status: 200,
      blob: async () => ({ revision: String(url) }),
    };
  };
  const first = secureScreenshotUrl('/api/devices/front-left/screenshot?t=7');
  const second = secureScreenshotUrl('/api/devices/front-left/screenshot?t=7');
  await Promise.resolve();
  assert.equal(fetchCalls.length, 1);
  release();
  assert.equal(await first, await second);
});

test('route teardown aborts fetches and revokes every cached Blob URL', async () => {
  await secureScreenshotUrl('/api/devices/side-left/screenshot?t=1');
  await secureScreenshotUrl('/api/devices/side-right/screenshot?t=1');
  revokeAllScreenshotObjectUrls();
  assert.equal(getScreenshotBlobMetrics().cachedObjectUrls, 0);
  assert.deepEqual(revoked.sort(), ['blob:test-1', 'blob:test-2']);
});
