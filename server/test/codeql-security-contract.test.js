'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '../..');
const source = relativePath => fs.readFileSync(path.join(ROOT, relativePath), 'utf8');

test('browser API requests are constrained to same-origin API paths', () => {
  const api = source('frontend/js/api.js');
  assert.match(api, /function normalizeApiPath/);
  assert.match(api, /candidate\.origin !== window\.location\.origin/);
  assert.match(api, /candidate\.pathname\.startsWith\(`\$\{API_BASE\}\/`\)/);
  assert.match(api, /fetch\(normalizeApiPath\(url\)/);
});

test('database and filesystem resource routes use the standard rate limiter', () => {
  const server = source('server/server.js');
  assert.match(server, /require\('express-rate-limit'\)/);
  for (const route of [
    '/api/content',
    '/api/captions',
    '/api/files',
    '/api/classroom-preparation',
    '/api/media-observability',
    '/api/live-sources',
    '/api/devices',
    '/api/displays',
    '/api/downloads',
    '/api/broadcast',
  ]) {
    assert.ok(
      server.includes(`app.use('${route}', rateLimit(rateLimitOptions(`),
      `${route} must use the standard rate limiter`,
    );
  }
});

test('public presentation player resources are bounded before database or filesystem work', () => {
  const server = source('server/server.js');
  assert.match(server, /app\.get\('\/player\/deck\/:id',\s*rateLimit\(rateLimitOptions\(/);
  assert.match(server, /app\.get\('\/player\/asset\/:id',\s*rateLimit\(rateLimitOptions\(/);
});

test('authenticated screenshot reads are rate limited before authorization and resource work', () => {
  const server = source('server/server.js');
  assert.match(
    server,
    /app\.get\('\/api\/devices\/:id\/screenshot',\s*rateLimit\(rateLimitOptions\(60000,\s*600\)\)/,
  );
});

test('optional authentication parses only the fixed session-cookie name', () => {
  const auth = source('server/middleware/auth.js');
  assert.doesNotMatch(auth, /acc\[key\]\s*=/);
  assert.match(auth, /key\s*===\s*'mc_token'/);
});

test('video-wall requests use the constrained central API client', () => {
  const wallView = source('frontend/js/views/video-wall.js');
  assert.doesNotMatch(wallView, /const API\s*=\s*async/);
  assert.match(wallView, /api\.getWall\(wallId\)/);
});

test('caption tracks accept only canonical same-origin sidecar URLs', () => {
  const player = source('server/player/index.html');
  assert.match(player, /function resolveCaptionTrackUrl/);
  assert.match(player, /candidate\.origin !== base\.origin/);
  assert.match(player, /\/api\\\/captions\\\/\[A-Za-z0-9_-\]\{1,160\}\\\/file/);
});
