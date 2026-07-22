const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const sourcePath = path.join(__dirname, '../../frontend/js/services/target-catalog-runtime.js');

async function loadFactory() {
  let source = fs.readFileSync(sourcePath, 'utf8')
    .replace(/^import .*;\r?\n/gm, '')
    .replace(/export function /g, 'function ')
    .replace(/const runtime =[\s\S]*$/m, '');
  source += '\nmodule.exports = { createTargetCatalogRuntime };';
  const module = { exports: {} };
  vm.runInNewContext(source, { module, exports: module.exports, setTimeout, clearTimeout, Error, TypeError, Promise });
  return module.exports.createTargetCatalogRuntime;
}

function fakeStore(initial = null) {
  let snapshot = initial;
  const listeners = new Set();
  return {
    getSnapshot: () => snapshot,
    subscribe(callback) {
      listeners.add(callback);
      return () => listeners.delete(callback);
    },
    publish(value) {
      snapshot = value;
      for (const listener of listeners) listener(snapshot);
    },
    listenerCount: () => listeners.size,
  };
}

test('returns the current authoritative catalog immediately and requests a background refresh', async () => {
  const createRuntime = await loadFactory();
  const store = fakeStore({ revision: 7 });
  let requests = 0;
  const runtime = createRuntime({
    roomStore: store,
    requestSnapshot: () => { requests += 1; },
    buildCatalog: (snapshot, options) => ({ revision: snapshot.revision, options }),
  });

  const result = await runtime.wait({ includeVirtualDisplays: false });
  assert.equal(result.revision, 7);
  assert.equal(result.options.includeVirtualDisplays, false);
  assert.equal(requests, 1);
  assert.equal(store.listenerCount(), 0);
});

test('waits for the first snapshot without leaking its subscription', async () => {
  const createRuntime = await loadFactory();
  const store = fakeStore();
  let requests = 0;
  const runtime = createRuntime({
    roomStore: store,
    requestSnapshot: () => { requests += 1; },
    buildCatalog: (snapshot) => ({ revision: snapshot.revision }),
  });

  const pending = runtime.wait({}, { timeoutMs: 100 });
  assert.equal(requests, 1);
  assert.equal(store.listenerCount(), 1);
  store.publish({ revision: 12 });
  assert.deepEqual(await pending, { revision: 12 });
  assert.equal(store.listenerCount(), 0);
});

test('requireFresh waits for a newer authoritative timestamp instead of returning cached topology', async () => {
  const createRuntime = await loadFactory();
  const store = fakeStore({ revision: 7, serverTimestamp: 100 });
  const requests = [];
  const runtime = createRuntime({
    roomStore: store,
    requestSnapshot: (options) => { requests.push(options); },
    buildCatalog: (snapshot) => ({ revision: snapshot.revision, serverTimestamp: snapshot.serverTimestamp }),
  });

  const pending = runtime.wait({}, { timeoutMs: 100, requireFresh: true });
  assert.equal(store.listenerCount(), 1);
  assert.equal(requests[0].force, true);
  store.publish({ revision: 7, serverTimestamp: 101 });
  assert.deepEqual(await pending, { revision: 7, serverTimestamp: 101 });
  assert.equal(store.listenerCount(), 0);
});

test('fails closed when live room topology cannot be obtained', async () => {
  const createRuntime = await loadFactory();
  const store = fakeStore();
  const runtime = createRuntime({ roomStore: store, buildCatalog: (snapshot) => snapshot });

  await assert.rejects(
    runtime.wait({}, { timeoutMs: 5 }),
    /Live room topology is unavailable/,
  );
  assert.equal(store.listenerCount(), 0);
});
