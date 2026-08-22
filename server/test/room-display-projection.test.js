const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

async function loadProjection() {
  const source = fs.readFileSync(
    path.join(__dirname, '../../frontend/js/services/room-display-projection.js'),
    'utf8',
  );
  return import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
}

test('projects the compact snapshot into the complete command-center display contract', async () => {
  const { projectRoomDisplays } = await loadProjection();
  const prior = new Map([['tv-1', {
    id: 'tv-1', screenshot_url: '/prior.jpg', screenshot_at: 100,
    now_playing: { label: 'Prior title', kind: 'video', currentTime: 9 },
    telemetry: { cpu: 12 },
  }]]);
  const snapshot = {
    confirmedState: { displays: [{
      id: 'tv-1', name: 'Front Left', status: 'online', contentId: 'content-2',
      contentType: 'presentation', paused: false, slideIndex: 3, slideCount: 20,
      wallId: 'primary', layoutId: 'span', screenOn: true,
      commandRevision: 'blank-command-4', stateRevision: 4,
    }] },
    deviceStates: { displays: [{
      id: 'tv-1', screenOn: true, width: 3840, height: 2160,
      wallId: 'primary', layoutId: 'span',
    }] },
  };

  const projected = projectRoomDisplays(snapshot, prior, {
    screenshotUrlForId: (id) => `/fallback/${id}.jpg`,
  });
  assert.deepEqual(projected.get('tv-1'), {
    id: 'tv-1', name: 'Front Left', status: 'online', contentId: 'content-2',
    contentType: 'presentation', paused: false, slideIndex: 3, slideCount: 20,
    wallId: 'primary', layoutId: 'span', screenOn: true,
    commandRevision: 'blank-command-4', stateRevision: 4,
    screenshot_url: '/prior.jpg', screenshot_at: 100,
    telemetry: { cpu: 12 }, online: true, screen_on: true,
    command_revision: 'blank-command-4', state_revision: 4, error_state: null, screen_width: 3840,
    screen_height: 2160, wall_id: 'primary', layout_id: 'span',
    now_playing: {
      label: 'Prior title', kind: 'presentation', currentTime: 9,
      contentId: 'content-2', content_id: 'content-2', paused: false,
      slideIndex: 3, slideCount: 20, duration: null,
    },
  });
});

test('snapshot membership is authoritative while sparse fields preserve known presentation data', async () => {
  const { projectRoomDisplays } = await loadProjection();
  const prior = new Map([
    ['removed', { id: 'removed', name: 'Removed device' }],
    ['tv-2', { id: 'tv-2', screen_on: true, screen_width: 1920, now_playing: { kind: 'web', label: 'Map' } }],
  ]);
  const projected = projectRoomDisplays({
    confirmedState: { displays: [{ id: 'tv-2', name: 'Side TV', status: 'offline' }] },
    deviceStates: { displays: [] },
  }, prior, { screenshotUrlForId: (id) => `/screen/${id}` });

  assert.equal(projected.has('removed'), false);
  assert.equal(projected.get('tv-2').online, false);
  assert.equal(projected.get('tv-2').screen_on, null);
  assert.equal(projected.get('tv-2').screen_width, 1920);
  assert.equal(projected.get('tv-2').now_playing.kind, 'web');
  assert.equal(projected.get('tv-2').screenshot_url, null);
});

test('a snapshot advertises a screenshot URL only when capture metadata exists', async () => {
  const { projectRoomDisplays } = await loadProjection();
  const requested = [];
  const projected = projectRoomDisplays({
    confirmedState: { displays: [{ id: 'empty' }, { id: 'captured' }] },
    deviceStates: { displays: [
      { id: 'empty', screenshotAt: null },
      { id: 'captured', screenshotAt: 1700000000 },
    ] },
  }, new Map(), {
    screenshotUrlForId: (id, capturedAt) => {
      requested.push([id, capturedAt]);
      return `/screen/${id}?t=${capturedAt}`;
    },
  });

  assert.equal(projected.get('empty').screenshot_url, null);
  assert.equal(projected.get('captured').screenshot_url, '/screen/captured?t=1700000000');
  assert.deepEqual(requested, [['captured', 1700000000]]);
});

test('a new confirmed content identity cannot inherit the previous source URL or poster', async () => {
  const { projectRoomDisplays } = await loadProjection();
  const prior = new Map([['front-left', {
    id: 'front-left',
    now_playing: {
      contentId: 'anpviz-content',
      content_id: 'anpviz-content',
      kind: 'web',
      label: 'Anpviz Camera',
      remoteUrl: '/player/live-source.html?source=anpviz',
      poster_url: '/api/content/anpviz-content/thumbnail',
    },
  }]]);

  const projected = projectRoomDisplays({
    confirmedState: { displays: [{
      id: 'front-left', name: 'Front Left', status: 'online',
      contentId: 'guest-content', contentType: 'web', renderState: 'playing',
    }] },
    deviceStates: { displays: [{ id: 'front-left', screenOn: true }] },
  }, prior);

  const nowPlaying = projected.get('front-left').now_playing;
  assert.equal(nowPlaying.contentId, 'guest-content');
  assert.equal(nowPlaying.content_id, 'guest-content');
  assert.equal(nowPlaying.kind, 'web');
  assert.equal(nowPlaying.remoteUrl, undefined);
  assert.equal(nowPlaying.poster_url, undefined);
  assert.notEqual(nowPlaying.label, 'Anpviz Camera');
});

test('invalid snapshots do not erase the current display store', async () => {
  const { projectRoomDisplays } = await loadProjection();
  assert.equal(projectRoomDisplays({}, new Map([['tv-1', { id: 'tv-1' }]])), null);
});
