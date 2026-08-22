'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const player = fs.readFileSync(path.join(__dirname, '..', 'player', 'deck.html'), 'utf8');
const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

test('v2 player consumes the server-compiled canonical registry plan and scales without reflow', () => {
  assert.match(server, /deckForPlayer\(db, req\.params\.id/);
  assert.match(server, /buildRenderPlan\(selected\.deck, \{ mode: 'production' \}\)/);
  assert.match(server, /window\.__deckRenderPlan/);
  assert.match(player, /deck\.version === 'mbfd-deck-v2'/);
  assert.match(player, /renderPlan\.profile\.canvas_px/);
  assert.match(player, /Math\.min\(window\.innerWidth\/canvas\.w,window\.innerHeight\/canvas\.h\)/);
  assert.match(player, /translate\(-50%,-50%\) scale/);
  assert.match(player, /\/player\/template-asset\//);
  assert.doesNotMatch(player, /seam-guide|safe-area-guide/);
});

test('v2 player keeps the absolute rapid transport and command-correlation state machine', () => {
  assert.match(player, /appliedCommandIds/);
  assert.match(player, /command_id/);
  assert.match(player, /go_to_slide/);
  assert.match(player, /if \(!paused\) togglePause\(\)/);
  assert.match(player, /if \(paused\) togglePause\(\)/);
  assert.doesNotMatch(player, /inFlight|controlsDisabled|disabled\s*=\s*true/);
});

test('deck player publishes content instance id and generation so stale slide commands bind to the loaded deck', () => {
  assert.match(player, /content_instance_id:\s*deck\.content_instance_id/);
  assert.match(player, /generation:\s*Number\.isFinite\(Number\(deck\.generation\)\)/);
});

test('auto-advance-on-media-end is bound to the originating slide and deck so a stale ended event cannot advance a replaced presentation', () => {
  assert.match(player, /auto_advance_on_media_end===true/);
  assert.match(player, /advanceFromIdx/);
  assert.match(player, /idx !== advanceFromIdx/);
  assert.match(player, /advanceDeckId/);
  // The generation the slide was rendered under must also be captured and
  // re-checked, so a late 'ended' from a navigated-away or replaced deck whose
  // generation advanced cannot advance the newly loaded presentation.
  assert.match(player, /advanceGen/);
  assert.match(player, /!== advanceGen/);
});
