'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..', '..');

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

test('Command Center Content Library uses a fixed bottom shelf without a modal backdrop', () => {
  const view = read('frontend/js/views/media-control.js');
  const css = read('frontend/css/media-control.css');

  assert.match(view, /id="mc-library-drawer"/);
  assert.match(view, /class="mc-library-body"[\s\S]*?id="mc-toolbox"/);
  assert.doesNotMatch(view, /mc-library-backdrop|data-library-backdrop/);
  assert.match(css, /--mc-library-collapsed-h:\s*48px/);
  assert.match(css, /--mc-library-expanded-h:\s*clamp\(220px,\s*40dvh,\s*360px\)/);
  assert.match(css, /\.mc-cc-body \.mc-library-drawer\s*\{[\s\S]*?position:\s*fixed;[\s\S]*?left:[\s\S]*?right:\s*0;[\s\S]*?bottom:\s*0;/);
  assert.match(css, /\.mc-cc-body \.mc-library-drawer\[data-open="false"\]\s*\{[\s\S]*?translateY/);
  assert.doesNotMatch(css, /\.mc-cc-body \.mc-library-drawer\[data-open="false"\][^{]*\{[^}]*translateX/);
});

test('Command Center shelf defines exactly six normalized operator categories', () => {
  const toolbox = read('frontend/js/views/media-control/toolbox.js');
  const view = read('frontend/js/views/media-control.js');
  const api = read('frontend/js/api.js');

  assert.match(toolbox, /const TABS = Object\.freeze\(\[[\s\S]*?id: 'videos',[\s\S]*?label: 'Videos'[\s\S]*?id: 'images',[\s\S]*?label: 'Images'[\s\S]*?id: 'docs',[\s\S]*?label: 'Docs'[\s\S]*?id: 'sources',[\s\S]*?label: 'Sources'[\s\S]*?id: 'livefeeds',[\s\S]*?label: 'Live Feeds'[\s\S]*?id: 'additional',[\s\S]*?label: 'Additional Controls'[\s\S]*?\]\)/);
  assert.match(toolbox, /const TAB_ALIASES = Object\.freeze\(\{[\s\S]*?media: 'videos'[\s\S]*?camerafeeds: 'sources'[\s\S]*?presentations: 'docs'[\s\S]*?youtube: 'sources'[\s\S]*?nextcloud: 'sources'[\s\S]*?playlists: 'additional'[\s\S]*?scenes: 'additional'/);
  assert.match(toolbox, /function trustedMime\(item\)[\s\S]*?item\?\.media\?\.detected_mime_type[\s\S]*?item\?\.detected_mime_type[\s\S]*?item\?\.mime_type/);
  assert.match(toolbox, /mime\.startsWith\('video\/'\)[\s\S]*?mime\.startsWith\('image\/'\)[\s\S]*?SUPPORTED_DOCUMENT_MIMES\.has\(mime\)/);
  assert.match(toolbox, /mime\.startsWith\('audio\/'\)[\s\S]*?return null/);
  assert.doesNotMatch(toolbox, /id: 'media',\s*(?:key|label):/);
  assert.doesNotMatch(toolbox, /id: 'camerafeeds',\s*(?:key|label):/);
  assert.doesNotMatch(toolbox, /const MEDIA_TYPES/);
  assert.match(view, /openContentDrawerFiltered\(folderName\)[\s\S]*?openToolboxTab\(tb, 'images', \{ folder: folderName \}\)/);
  assert.match(view, /openLibraryTab\('sources'\)/);
  assert.match(api, /filters\.folder\)[\s\S]*?query\.set\('folder', filters\.folder\)/);
});

test('Command Center shelf cards are large visual tiles without changing route payloads', () => {
  const toolbox = read('frontend/js/views/media-control/toolbox.js');
  const css = read('frontend/css/media-control.css');

  assert.match(css, /\.mc-library-body \.mc-tile\s*\{[\s\S]*?width:\s*152px;[\s\S]*?min-height:\s*132px;/);
  assert.match(css, /\.mc-library-body \.mc-tile-thumb[\s\S]*?width:\s*136px;[\s\S]*?height:\s*82px;/);
  assert.match(css, /\.mc-library-body \.mc-tile-label[\s\S]*?white-space:\s*nowrap;[\s\S]*?text-overflow:\s*ellipsis;/);
  assert.match(css, /\.mc-library-body \.mc-tile-thumb-fallback[\s\S]*?width:\s*136px;[\s\S]*?height:\s*82px;/);
  assert.match(toolbox, /const src = JSON\.stringify\(\{ content_id: item\.id \}\)/);
  assert.match(toolbox, /data-drag-source='\$\{esc\(src\)\}'/);
  assert.match(toolbox, /data-label="\$\{esc\(name\)\}"/);
  assert.match(toolbox, /rememberFailedThumbnailUrl\(img\.dataset\.thumbUrl/);
  assert.match(toolbox, /const PAGE = 60/);
});
