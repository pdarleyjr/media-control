const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const root = path.join(__dirname, '..', '..');
const servicePath = path.join(root, 'frontend', 'js', 'services', 'download-status.js');
const viewPath = path.join(root, 'frontend', 'js', 'views', 'downloads.js');

async function loadService() {
  return import(pathToFileURL(servicePath).href);
}

test('download status reads return the authoritative job list', async () => {
  const { readDownloadJobs } = await loadService();
  const jobs = [{ id: 'job-1', status: 'done', content_id: 'content-1' }];
  let receivedSignal = null;

  const result = await readDownloadJobs(({ signal }) => {
    receivedSignal = signal;
    return Promise.resolve(jobs);
  }, { timeoutMs: 50 });

  assert.deepEqual(result, jobs);
  assert.equal(receivedSignal instanceof AbortSignal, true);
  assert.equal(receivedSignal.aborted, false);
});

test('download status reads abort a stalled request instead of hanging forever', async () => {
  const { readDownloadJobs } = await loadService();

  const stalledRead = ({ signal }) => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => {
      const error = new Error('aborted');
      error.name = 'AbortError';
      reject(error);
    }, { once: true });
  });

  await assert.rejects(
    readDownloadJobs(stalledRead, { timeoutMs: 5 }),
    (error) => error?.name === 'AbortError'
  );
});

test('download status reads normalize malformed API payloads', async () => {
  const { readDownloadJobs } = await loadService();
  assert.deepEqual(await readDownloadJobs(null), []);
  assert.deepEqual(await readDownloadJobs(() => Promise.resolve([])), []);
  assert.deepEqual(await readDownloadJobs(() => Promise.resolve([]), { timeoutMs: 0 }), []);
  assert.deepEqual(await readDownloadJobs(() => Promise.resolve(null), { timeoutMs: 50 }), []);
  assert.deepEqual(await readDownloadJobs(() => Promise.resolve({ status: 'done' }), { timeoutMs: 50 }), []);
});

test('downloads view retries without overlapping intervals and exposes stale refresh state', () => {
  const source = fs.readFileSync(viewPath, 'utf8');

  assert.match(source, /readDownloadJobs/);
  assert.match(source, /setTimeout\(/);
  assert.doesNotMatch(source, /setInterval\(/);
  assert.match(source, /dlRefreshState/);
  assert.match(source, /Status refresh delayed/);
  assert.match(source, /addEventListener\('online'/);
  assert.match(source, /removeEventListener\('online'/);
});
