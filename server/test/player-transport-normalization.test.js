const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

function readSnippet(filePath, startMarker, endMarker) {
  const html = fs.readFileSync(filePath, 'utf8');
  const start = html.indexOf(startMarker);
  assert.ok(start >= 0, `${startMarker} should exist in ${path.basename(filePath)}`);
  const end = html.indexOf(endMarker, start);
  assert.ok(end >= 0, `${endMarker} should exist in ${path.basename(filePath)}`);
  return html.slice(start, end);
}

test('player transport normalization unwraps nested payload wrappers', () => {
  const snippet = readSnippet(
    path.join(__dirname, '..', 'player', 'index.html'),
    'function normalizeTransportCommand(input) {',
    'function postTransportToFrames(command)'
  );

  assert.ok(snippet.includes('unwrapTransportPayload'), 'normalizeTransportCommand should unwrap nested transport payloads');
  assert.ok(snippet.includes('rawPayload.action'), 'normalizeTransportCommand should read raw payload actions');
  assert.ok(snippet.includes('rawPayload.command'), 'normalizeTransportCommand should read raw payload commands');
  assert.ok(snippet.includes('command.action'), 'normalizeTransportCommand should still allow direct actions');
  assert.ok(snippet.includes('command.type'), 'normalizeTransportCommand should still preserve the transport wrapper type');
});

test('player direct iframe transport handles go_to_slide targets', () => {
  const snippet = readSnippet(
    path.join(__dirname, '..', 'player', 'index.html'),
    'function tryDirectIframeTransport(command) {',
    'function doTransport(input)'
  );

  assert.ok(snippet.includes('go_to_slide'), 'tryDirectIframeTransport should recognize go_to_slide');
  assert.ok(snippet.includes('payload.page'), 'tryDirectIframeTransport should read slide targets from payload');
  assert.ok(
    snippet.indexOf('childWindow.handleAction') >= 0 &&
      snippet.indexOf('childWindow.handleAction') < snippet.indexOf('const pageImg = idoc.getElementById'),
    'tryDirectIframeTransport should use child handleAction state before DOM fallback'
  );
});

test('player restores persisted document slide state after reconnect before publishing stale state', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'player', 'index.html'), 'utf8');

  assert.ok(html.includes('function normalizeDisplayStateRestore(state)'), 'player should normalize server display_state restore payloads');
  assert.ok(html.includes('function childSlideStateReady(childState, restore)'), 'player should wait for child page metadata before restoring');
  assert.ok(html.includes('function tryApplyDisplayStateRestore(reason)'), 'player should apply restore through the child handleAction contract');
  assert.ok(html.includes("action: 'go_to_slide'"), 'restore should use canonical go_to_slide transport');
  assert.ok(html.includes('shouldHoldStateReportForRestore(state)'), 'player should suppress temporary page-1 reports while restore is pending');
  assert.ok(html.includes('publishPlayerState({ force: true })'), 'player should publish authoritative state after restore completes');
});

test('doc player transport normalization unwraps nested payload wrappers before go_to_slide', () => {
  const snippet = readSnippet(
    path.join(__dirname, '..', 'player', 'doc.html'),
    'function unwrapTransportPayload(payload) {',
    'function goToPage(value)'
  );

  assert.ok(snippet.includes('rawPayload.action || rawPayload.command || rawPayload.type'), 'doc normalizeAction should detect wrapper payloads');
  assert.ok(snippet.includes('unwrapTransportPayload(rawPayload)'), 'doc normalizeAction should flatten nested payloads');
  assert.ok(snippet.includes('input.type'), 'doc normalizeAction should still preserve the wrapper type as a fallback');
});

test('deck player transport normalization unwraps nested payload wrappers before go_to_slide', () => {
  const snippet = readSnippet(
    path.join(__dirname, '..', 'player', 'deck.html'),
    'function unwrapTransportPayload(payload) {',
    'function goToSlide(value)'
  );

  assert.ok(snippet.includes('rawPayload.action || rawPayload.command || rawPayload.type'), 'deck normalizeAction should detect wrapper payloads');
  assert.ok(snippet.includes('unwrapTransportPayload(rawPayload)'), 'deck normalizeAction should flatten nested payloads');
  assert.ok(snippet.includes('input.type'), 'deck normalizeAction should still preserve the wrapper type as a fallback');
});
