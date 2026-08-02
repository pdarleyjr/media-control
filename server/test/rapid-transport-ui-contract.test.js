const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function read(relativePath) {
  return fs.readFileSync(path.join(__dirname, '..', '..', relativePath), 'utf8');
}

test('canvas transport does not lock the instructor out while confirmation is pending', () => {
  const source = read('frontend/js/views/media-control.js');
  const start = source.indexOf('function mountTransportRow(');
  const end = source.indexOf('function mountScreensaverRow(', start);
  const snippet = source.slice(start, end);

  assert.ok(start >= 0 && end > start);
  assert.match(snippet, /createTransportIntentTracker/);
  assert.match(snippet, /pendingTransportCount/);
  assert.doesNotMatch(snippet, /if \(inFlight\) return/);
  assert.doesNotMatch(snippet, /control\.disabled = busy/);
});

test('presentation transport uses the child action state machine and never mutates iframe slide DOM', () => {
  const source = read('server/player/index.html');
  const start = source.indexOf('function tryDirectIframeTransport(');
  const end = source.indexOf('function doTransport(input)', start);
  const snippet = source.slice(start, end);

  assert.ok(start >= 0 && end > start);
  assert.match(snippet, /childWindow\.handleAction\(envelope\)/);
  assert.match(snippet, /postMessage/);
  assert.doesNotMatch(snippet, /contentDocument/);
  assert.doesNotMatch(snippet, /pageImg\.src/);
  assert.doesNotMatch(snippet, /classList\.add\('show'\)/);
});

test('per-display transport remains clickable while prior confirmation is pending', () => {
  const source = read('frontend/js/views/media-control/transport.js');
  const start = source.indexOf('export function renderTransportBar(');
  const end = source.indexOf('export function _disposeTransportAckForTests', start);
  const snippet = source.slice(start, end);

  assert.ok(start >= 0 && end > start);
  assert.match(snippet, /createTransportIntentTracker/);
  assert.doesNotMatch(snippet, /btn\.disabled = true/);
  assert.doesNotMatch(snippet, /gotoBtn\.disabled = true/);
});

test('rapid transport completion coalesces screenshot and state refresh work', () => {
  const source = read('frontend/js/views/media-control.js');
  const start = source.indexOf('function refreshAfterSend(');
  const end = source.indexOf('// A screensaver option', start);
  const snippet = source.slice(start, end);

  assert.ok(start >= 0 && end > start);
  assert.match(source, /pendingPostActionPreviewIds/);
  assert.match(snippet, /for \(const timer of postActionPreviewTimers\) clearTimeout\(timer\)/);
  assert.match(snippet, /postActionPreviewTimers\.clear\(\)/);
});
