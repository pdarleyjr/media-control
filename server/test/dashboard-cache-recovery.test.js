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

test('dashboard starts through a new cache-busting bootstrap with a visible failure state', () => {
  const html = fs.readFileSync(path.join(root, 'frontend', 'index.html'), 'utf8');
  const bootstrap = fs.readFileSync(path.join(root, 'frontend', 'js', 'dashboard-bootstrap-v2.js'), 'utf8');

  assert.match(html, /src="\/js\/dashboard-bootstrap-v2\.js"/);
  assert.doesNotMatch(html, /type="module" src="\/js\/app\.js"/);
  assert.match(bootstrap, /import\('\/js\/app\.js\?v=dashboard-bootstrap-v2'\)/);
  assert.match(bootstrap, /Media Control could not start/);
});

test('startup telemetry uses a filter-safe runtime asset path', () => {
  const app = fs.readFileSync(path.join(root, 'frontend', 'js', 'app.js'), 'utf8');
  const socket = fs.readFileSync(path.join(root, 'frontend', 'js', 'socket.js'), 'utf8');
  const send = fs.readFileSync(path.join(root, 'frontend', 'js', 'views', 'media-control', 'send.js'), 'utf8');

  for (const source of [app, socket, send]) {
    assert.match(source, /ui-runtime-v1\.js/);
    assert.doesNotMatch(source, /performance-metrics\.js/);
    assert.doesNotMatch(source, /runtime-metrics/);
  }
});
