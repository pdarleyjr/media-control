const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function read(relativePath) {
  return fs.readFileSync(path.resolve(__dirname, '../..', relativePath), 'utf8');
}

test('MBFD Map fills a spanned wall without changing its solo-display fit', () => {
  const player = read('server/player/index.html');
  const database = read('server/db/database.js');

  assert.match(player, /WALL_FILL_FILENAMES = new Set\(\['mbfd_map\.png'\]\)/);
  assert.match(player, /function isWallFillContent\(item\)/);
  assert.match(player, /function contentFitMode\(item, isWall\)/);
  assert.match(player, /isWall && isWallFillContent\(item\)/);
  assert.match(player, /isWallFillContent\(item\)\) return 'contain'/);
  assert.match(player, /const cssFit = contentFitMode\(item, !!wallConfig\)/);
  assert.ok(
    player.indexOf('const WALL_FILL_CONTENT_IDS') < player.indexOf('const cachedPlaylist = loadPlaylistCache()'),
    'wall-fill constants must initialize before cached playback starts',
  );
  assert.match(database, /mbfd_map_wall_fill_v2/);
  assert.match(database, /UPDATE content[\s\S]*?SET default_fit_mode = 'fill'[\s\S]*?lower\(trim\(filename\)\) = 'mbfd_map\.png'/);
});
