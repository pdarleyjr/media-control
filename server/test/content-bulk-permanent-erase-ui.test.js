'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '../..');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');

function loadBulkEraseProgressHelper() {
  const source = read('frontend/js/views/content-library.js');
  const match = source.match(
    /function reconcileBulkEraseProgress\(selectedIds, attemptedIds, completedContentIds\)\s*\{[\s\S]*?\n\}/,
  );
  assert.ok(match, 'Media Library must define its bulk erase selection reconciliation helper');
  return Function(`return (${match[0]})`)();
}

test('structured bulk erase response fields survive the API client error boundary', async () => {
  const originalFetch = globalThis.fetch;
  const originalWindow = globalThis.window;
  const originalLocalStorage = globalThis.localStorage;
  const body = {
    code: 'ERASE_JOB_QUIESCENCE_REQUIRED',
    error: 'Permanent erase could not be completed safely.',
    completed_content_ids: ['alpha'],
    failed_content_id: 'bravo',
    impact: { blockers: [{ category: 'media_job' }] },
    result: { content_id: 'bravo', success: false },
  };

  globalThis.window = {
    location: {
      origin: 'https://media.example.test',
      hash: '#/content',
      reload() {},
    },
  };
  globalThis.localStorage = {
    getItem: () => 'test-token',
    removeItem() {},
  };
  globalThis.fetch = async () => ({
    ok: false,
    status: 409,
    statusText: 'Conflict',
    json: async () => body,
  });

  try {
    const source = read('frontend/js/api.js');
    const uri = `data:text/javascript;base64,${Buffer.from(source).toString('base64')}#bulk-erase-error`;
    const { api } = await import(uri);
    await assert.rejects(
      () => api.permanentlyEraseContentBulk(['alpha', 'bravo']),
      (error) => {
        assert.equal(error.status, 409);
        assert.equal(error.code, body.code);
        assert.deepEqual(error.completed_content_ids, ['alpha']);
        assert.equal(error.failed_content_id, 'bravo');
        assert.deepEqual(error.impact, body.impact);
        assert.deepEqual(error.result, body.result);
        assert.deepEqual(error.details, body);
        return true;
      },
    );
  } finally {
    globalThis.fetch = originalFetch;
    if (originalWindow === undefined) delete globalThis.window;
    else globalThis.window = originalWindow;
    if (originalLocalStorage === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = originalLocalStorage;
  }
});

test('all-success reconciliation removes every attempted ID without disturbing other selection', () => {
  const reconcile = loadBulkEraseProgressHelper();
  const selected = new Set(['alpha', 'bravo', 'outside']);

  const progress = reconcile(selected, ['alpha', 'bravo'], ['alpha', 'bravo']);

  assert.deepEqual(progress, {
    completedIds: ['alpha', 'bravo'],
    remainingIds: [],
  });
  assert.deepEqual([...selected], ['outside']);
});

test('first success then second quiescence leaves the failed and unattempted tail selected', () => {
  const reconcile = loadBulkEraseProgressHelper();
  const selected = new Set(['alpha', 'bravo', 'charlie']);

  const progress = reconcile(selected, ['alpha', 'bravo', 'charlie'], ['alpha']);

  assert.deepEqual(progress, {
    completedIds: ['alpha'],
    remainingIds: ['bravo', 'charlie'],
  });
  assert.deepEqual([...selected], ['bravo', 'charlie']);
});

test('first and second success then third failure leaves only the third ID selected', () => {
  const reconcile = loadBulkEraseProgressHelper();
  const selected = new Set(['alpha', 'bravo', 'charlie']);

  const progress = reconcile(selected, ['alpha', 'bravo', 'charlie'], ['alpha', 'bravo']);

  assert.deepEqual(progress, {
    completedIds: ['alpha', 'bravo'],
    remainingIds: ['charlie'],
  });
  assert.deepEqual([...selected], ['charlie']);
});

test('zero completed preserves the complete selection for a truthful retry', () => {
  const reconcile = loadBulkEraseProgressHelper();
  const selected = new Set(['alpha', 'bravo', 'charlie']);

  const progress = reconcile(selected, ['alpha', 'bravo', 'charlie'], []);

  assert.deepEqual(progress, {
    completedIds: [],
    remainingIds: ['alpha', 'bravo', 'charlie'],
  });
  assert.deepEqual([...selected], ['alpha', 'bravo', 'charlie']);
});

test('bulk erase UI contract reloads both views and never reports all-erased success on partial failure', () => {
  const source = read('frontend/js/views/content-library.js');
  const partialBranch = source.match(/if \(progress\.completedIds\.length\) \{[\s\S]*?\n\s*\}/)?.[0] || '';

  assert.match(source, /error\?\.completed_content_ids/);
  assert.match(source, /reconcileBulkEraseProgress\(state\.selectedIds, ids, completedContentIds\)/);
  assert.match(partialBranch, /loadLibrarySummary\(\)/);
  assert.match(partialBranch, /loadContent\(\{ preserveSelectedIds: true \}\)/);
  assert.match(source, /if \(!preserveSelectedIds\) state\.selectedIds = new Set/);
  assert.match(partialBranch, /showToast\([\s\S]*?'error'\)/);
  assert.doesNotMatch(partialBranch, /content\.toast\.bulk_erased[\s\S]*?'success'/);
});
