const assert = require('assert');
const test = require('node:test');

const {
  DEFAULT_DPI,
  clampPage,
  createRenderScheduler,
  isDocumentMime,
  parsePdfInfo,
  pageCacheBasename,
} = require('../lib/doc-render');

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

test('document rendering defaults to a 1080-line-safe DPI', () => {
  assert.equal(DEFAULT_DPI, 144);
});

test('isDocumentMime accepts PDF and Office/ODF documents only', () => {
  assert.equal(isDocumentMime('application/pdf'), true);
  assert.equal(isDocumentMime('application/vnd.ms-powerpoint'), true);
  assert.equal(isDocumentMime('application/vnd.openxmlformats-officedocument.presentationml.presentation'), true);
  assert.equal(isDocumentMime('application/vnd.oasis.opendocument.presentation'), true);
  assert.equal(isDocumentMime('image/png'), false);
  assert.equal(isDocumentMime('video/mp4'), false);
  assert.equal(isDocumentMime('text/html'), false);
});

test('parsePdfInfo extracts page count defensively', () => {
  assert.equal(parsePdfInfo('Title: Demo\nPages: 16\nPage size: 960 x 540 pts'), 16);
  assert.equal(parsePdfInfo('Pages: 1'), 1);
  assert.equal(parsePdfInfo('Title: missing pages'), 1);
  assert.equal(parsePdfInfo('Pages: nope'), 1);
});

test('clampPage keeps document navigation inside bounds', () => {
  assert.equal(clampPage(1, 10), 1);
  assert.equal(clampPage(99, 10), 10);
  assert.equal(clampPage(0, 10), 1);
  assert.equal(clampPage(-4, 10), 1);
  assert.equal(clampPage('3', 10), 3);
  assert.equal(clampPage('bad', 10), 1);
});

test('pageCacheBasename is deterministic and path-safe', () => {
  assert.equal(
    pageCacheBasename('abc-123', 1700000000123.4, 2, 216),
    'docpage_abc-123_1700000000123_216_2.png'
  );
  assert.equal(
    pageCacheBasename('../bad id', 1, 1, 216),
    'docpage____bad_id_1_216_1.png'
  );
});

test('render scheduler bounds pdftoppm work and prioritizes interactive pages over queued prefetch', async () => {
  const scheduler = createRenderScheduler(1);
  const first = deferred();
  const order = [];

  const active = scheduler.run(async () => {
    order.push('active');
    await first.promise;
  }, { priority: 'interactive' });
  const speculative = scheduler.run(async () => { order.push('prefetch'); }, { priority: 'prefetch' });
  const interactive = scheduler.run(async () => { order.push('interactive'); }, { priority: 'interactive' });

  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(order, ['active']);
  assert.equal(scheduler.activeCount(), 1);
  assert.equal(scheduler.pendingCount(), 2);

  first.resolve();
  await Promise.all([active, speculative, interactive]);
  assert.deepEqual(order, ['active', 'interactive', 'prefetch']);
  assert.equal(scheduler.activeCount(), 0);
  assert.equal(scheduler.pendingCount(), 0);
});

test('render scheduler never exceeds its configured concurrency', async () => {
  const scheduler = createRenderScheduler(2);
  const gates = [deferred(), deferred(), deferred(), deferred()];
  let active = 0;
  let maxActive = 0;
  const jobs = gates.map((gate) => scheduler.run(async () => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    await gate.promise;
    active -= 1;
  }));

  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(maxActive, 2);
  gates[0].resolve();
  gates[1].resolve();
  await new Promise((resolve) => setImmediate(resolve));
  gates[2].resolve();
  gates[3].resolve();
  await Promise.all(jobs);
  assert.equal(maxActive, 2);
});
