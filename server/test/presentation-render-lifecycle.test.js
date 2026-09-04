'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function read(relativePath) {
  return fs.readFileSync(path.join(__dirname, '..', '..', relativePath), 'utf8');
}

test('document player separates requested and committed pages and commits only a decoded newest generation', () => {
  const source = read('server/player/doc.html');
  assert.match(source, /requestedPage/);
  assert.match(source, /committedPage/);
  assert.match(source, /renderGeneration/);
  assert.match(source, /candidate\.decode/);
  assert.match(source, /generation\s*!==\s*renderGeneration/);
  assert.match(source, /replaceWith\(candidate\)/);
  assert.doesNotMatch(source, /document\.addEventListener\('click'[\s\S]*handleAction\('next'\)/);
});

test('document commands resolve their acknowledgement from committed state', () => {
  const source = read('server/player/doc.html');
  const start = source.indexOf('function handleAction(input)');
  const end = source.indexOf('// Expose handleAction', start);
  const snippet = source.slice(start, end);
  assert.match(snippet, /return\s+Promise/);
  assert.match(snippet, /ack\.state\s*=\s*publishState\(ack\)/);
  assert.match(source, /slide_index:\s*committedPage/);
});

test('parent player treats asynchronous child acknowledgement as pending until commit', () => {
  const source = read('server/player/index.html');
  const start = source.indexOf('function tryDirectIframeTransport(');
  const end = source.indexOf('// Transport (Broadcast Center control bar)', start);
  const snippet = source.slice(start, end);
  const pending = snippet.indexOf("typeof result.then === 'function'");
  const finish = snippet.indexOf('finishTransportCommand(command', pending);
  assert.ok(pending >= 0 && finish > pending);
  assert.match(snippet.slice(pending, finish), /result\.then/);
});

test('wall sync publishes and consumes the document child committed slide', () => {
  const source = read('server/player/index.html');
  assert.match(source, /slide_index:\s*wallSnapshot\.content_type === 'document'/);
  assert.match(source, /const leaderSlide = parseInt\(data\.slide_index/);
  assert.match(source, /childState\?\.requested_slide_index/);
  assert.match(source, /child\.handleAction\(syncCommand\)/);
});

test('passive presentation previews advance their confirmed dataset only from child state', () => {
  const source = read('frontend/js/views/media-control.js');
  const preview = read('frontend/js/views/media-control/live-preview.js');
  assert.match(source, /confirmPresentationPreview/);
  assert.match(source, /schedulePresentationPreviewRetry/);
  assert.match(source, /state\?\.slide_index/);
  assert.doesNotMatch(source, /postMessage\([\s\S]{0,300}frame\.dataset\.mcSlideIndex\s*=\s*String\(slide\)/);
  assert.doesNotMatch(preview, /data-mc-slide-index=/);
});

test('passive presentation preview retries an unready frame and confirms only the committed child slide', async () => {
  const source = read('frontend/js/views/media-control.js');
  const start = source.indexOf('function confirmPresentationPreview(');
  const end = source.indexOf('function refreshPreviewsInPlace()', start);
  const implementation = source.slice(start, end);
  assert.ok(start >= 0 && end > start);

  const timers = [];
  const fakeSetTimeout = (callback, delay) => {
    const timer = { callback, delay, cleared: false };
    timers.push(timer);
    return timer;
  };
  const fakeClearTimeout = (timer) => { if (timer) timer.cleared = true; };
  const factory = new Function('presentationPreviewSync', 'location', 'setTimeout', 'clearTimeout', `
    let presentationPreviewCommandSequence = 0;
    ${implementation}
    return { syncPresentationPreview };
  `);
  const syncMap = new WeakMap();
  const api = factory(syncMap, { origin: 'https://media.test' }, fakeSetTimeout, fakeClearTimeout);
  const posts = [];
  const frame = {
    dataset: {},
    isConnected: true,
    contentWindow: { postMessage: (message) => posts.push(message) },
  };

  api.syncPresentationPreview(frame, 3);
  assert.equal(frame.dataset.mcSlideIndex, undefined);
  assert.equal(posts.length, 1);
  assert.equal(timers.length, 1);

  frame.contentWindow.handleAction = async () => ({ ok: true, state: { slide_index: 3 } });
  timers[0].callback();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(frame.dataset.mcSlideIndex, '3');
});

test('stage selection and details are separate accessible actions', () => {
  const stage = read('frontend/js/views/media-control/stage.js');
  const main = read('frontend/js/views/media-control.js');
  assert.match(stage, /mc-card-details/);
  assert.match(stage, /onDetails/);
  assert.match(stage, /stopPropagation/);
  assert.match(main, /selectStageDisplayTarget/);
  assert.match(main, /openInspector/);
  assert.doesNotMatch(main, /function selectStageDisplayTarget\(deviceId\)[\s\S]{0,500}openInspector\(deviceId\)/);
});
