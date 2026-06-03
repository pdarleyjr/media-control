const { test } = require('node:test');
const assert = require('node:assert/strict');
const { deckPlayerUrl } = require('../lib/deck-player-url');

// The canonical convention: a presentation_id resolves to the SAME deck-player
// remote_url the frontend broadcasts — `${origin}/player/deck/${id}` (see
// frontend/js/views/presentations.js + broadcast-center.js, served by
// server.js GET /player/deck/:id).
test('maps a presentation id to the /player/deck/:id remote_url shape', () => {
  assert.equal(
    deckPlayerUrl('https://media.mbfdhub.com', 'abc-123'),
    'https://media.mbfdhub.com/player/deck/abc-123'
  );
});

test('matches the frontend convention exactly for a real UUID', () => {
  const id = '550e8400-e29b-41d4-a716-446655440000';
  const base = 'http://localhost:3000';
  // Mirror the frontend: `${location.origin}/player/deck/${id}`.
  assert.equal(deckPlayerUrl(base, id), `${base}/player/deck/${id}`);
});

test('tolerates a trailing slash on the base origin', () => {
  assert.equal(
    deckPlayerUrl('https://media.mbfdhub.com/', 'deck1'),
    'https://media.mbfdhub.com/player/deck/deck1'
  );
});

test('collapses multiple trailing slashes on the base origin', () => {
  assert.equal(
    deckPlayerUrl('https://media.mbfdhub.com///', 'deck1'),
    'https://media.mbfdhub.com/player/deck/deck1'
  );
});

test('URL-encodes the presentation id (matches encodeURIComponent usage)', () => {
  assert.equal(
    deckPlayerUrl('https://x.test', 'a b/c?d'),
    'https://x.test/player/deck/a%20b%2Fc%3Fd'
  );
});

test('produces a parseable, same-origin URL with the expected pathname', () => {
  const url = new URL(deckPlayerUrl('https://media.mbfdhub.com', 'xyz'));
  assert.equal(url.origin, 'https://media.mbfdhub.com');
  assert.equal(url.pathname, '/player/deck/xyz');
});
