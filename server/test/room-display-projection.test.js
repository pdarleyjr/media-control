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
      wallId: 'primary', layoutId: 'span',
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
    wallId: 'primary', layoutId: 'span', screenshot_url: '/prior.jpg', screenshot_at: 100,
    telemetry: { cpu: 12 }, online: true, screen_on: true, screen_width: 3840,
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
  assert.equal(projected.get('tv-2').screen_on, true);
  assert.equal(projected.get('tv-2').screen_width, 1920);
  assert.equal(projected.get('tv-2').now_playing.kind, 'web');
  assert.equal(projected.get('tv-2').screenshot_url, '/screen/tv-2');
});

test('invalid snapshots do not erase the current display store', async () => {
  const { projectRoomDisplays } = await loadProjection();
  assert.equal(projectRoomDisplays({}, new Map([['tv-1', { id: 'tv-1' }]])), null);
});

