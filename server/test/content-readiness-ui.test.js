const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '../..');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');

async function loadReadinessModule() {
  const source = read('frontend/js/services/content-readiness.js');
  const encoded = Buffer.from(source).toString('base64');
  return import(`data:text/javascript;base64,${encoded}`);
}

test('video readiness disables sending throughout normalization and preserves available progress', async () => {
  const { getContentReadiness } = await loadReadinessModule();

  for (const processingStatus of ['uploaded', 'probing', 'processing']) {
    const readiness = getContentReadiness({
      mime_type: 'video/quicktime',
      processing_status: processingStatus,
      processing_progress: 47,
    });
    assert.equal(readiness.state, 'preparing');
    assert.equal(readiness.sendEnabled, false);
    assert.equal(readiness.progress, 47);
  }

  assert.equal(getContentReadiness({
    mime_type: 'video/mp4',
    processing_status: 'processing',
    processing_progress: 160,
  }).progress, 100);
  assert.equal(getContentReadiness({
    mime_type: 'video/mp4',
    processing_status: 'processing',
  }).progress, null);
});

test('video readiness distinguishes ready, failed, remote, and legacy-safe content', async () => {
  const { getContentReadiness } = await loadReadinessModule();

  assert.deepEqual(
    getContentReadiness({ mime_type: 'video/mp4', processing_status: 'ready' }),
    { state: 'ready', sendEnabled: true, progress: 100, reason: '' },
  );
  assert.deepEqual(
    getContentReadiness({
      mime_type: 'video/x-matroska',
      processing_status: 'failed',
      processing_error: 'The video codec is not supported.',
    }),
    {
      state: 'failed',
      sendEnabled: false,
      progress: null,
      reason: 'The video codec is not supported.',
    },
  );
  assert.equal(getContentReadiness({
    mime_type: 'video/youtube',
    processing_status: 'uploaded',
  }).sendEnabled, true);
  assert.equal(getContentReadiness({
    mime_type: 'image/png',
    processing_status: 'uploaded',
  }).sendEnabled, true);
  assert.equal(getContentReadiness({
    mime_type: 'video/mp4',
    processing_status: null,
  }).sendEnabled, true);
});

test('content-updated payloads only update the matching content generation', async () => {
  const { applyContentUpdate } = await loadReadinessModule();
  const item = {
    id: 'content-a',
    processing_status: 'processing',
    version: 4,
  };

  assert.equal(applyContentUpdate(item, {
    content_id: 'content-b',
    processing_status: 'ready',
  }), item);
  assert.deepEqual(applyContentUpdate(item, {
    content_id: 'content-a',
    processing_status: 'ready',
    generation: 5,
  }), {
    id: 'content-a',
    processing_status: 'ready',
    version: 5,
    generation: 5,
  });
});

test('Content Library exposes a touch-safe all-display send lifecycle', () => {
  const library = read('frontend/js/views/content-library.js');
  const socket = read('frontend/js/socket.js');
  const css = read('frontend/css/main.css');

  for (const marker of [
    'getContentReadiness',
    'data-send-content',
    'data-auto-send-ready',
    'content.status_preparing',
    'content.status_ready',
    'content.status_failed',
    'content.send_when_ready',
    'waitForTargetCatalog',
    'openAuthoritativeTargetPicker',
    "capability: 'content'",
    'allowIndividualWallMembers: false',
    'sendToDisplays',
    'content-updated',
    'socketOn',
    'socketOff',
  ]) assert.match(library, new RegExp(marker.replace(/[?.]/g, '\\$&')));

  assert.doesNotMatch(library, /data-auto-send-ready[^>]*\schecked(?:\s|>)/);
  assert.match(socket, /dashboardSocket\.on\('content-updated'[\s\S]*emit\('content-updated'/);
  assert.match(css, /\.content-send-control[\s\S]*min-height:\s*44px/);
  assert.match(css, /\.content-readiness-progress/);
});

test('every translated locale names video readiness and the Hindi skeleton retains English fallback', () => {
  const localeDir = path.join(ROOT, 'frontend/js/i18n');
  const localeFiles = fs.readdirSync(localeDir).filter(file => file.endsWith('.js'));
  assert.ok(localeFiles.length >= 7);

  for (const file of localeFiles.filter(file => file !== 'hi.js')) {
    const source = read(`frontend/js/i18n/${file}`);
    for (const key of [
      'content.status_preparing',
      'content.status_ready',
      'content.status_failed',
      'content.status_failed_reason',
      'content.send_btn',
      'content.send_when_ready',
      'content.auto_send_queued',
      'content.auto_send_cancelled',
    ]) {
      assert.match(source, new RegExp(key.replace('.', '\\.')), `${file} is missing ${key}`);
    }
  }
  assert.match(read('frontend/js/i18n/hi.js'), /export default \{\};/);
});
