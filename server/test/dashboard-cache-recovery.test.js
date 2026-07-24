const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..', '..');

test('dashboard shell is no-store and does NOT emit Clear-Site-Data on every load', () => {
  const server = fs.readFileSync(path.join(root, 'server', 'server.js'), 'utf8');
  const route = server.slice(server.indexOf("app.get('/app'"), server.indexOf('// Serve frontend static files'));

  assert.match(route, /Cache-Control', 'no-store'/);
  // Clear-Site-Data must NOT be set on the routine /app load — it destroyed
  // service-worker/versioned-asset caching and forced re-downloads on every visit.
  assert.doesNotMatch(route, /setHeader\('Clear-Site-Data/);
  assert.doesNotMatch(route, /"storage"/);
});

test('controlled cache recovery is a POST (not GET), admin + same-origin + rate-limited + audited, and emits Clear-Site-Data', () => {
  const server = fs.readFileSync(path.join(root, 'server', 'server.js'), 'utf8');
  const route = server.slice(server.indexOf("app.post('/api/admin/cache-recovery'"), server.indexOf("app.use('/api/devices'"));
  // Must be a POST — a state-changing GET is prefetchable by browsers/scanners.
  assert.match(route, /app\.post\('\/api\/admin\/cache-recovery'/);
  assert.doesNotMatch(route, /app\.get\('\/api\/admin\/cache-recovery'/);
  // Authenticated + admin-gated so a normal instructor cannot trigger it.
  assert.match(route, /requireAuth, requireAdmin/);
  // Same-origin guard prevents cross-site (CSRF) requests.
  assert.match(route, /requireSameOrigin/);
  // Rate-limited so the endpoint cannot be hammered.
  assert.match(route, /rateLimit\(/);
  // Never cached — a stale recovery response must not be replayed.
  assert.match(route, /Cache-Control', 'no-store/);
  // It emits Clear-Site-Data: "cache" for a deliberate recovery only.
  assert.match(route, /Clear-Site-Data', '"cache"'/);
  // Security audit trail: actor + action + request ID.
  assert.match(route, /admin\.cache-recovery/);
  assert.match(route, /requestId/);
  // Idempotency: a retried request within the window is a no-op.
  assert.match(route, /idempotent/);
  // Only the cache datatype is cleared — login/preferences (storage) survive.
  assert.doesNotMatch(route, /"storage"/);
  assert.doesNotMatch(route, /"cookies"/);
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

// Automated cleanup assertion (task §5): the browser-console acceptance harness
// must not persist tokens or browser storage to disk. It must use a test JWT
// secret (never the production one), must not mint superadmin tokens, must not
// publish Playwright storageState files as artifacts, and must tear down its
// temp browser profile + DB after each run.
test('browser-console acceptance harness does not persist tokens or browser storage', () => {
  const spec = fs.readFileSync(path.join(root, 'server', 'e2e', 'real-app', 'browser-console.spec.js'), 'utf8');
  const cfg = fs.readFileSync(path.join(root, 'server', 'e2e', 'real-app', 'playwright.browser-console.config.js'), 'utf8');
  // No persistent storageState file (tokens must not be published as artifacts).
  assert.doesNotMatch(cfg, /storageState\s*:/);
  // Uses a dedicated test JWT secret, never the production secret.
  assert.match(spec, /JWT_SECRET\s*=\s*'/);
  assert.doesNotMatch(spec, /superadmin|platform_admin/);
  // Must register a test user via the API (not bypass the DB layer to mint).
  assert.match(spec, /api\/auth\/register/);
  // Must tear down: kill the server and remove the temp dir after the run.
  assert.match(spec, /afterAll/);
  assert.match(spec, /killServer|rmSync.*recursive/);
});
