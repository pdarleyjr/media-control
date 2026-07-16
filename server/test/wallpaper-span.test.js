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

  assert.match(player, /WALL_FILL_CONTENT_IDS = new Set\(\['7c596f36-27f6-4d7b-9bb0-2c682791d25a'\]\)/);
  assert.match(player, /function contentFitMode\(item, isWall\)/);
  assert.match(player, /isWall && WALL_FILL_CONTENT_IDS\.has\(item\.content_id\)/);
  assert.match(player, /WALL_FILL_CONTENT_IDS\.has\(item\.content_id\)\) return 'contain'/);
  assert.match(player, /const cssFit = contentFitMode\(item, !!wallConfig\)/);
  assert.match(database, /mbfd_map_wall_fill_v1/);
  assert.match(database, /UPDATE content[\s\S]*?SET default_fit_mode = 'fill'[\s\S]*?7c596f36-27f6-4d7b-9bb0-2c682791d25a/);
});
