const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '../..');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');

test('Media Library uses one ID-keyed accumulated store for every card action', () => {
  const source = read('frontend/js/views/content-library.js');

  assert.match(source, /contentById:\s*new Map\(\)/);
  assert.match(source, /function findContentItem\(id\)/);
  assert.match(source, /function storeContentPage\(items,\s*\{\s*replace/);
  assert.doesNotMatch(source, /\bcontentItems\b/);
  assert.doesNotMatch(source, /\bcontent\.find\(/);

  for (const action of [
    'data-send-content',
    'data-preview-content',
    'data-edit-content',
    'data-transfer-content',
    'data-template-assignments',
    'data-move-content',
  ]) {
    assert.match(source, new RegExp(action));
  }
});

test('newer Media Library requests supersede stale search and filter responses', () => {
  const source = read('frontend/js/views/content-library.js');

  assert.match(source, /contentRequestGeneration/);
  assert.match(source, /\+\+state\.contentRequestGeneration/);
  assert.match(source, /requestGeneration\s*!==\s*state\.contentRequestGeneration/);
  assert.doesNotMatch(source, /if\s*\(state\.contentLoading\)\s*return/);
  assert.match(source, /async function loadFolders/);
  assert.doesNotMatch(source, /Promise\.all\(\[\s*api\.getGovernedContent[\s\S]*api\.getFolders/);
  assert.match(source, /aria-busy/);
});

test('Add Media is a touch-safe accessible sheet instead of three permanent panels', () => {
  const source = read('frontend/js/views/content-library.js');
  const css = read('frontend/css/main.css');

  assert.match(source, /id="openAddMedia"/);
  assert.match(source, /id="addMediaDialog"/);
  assert.match(source, /role="dialog"/);
  assert.match(source, /aria-modal="true"/);
  assert.match(source, /role="tablist"/);
  assert.match(source, /data-add-source="upload"/);
  assert.match(source, /data-add-source="remote"/);
  assert.match(source, /data-add-source="youtube"/);
  assert.match(source, /#\/replays/);
  assert.match(source, /#\/files/);
  assert.match(source, /<button[^>]+class="upload-area"/);
  assert.doesNotMatch(source, /<div[^>]+class="upload-area"/);
  assert.match(css, /@media\s*\(max-width:\s*1024px\)/);
  assert.match(css, /\.media-library-add-button[\s\S]*min-height:\s*var\(--tap-min\)/);
});

test('preview is a labeled focus-managed dialog with type-specific viewers and no autoplay', () => {
  const source = read('frontend/js/views/content-library.js');

  assert.match(source, /function showPreview/);
  assert.match(source, /class="media-preview-dialog"[^>]*role="dialog"/);
  assert.match(source, /aria-modal="true"/);
  assert.match(source, /aria-labelledby="mediaPreviewTitle"/);
  assert.match(source, /trapDialogFocus/);
  assert.match(source, /restoreFocus/);
  assert.match(source, /<video[^>]+controls/);
  assert.match(source, /<audio[^>]+controls/);
  assert.match(source, /application\/pdf/);
  assert.match(source, /sandbox=/);
  assert.doesNotMatch(source, /<video[^>]+autoplay/);
});

test('folder navigation and previews are native keyboard-operable controls', () => {
  const source = read('frontend/js/views/content-library.js');

  assert.match(source, /<button[^>]+class="folder-card"/);
  assert.match(source, /<button[^>]+class="content-item-preview"/);
  assert.doesNotMatch(source, /\bprompt\(/);
  assert.doesNotMatch(source, /\bconfirm\(/);
});

test('zero-byte files render accurately and failed media offers recovery', () => {
  const source = read('frontend/js/views/content-library.js');
  const match = source.match(/function formatFileSize\(bytes\)\s*\{([\s\S]*?)\n\}/);
  assert.ok(match, 'formatFileSize must remain a named helper');
  const formatFileSize = Function('bytes', match[1]);

  assert.equal(formatFileSize(0), '0 B');
  assert.equal(formatFileSize(1024), '1 KB');
  assert.match(source, /data-repair-content/);
  assert.match(source, /content\.btn_repair/);
});

test('Media Library naming and new controls remain localization-backed', () => {
  const english = read('frontend/js/i18n/en.js');
  const source = read('frontend/js/views/content-library.js');

  assert.match(english, /'content\.title': 'Media Library'/);
  assert.match(english, /'nav\.content': 'Media Library'/);
  for (const key of [
    'content.add_media',
    'content.add_media_title',
    'content.source_upload',
    'content.source_remote',
    'content.source_youtube',
    'content.source_peertube',
    'content.source_cloud',
    'content.view_grid',
    'content.view_list',
    'content.sort_label',
    'content.retry',
    'content.preview_title',
    'content.btn_repair',
  ]) {
    assert.match(english, new RegExp(key.replace('.', '\\.')), `English is missing ${key}`);
    assert.match(source, new RegExp(`t\\('${key.replace('.', '\\.')}'`), `view is not using ${key}`);
  }
});
