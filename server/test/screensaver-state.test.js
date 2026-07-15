const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

async function loadModule() {
  const source = fs.readFileSync(path.resolve(__dirname, '../../frontend/js/views/media-control/screensaver-state.js'), 'utf8');
  const url = `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
  return import(url);
}

test('known wallpapers resolve from authoritative content and URL state', async () => {
  const state = await loadModule();

  assert.equal(
    state.screensaverValueForNowPlaying({ contentId: '1d01b7a0-1a0c-4d3d-b0fd-6d854ce09ae3', kind: 'image' }),
    'content:1d01b7a0-1a0c-4d3d-b0fd-6d854ce09ae3',
  );
  assert.equal(
    state.screensaverValueForNowPlaying({ remoteUrl: 'https://wall.mbfdhub.com/', kind: 'web' }),
    'url:https://wall.mbfdhub.com',
  );
  assert.equal(
    state.screensaverValueForNowPlaying({ remoteUrl: state.BLACK_SCREENSAVER_URL, kind: 'web' }),
    'blank:black',
  );
});

test('wall wallpaper state reports a shared choice or truthful mixed/custom state', async () => {
  const state = await loadModule();
  const dashboard = { now_playing: { remoteUrl: 'https://wall.mbfdhub.com', kind: 'web' } };
  const custom = { now_playing: { contentId: 'not-a-wallpaper', kind: 'image' } };

  assert.equal(
    state.screensaverValueForDisplays([dashboard, dashboard]),
    'url:https://wall.mbfdhub.com',
  );
  assert.equal(
    state.screensaverValueForDisplays([dashboard, custom]),
    state.MIXED_SCREENSAVER_VALUE,
  );
  assert.equal(
    state.screensaverValueForDisplays([custom]),
    state.MIXED_SCREENSAVER_VALUE,
  );
});

test('selectors retain state instead of resetting to MBFD Default after a choice', () => {
  const main = fs.readFileSync(path.resolve(__dirname, '../../frontend/js/views/media-control.js'), 'utf8');
  const stage = fs.readFileSync(path.resolve(__dirname, '../../frontend/js/views/media-control/stage.js'), 'utf8');

  assert.doesNotMatch(main, /const val = sel\.value;\s*sel\.value = ''/);
  assert.doesNotMatch(stage, /const val = sel\.value;\s*sel\.value = ''/);
  assert.match(main, /pending = \{ targetKey: targetKey\(ids\), value: val/);
  assert.match(main, /screensaverValueForDisplays/);
  assert.match(stage, /data-current-value/);
});
