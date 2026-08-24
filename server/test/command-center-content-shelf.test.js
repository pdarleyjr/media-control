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

test('Command Center composition follows the approved shelf mockup without a duplicate internal rail', () => {
  const view = read('frontend/js/views/media-control.js');
  const dock = read('frontend/js/views/media-control/action-dock.js');
  const toolbox = read('frontend/js/views/media-control/toolbox.js');
  const css = read('frontend/css/media-control.css');

  assert.doesNotMatch(view, /<nav class="mc-cc-rail"/);
  assert.doesNotMatch(view, /mc-secondary-controls-parking/);
  assert.match(view, /class="mc-persistent-controls"[\s\S]*?id="mc-action-dock-host"[\s\S]*?class="mc-cc-sub-row"[\s\S]*?id="mc-span-split-host"[\s\S]*?id="mc-screensaver-host"/);
  assert.doesNotMatch(toolbox, /categorySection\('Actions'/);
  assert.match(toolbox, /class="mc-tb-additional-actions"/);
  assert.match(dock, /mc-action-dock-secondary[\s\S]*?data-dock="multiview"[\s\S]*?data-dock="whiteboard"[\s\S]*?data-dock="share"[\s\S]*?id="mc-dock-start-record-btn"[\s\S]*?data-dock="start-live"[\s\S]*?data-camera-health/);
  assert.match(css, /body\.cc-fullscreen:not\(\.console-mode\) \.content\s*\{[\s\S]*?margin-left:\s*var\(--sidebar-current-width\)\s*!important/);
  assert.doesNotMatch(css, /body\.cc-fullscreen \.sidebar,[\s\S]*?display:\s*none\s*!important/);
  assert.match(css, /\.mc-cc-body \.mc-library-drawer \.mc-library-tab\s*\{[\s\S]*?width:\s*min\(/);
  assert.match(css, /\.mc-library-body \.mc-tb-bar\s*\{[\s\S]*?justify-content:\s*flex-start/);
  assert.match(css, /\.mc-library-body \.mc-tb-tab\.active\s*\{[\s\S]*?background:\s*var\(--mc-surface/);
  assert.match(css, /\.mc-action-dock-persistent \.mc-cam-health-wrap\s*\{\s*display:\s*none/);
  assert.match(css, /--mc-library-layout-reserve-h:\s*clamp\(220px, 27dvh, 260px\)/);
  assert.match(css, /@media \(min-width: 1100px\) and \(min-height: 760px\)[\s\S]*?--mc-library-expanded-h:\s*clamp\(340px, 40dvh, 360px\)/);
});
