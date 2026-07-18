const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..', '..');

test('dashboard shell clears stale browser caches without clearing login storage', () => {
  const server = fs.readFileSync(path.join(root, 'server', 'server.js'), 'utf8');
  const route = server.slice(server.indexOf("app.get('/app'"), server.indexOf('// Serve frontend static files'));

  assert.match(route, /Cache-Control', 'no-store'/);
  assert.match(route, /Clear-Site-Data', '"cache"'/);
  assert.doesNotMatch(route, /"storage"/);
});

test('dashboard service worker activates without a fragile precache batch', () => {
  const worker = fs.readFileSync(path.join(root, 'frontend', 'sw-admin.js'), 'utf8');

  assert.match(worker, /rd-admin-v3/);
  assert.match(worker, /self\.skipWaiting\(\)/);
  assert.match(worker, /e\.request\.method !== 'GET'/);
  assert.doesNotMatch(worker, /addAll\(/);
});
