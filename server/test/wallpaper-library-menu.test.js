const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '../..');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');

async function loadScreensaverState() {
  const source = read('frontend/js/views/media-control/screensaver-state.js');
  const url = `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
  return import(url);
}

test('workspace wallpaper options are image-only, selected, deduplicated, and resettable', async () => {
  const state = await loadScreensaverState();
  const items = [
    { id: 'custom-b', filename: 'Zulu.png', mime_type: 'image/png', is_wallpaper_menu: true },
    { id: 'custom-a', filename: 'Alpha.jpg', mime_type: 'image/jpeg', is_wallpaper_menu: true },
    { id: 'not-selected', filename: 'Hidden.png', mime_type: 'image/png', is_wallpaper_menu: false },
    { id: 'not-image', filename: 'Clip.mp4', mime_type: 'video/mp4', is_wallpaper_menu: true },
    { id: '1d01b7a0-1a0c-4d3d-b0fd-6d854ce09ae3', filename: 'Duplicate.png', mime_type: 'image/png', is_wallpaper_menu: true },
  ];

  const options = state.setWorkspaceWallpaperOptions(items);
  const dynamic = options.filter(option => option.workspaceWallpaper);
  assert.deepEqual(dynamic.map(option => option.label), ['Alpha', 'Zulu']);
  assert.deepEqual(dynamic.map(option => option.value), ['content:custom-a', 'content:custom-b']);
  assert.equal(options.filter(option => option.value === 'content:1d01b7a0-1a0c-4d3d-b0fd-6d854ce09ae3').length, 1);
  assert.ok(
    options.findIndex(option => option.value === 'content:custom-b')
      < options.findIndex(option => option.value === 'folder:Screensavers'),
  );

  state.setWorkspaceWallpaperOptions([]);
  assert.equal(state.SCREENSAVER_OPTIONS.some(option => option.workspaceWallpaper), false);
});

test('Media Library exposes an idempotent, permission-gated, manifest-backed wallpaper action', () => {
  const view = read('frontend/js/views/content-library.js');
  const api = read('frontend/js/api.js');
  const route = read('server/routes/content.js');
  const english = read('frontend/js/i18n/en.js');

  assert.match(view, /data-wallpaper-menu-content/);
  assert.match(view, /item\.is_wallpaper_menu === true/);
  assert.match(view, /api\.setWallpaperMenu\(item\.id, !wasInMenu, item\.version \|\| 1\)/);
  assert.match(api, /getWallpaperMenu: \(\) => request\('\/content\/wallpaper-menu'\)/);
  assert.match(api, /setWallpaperMenu: \(id, enabled, expectedVersion\)/);
  assert.match(read('frontend/js/views/media-control.js'), /refreshOptions/);
  assert.match(read('frontend/js/views/media-control.js'), /screensaverApi\?\.refreshOptions\?\.\(\)/);
  assert.match(read('frontend/js/views/media-control/stage.js'), /SCREENSAVER_OPTIONS\s*\.map/);
  assert.match(read('frontend/js/views/media-control.js'), /if \(stageEl\(\)\) paintStage\(\)/);
  assert.match(route, /router\.get\('\/wallpaper-menu'/);
  assert.match(route, /JOIN asset_checksums ac ON ac\.content_id = c\.id/);
  assert.match(route, /router\.put\('\/:id\/wallpaper-menu'/);
  assert.match(route, /is_screensaver = \?, screensaver_category = \?/);
  assert.match(english, /'content\.wallpaper_menu_add': 'Add to wallpaper menu'/);
});

test('right-side library clears its loading status and remembers failed thumbnails', () => {
  const toolbox = read('frontend/js/views/media-control/toolbox.js');
  const controller = read('frontend/js/views/media-control.js');

  assert.match(toolbox, /const failedThumbnailUrls = new Set\(\)/);
  assert.match(toolbox, /const MAX_FAILED_THUMBNAILS = 200/);
  assert.match(toolbox, /data-media-thumb/);
  assert.match(toolbox, /failedThumbnailUrls\.has\(url\)/);
  assert.match(toolbox, /new URL\(item\.remote_url\)\.hostname/);
  assert.match(toolbox, /state\.loading = false;\s*renderLoadMore\(\);\s*if \(succeeded \|\| !failed\) renderStatus\(\)/);
  assert.match(toolbox, /requestGeneration: 0/);
  assert.match(toolbox, /state\.requestController\.abort\(\)/);
  assert.match(toolbox, /requestGeneration !== state\.requestGeneration/);
  assert.match(toolbox, /loadPage\(\{ offset: state\.offset \+ PAGE, append: true \}\)/);
  assert.match(toolbox, /if \(!append\) \{\s*state\.items = \[\];\s*state\.offset = 0;\s*state\.hasMore = false;/);
  assert.match(read('frontend/js/api.js'), /getGovernedContent: \(filters = \{\}, options = \{\}\)/);
  assert.match(read('frontend/js/api.js'), /\{ signal: options\.signal \}/);

  const refreshStart = controller.indexOf('function refreshAfterSend(targetIds) {');
  const refreshEnd = controller.indexOf('function applyScreensaver', refreshStart);
  const refreshAfterSend = refreshStart >= 0 && refreshEnd > refreshStart
    ? controller.slice(refreshStart, refreshEnd)
    : '';
  assert.ok(refreshAfterSend, 'refreshAfterSend implementation should remain discoverable');
  assert.doesNotMatch(refreshAfterSend, /getGovernedContent|paintToolbox|renderToolbox/);
});
