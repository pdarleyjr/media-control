// Pure: build the public deck-player remote_url for a presentation. This is the
// SAME convention the frontend uses to broadcast a deck (presentations.js /
// broadcast-center.js both do `${location.origin}/player/deck/${id}`) and that
// server.js serves at GET /player/deck/:id. Centralizing it here lets the
// /api/broadcast route accept a `presentation_id` and resolve it server-side to
// the identical remote_url that "Present this deck" already pushes — so a deck
// flows through the exact same source/push path as a hand-typed remote_url.
//
// `base` is the public-facing origin (e.g. https://media.mbfdhub.com), trailing
// slash tolerated. `id` is the presentation UUID, which is URL-encoded to match
// the frontend's encodeURIComponent(...) usage.
function deckPlayerUrl(base, id) {
  const origin = String(base || '').replace(/\/+$/, '');
  return `${origin}/player/deck/${encodeURIComponent(id)}`;
}

module.exports = { deckPlayerUrl };
