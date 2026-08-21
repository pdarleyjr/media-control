'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..', '..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');

test('v2 Studio and Converter are additive, feature-gated navigation surfaces', () => {
  const index = read('frontend/index.html');
  const app = read('frontend/js/app.js');
  const flags = read('frontend/js/state/feature-flags.js');

  assert.match(index, /id="presentationStudioNavItem"[^>]*display:none/);
  assert.match(index, /id="presentationConverterNavItem"[^>]*display:none/);
  assert.match(index, /class="legacy-presentation-nav"/);
  assert.match(index, /data-view="downloads"/);
  assert.match(app, /presentation-studio\.js/);
  assert.match(app, /presentation-converter\.js/);
  assert.match(app, /isPresentationStudioV2Enabled/);
  assert.match(app, /#\/presentation-converter/);
  assert.match(flags, /presentationStudioV2/);
  assert.match(flags, /presentationConverter/);
});

test('Studio exposes required authoring, export, preview, media and presentation controls', () => {
  const source = read('frontend/js/views/presentation-studio.js');
  for (const contract of [
    'api.presentations.registry',
    'api.presentations.linkAsset',
    'api.presentations.downloadPptx',
    'api.presentations.exportToLibrary',
    'api.presentations.saveAssetCopy',
    'api.ai.generateDeckV2',
    'api.ai.assistSlideV2',
    'openTargetPicker',
    'waitForTargetCatalog',
    'presentation_id',
    'speaker_notes',
    'data-slide-add',
    'data-slide-duplicate',
    'data-slide-delete',
    'data-slide-up',
    'data-slide-down',
    'data-studio-present',
    'studioUndo',
    'draggable="true"',
    'data-add-video-url',
    'data-guide="seamSafe"',
    'data-studio-validation',
    'continuations',
    'data-save-asset-copy',
  ]) assert.ok(source.includes(contract), `missing Studio contract: ${contract}`);
  assert.doesNotMatch(source, /localhost:11434|\/api\/generate\b/);
  assert.doesNotMatch(source, /slide\.slots\s*=\s*Object\.fromEntries\([^;]*filter/, 'layout changes must not silently filter away slot content');
});

test('Converter is asynchronous, review-first, cancelable and never auto-broadcasts', () => {
  const source = read('frontend/js/views/presentation-converter.js');
  for (const contract of [
    'api.presentationConverter.uploadSource',
    'api.presentationConverter.sources',
    'api.presentationConverter.start',
    'api.presentationConverter.job',
    'api.presentationConverter.cancel',
    'api.presentationConverter.retry',
    'api.presentationConverter.retryFaithful',
    'faithful',
    'optimized',
    "t('converter.review')",
    '#/presentation-studio?id=',
    'converterActivity',
    'slide_current',
    'sessionStorage',
    'elapsedTimer',
    "t('converter.refresh_delayed')",
    'converterRetryFaithful',
    'activeJob.completed_at',
    'activeJob.mode',
    'result?.optimization_status',
    "t('converter.optimization_partial')",
    "t('converter.optimization_fallback')",
  ]) assert.ok(source.includes(contract), `missing Converter contract: ${contract}`);
  assert.doesNotMatch(source, /api\.broadcast\s*\(/);
});

test('Converter status polling stays within the route limit and retries transient throttling', () => {
  const source = read('frontend/js/views/presentation-converter.js');
  const interval = Number(source.match(/const POLL_INTERVAL_MS = (\d+);/)?.[1]);
  assert.ok(Number.isFinite(interval), 'Converter poll interval must be explicit');
  assert.ok(
    Math.ceil(60000 / interval) + 1 <= 30,
    `Converter polling would exceed the 30 request/minute route limit: ${interval}ms`,
  );
  assert.match(source, /if \(error\.status === 429\)[\s\S]*refresh_delayed[\s\S]*schedulePoll/);
  assert.doesNotMatch(source, /setInterval\(\(\) => pollJob/, 'server polling must use bounded setTimeout backoff');
});

test('Studio CSS preserves a fixed logical wall stage and accessible touch geometry', () => {
  const css = read('frontend/css/presentation-studio.css');
  assert.match(css, /--studio-stage-width/);
  assert.match(css, /aspect-ratio:\s*16\s*\/\s*3/);
  assert.match(css, /min-height:\s*48px/);
  assert.match(css, /@media\s*\(max-width:\s*1100px\)/);
  assert.match(css, /@media\s*\(max-width:\s*720px\)/);
  assert.match(css, /prefers-reduced-motion/);
  assert.match(css, /\.studio-present[^}]*#F28C28/is);
});

test('frontend API keeps authenticated downloads and durable conversion jobs same-origin', () => {
  const source = read('frontend/js/api.js');
  assert.match(source, /downloadPptx/);
  assert.match(source, /normalizeApiPath\(`\/presentations\/\$\{encodeURIComponent\(id\)\}\/export\.pptx`\)/);
  assert.match(source, /presentationConverter:\s*\{/);
  assert.match(source, /presentation-converter\/sources/);
  assert.match(source, /\/presentation-converter\/jobs/);
  assert.match(source, /generateDeckV2/);
  assert.match(source, /saveAssetCopy/);
});

test('Save Copy is presentation-scoped and never promotes the internal dependency in place', () => {
  const route = read('server/routes/presentations.js');
  assert.match(route, /\/:id\/assets\/:contentId\/save-copy/);
  assert.match(route, /copyPresentationAssetToLibrary/);
  assert.doesNotMatch(route, /UPDATE content SET library_scope='library'/);
  assert.doesNotMatch(read('server/routes/content.js'), /promote-to-library/);
});
