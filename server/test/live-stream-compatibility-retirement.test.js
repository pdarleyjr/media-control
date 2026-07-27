'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  REMOVAL_VERSION,
  SUNSET_HTTP_DATE,
  markLegacyLiveCompatibility,
} = require('../lib/live-stream-compatibility');

test('legacy livestream compatibility responses identify deprecation and bounded removal', () => {
  const headers = new Map();
  const res = {
    setHeader(name, value) {
      headers.set(String(name).toLowerCase(), String(value));
    },
  };

  markLegacyLiveCompatibility(res);

  assert.equal(headers.get('deprecation'), 'true');
  assert.equal(headers.get('sunset'), SUNSET_HTTP_DATE);
  assert.equal(headers.get('x-mbfd-removal-version'), REMOVAL_VERSION);
  assert.match(headers.get('link'), /rel="deprecation"/);
  assert.match(headers.get('warning'), /^299 /);
});

test('every retained compatibility route is versioned, deprecated, and audited', () => {
  const route = fs.readFileSync(path.join(__dirname, '..', 'routes', 'live-stream.js'), 'utf8');
  for (const signature of [
    "router.post('/prepare'",
    "router.post('/production-plan'",
    "router.get('/production-plan'",
  ]) {
    const start = route.indexOf(signature);
    assert.ok(start >= 0, `${signature} must remain only as a bounded compatibility route`);
    const block = route.slice(start, start + 5000);
    assert.match(block, /markLegacyLiveCompatibility\(res\)/);
    assert.match(block, /logLiveStreamAction/);
  }
  assert.match(route, /Legacy livestream compatibility removal target/);
});

test('active frontend exposes no Prepare Live or production-plan client surface', () => {
  const repoRoot = path.join(__dirname, '..', '..');
  const api = fs.readFileSync(path.join(repoRoot, 'frontend', 'js', 'api.js'), 'utf8');
  assert.doesNotMatch(api, /live-stream\/prepare|live-stream\/production-plan/);
  assert.equal(
    fs.existsSync(path.join(repoRoot, 'frontend', 'js', 'views', 'media-control', 'prepare-live-production.js')),
    false,
  );
});

test('compatibility policy documents no alternate publisher and a concrete removal target', () => {
  const policy = fs.readFileSync(
    path.join(__dirname, '..', '..', 'docs', 'live-stream-compatibility.md'),
    'utf8',
  );
  assert.match(policy, new RegExp(REMOVAL_VERSION.replaceAll('.', '\\.')));
  assert.match(policy, /September 30, 2026/);
  assert.match(policy, /cannot select or start an alternative publisher/i);
  assert.match(policy, /active instructor UI does not call/i);
});
