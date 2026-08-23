const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(
  path.join(__dirname, '../../frontend/js/views/media-control/multiview.js'),
  'utf8',
);

test('Multiview frame sharing uses the authoritative logical target picker', () => {
  assert.match(source, /waitForTargetCatalog\(\{ includeVirtualDisplays: false \}, \{ requireFresh: true \}\)/);
  assert.match(source, /openTargetPicker\(\{/);
  assert.match(source, /capability: 'screen_share'/);
  assert.match(source, /selection: 'single'/);
  assert.match(source, /allowIndividualWallMembers: false/);
  assert.match(source, /allowLiveProgram: false/);
  assert.doesNotMatch(source, /displayState\.getAll\(\)/);
  assert.doesNotMatch(source, /data-pick-id/);
});

test('Multiview maps a logical wall through calibrated member geometry', () => {
  assert.match(source, /function frameShareTargets\(target, frameRect\)/);
  assert.match(source, /target\.type !== 'wall'/);
  assert.match(source, /member\.viewport/);
  assert.match(source, /target\.onlineCount !== target\.memberCount/);
  assert.match(source, /Promise\.allSettled/);
  assert.match(source, /screenShareEngine\.startBroadcastTo\(entry\.deviceId, \{ wallTile: entry\.wallTile \}\)/);
  assert.match(source, /screenShareEngine\.stopBroadcastTo\(deviceId\)/);
});

test('Multiview re-fetches and revalidates revision and membership immediately before sharing', () => {
  assert.match(source, /findCatalogTarget\(freshCatalog, selection\.references\[0\]\)/);
  assert.match(source, /function sameTargetTopology\(selected, fresh\)/);
  assert.match(source, /selected\.layoutRevision/);
  assert.match(source, /targetMemberIds\(selected\)/);

  const selectedIndex = source.indexOf('const selection = await pickDisplay()');
  const refreshIndex = source.indexOf('waitForTargetCatalog(', selectedIndex);
  const validateIndex = source.indexOf('sameTargetTopology(', refreshIndex);
  const startIndex = source.indexOf('screenShareEngine.startBroadcastTo(', validateIndex);
  assert.ok(refreshIndex > selectedIndex && validateIndex > refreshIndex && startIndex > validateIndex);
});

test('Multiview submits its internal grid as a same-origin relative player URL', () => {
  assert.match(source, /return `\/player\/grid\.html\?cells=\$\{b64url\(JSON\.stringify\(map\)\)\}`/);
  assert.doesNotMatch(source, /location\.origin\}\/player\/grid\.html/);
});

test('Multiview populated frames render the assigned media instead of an icon-only placeholder', () => {
  assert.match(source, /function cellPreviewHtml\(c\)/);
  assert.match(source, /c\.kind === 'v'[\s\S]*?<video[\s\S]*?autoplay muted loop playsinline/);
  assert.match(source, /c\.kind === 'm'[\s\S]*?<img/);
  assert.match(source, /<iframe[\s\S]*?loading="eager"[\s\S]*?referrerpolicy="no-referrer"/);
  assert.match(source, /const preview = cellPreviewHtml\(c\)/);
  assert.match(source, /\$\{preview\}[\s\S]*?<div class="mc-mv-cell-actions">/);
});

test('Multiview always offers live news and an available Guest Computer source', () => {
  assert.match(source, /LIVE_NEWS_CATALOG/);
  assert.match(source, /LIVE_SOURCE_CATALOG/);
  assert.match(source, /api\.liveSources\.list\(\)/);
  assert.match(source, /config\.id === 'guest-computer'/);
  assert.match(source, /source\.available === true/);
  assert.match(source, /multiviewLiveSources/);
});
