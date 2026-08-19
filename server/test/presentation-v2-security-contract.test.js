'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function source(file) { return fs.readFileSync(path.join(__dirname, '..', file), 'utf8'); }

test('presentation broadcast enforces the same per-user ownership boundary as CRUD', () => {
  const broadcast = source('routes/broadcast.js');
  assert.match(broadcast, /SELECT id, workspace_id, user_id, deck_json FROM presentations/);
  assert.match(broadcast, /pres\.user_id !== req\.user\.id/);
  assert.match(broadcast, /You can only broadcast your own presentations/);
  assert.match(broadcast, /presentation_assets WHERE presentation_id/);
  assert.match(broadcast, /contentBroadcastReadiness/);
  assert.match(broadcast, /requestContentPrewarm/);
});

test('public presentation assets remain relationship-gated and MIME allowlisted', () => {
  const server = source('server.js');
  assert.match(server, /safePresentationMimes = new Set/);
  for (const mime of ['image/png', 'video/mp4', 'audio/mpeg']) assert.match(server, new RegExp(`['"]${mime.replace('/', '\\/')}['"]`));
  assert.match(server, /presentation_assets WHERE content_id = \? LIMIT 1/);
  assert.doesNotMatch(server, /c\.mime_type\.startsWith\(['"](?:image|video|audio)\//);
  assert.match(server, /X-Content-Type-Options', 'nosniff'/);
});

test('converter reuses durable media jobs and keeps Ollama server-side', () => {
  const route = source('routes/presentation-converter.js');
  const pipeline = source('lib/media-pipeline.js');
  const ai = source('services/ai.js');
  assert.match(route, /enqueuePresentationConversion/);
  assert.match(pipeline, /presentation_convert/);
  assert.match(pipeline, /MediaJobWorker/);
  assert.match(ai, /config\.ollamaBaseUrl/);
  assert.doesNotMatch(source('../frontend/js/api.js'), /11434|OLLAMA_BASE_URL/);
});
