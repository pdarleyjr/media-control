'use strict';

const { test, expect } = require('@playwright/test');

const ORIGIN = 'http://127.0.0.1:18117';

// A genuine, short PCM media response keeps the browser's HTMLMediaElement
// lifecycle active without depending on an external asset or codec service.
// It is intentionally silent: the tests assert policy-controlled mute state,
// not sound pressure in the CI host.
function makeSilentWav() {
  const sampleRate = 8000;
  const sampleCount = 2000;
  const dataSize = sampleCount * 2;
  const wav = Buffer.alloc(44 + dataSize);
  wav.write('RIFF', 0);
  wav.writeUInt32LE(36 + dataSize, 4);
  wav.write('WAVE', 8);
  wav.write('fmt ', 12);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(sampleRate, 24);
  wav.writeUInt32LE(sampleRate * 2, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write('data', 36);
  wav.writeUInt32LE(dataSize, 40);
  return wav;
}
const SILENT_WAV = makeSilentWav();

const SOCKET_CLIENT = `
  (() => {
    function createSocket() {
      const handlers = new Map();
      const emitted = [];
      const socket = {
        connected: true,
        on(event, handler) {
          handlers.set(event, handler);
          return socket;
        },
        emit(event, ...args) {
          emitted.push({ event, args });
          return true;
        },
        disconnect() {
          socket.connected = false;
        },
        __serverEmit(event, payload, acknowledge) {
          const handler = handlers.get(event);
          if (handler) return handler(payload, acknowledge);
          return undefined;
        },
        __emitted: emitted,
      };
      queueMicrotask(() => socket.__serverEmit('connect'));
      window.__mcTestSocket = socket;
      return socket;
    }
    window.io = () => createSocket();
  })();
`;

function audioPolicy(ownerDeviceId, revision, assignment, playlistRevision = 'playlist-a') {
  return {
    version: 1,
    output_device_id: 'tv1',
    owner_device_id: ownerDeviceId,
    content_instance_id: assignment.content_instance_id,
    transaction_id: `audio-tx-${revision}`,
    // Content generation identifies the mounted media, whereas revision is
    // the monotonic owner-policy update. A late grant changes only revision.
    generation: assignment.content_generation || 1,
    revision,
    playlist_revision: playlistRevision,
  };
}

function videoAssignment(overrides = {}) {
  return {
    content_id: 'content-video-a',
    asset_id: 'content-video-a',
    filename: 'audio-fixture.wav',
    mime_type: 'video/mp4',
    asset_url: '/fixtures/audio-fixture.wav',
    content_instance_id: 'instance-video-a',
    content_generation: 1,
    duration_sec: 60,
    ...overrides,
  };
}

function liveSourceAssignment() {
  return {
    content_id: 'content-live-a',
    asset_id: 'content-live-a',
    filename: 'live-source.html',
    mime_type: 'text/html',
    remote_url: '/player/live-source.html?source=fixture',
    content_instance_id: 'instance-live-a',
    content_generation: 1,
    duration_sec: 60,
  };
}

function hlsAssignment() {
  return {
    content_id: 'content-hls-a',
    asset_id: 'content-hls-a',
    filename: 'hls.html',
    mime_type: 'text/html',
    remote_url: '/player/hls.html?station=fixture',
    content_instance_id: 'instance-hls-a',
    content_generation: 1,
    duration_sec: 60,
  };
}

function youtubeAssignment() {
  return {
    content_id: 'content-youtube-a',
    asset_id: 'content-youtube-a',
    filename: 'YouTube fixture',
    mime_type: 'video/youtube',
    remote_url: 'https://www.youtube.com/watch?v=test-video',
    content_instance_id: 'instance-youtube-a',
    content_generation: 1,
    duration_sec: 60,
  };
}

function playlistPayload({
  ownerDeviceId,
  revision,
  displayState = null,
  assignments = [videoAssignment()],
  playlistRevision = 'playlist-a',
}) {
  const assignment = assignments[0];
  return {
    assignments,
    playlist_revision: playlistRevision,
    audio_policy: audioPolicy(ownerDeviceId, revision, assignment, playlistRevision),
    display_state: displayState,
  };
}

async function bootManagedPlayer(page, deviceId = 'owner-a') {
  // Install before the parser reaches the player's socket bootstrap. The
  // static harness deliberately has no Socket.IO server; its request route is
  // retained as a resource-level guard, while this init script removes a
  // scheduler race between the managed auto-connect and the mocked library.
  await page.addInitScript(SOCKET_CLIENT);
  await page.route('**/socket.io/socket.io.js', (route) => route.fulfill({
    contentType: 'application/javascript',
    body: SOCKET_CLIENT,
  }));
  // A test page has no cache/version server. Prevent its production service
  // worker update hook from reloading the page during an ownership scenario.
  await page.route('**/player/sw.js', (route) => route.fulfill({
    status: 404,
    contentType: 'text/plain',
    body: 'test harness disables service worker',
  }));
  await page.route('**/fixtures/audio-fixture.wav', (route) => route.fulfill({
    contentType: 'audio/wav',
    body: SILENT_WAV,
  }));
  await page.route('**/player/news-stream**', (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({ source: `${ORIGIN}/fixtures/audio-fixture.wav` }),
  }));
  await page.addInitScript(({ id, origin }) => {
    const mutedDescriptor = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'muted');
    window.__mcMutedWrites = [];
    Object.defineProperty(HTMLMediaElement.prototype, 'muted', {
      configurable: true,
      enumerable: mutedDescriptor.enumerable,
      get() {
        return mutedDescriptor.get.call(this);
      },
      set(value) {
        window.__mcMutedWrites.push({
          id: this.id || null,
          value: Boolean(value),
          stack: new Error().stack,
        });
        return mutedDescriptor.set.call(this, value);
      },
    });
    window.AudioContext = class {
      constructor() { this.destination = {}; }
      resume() { return Promise.resolve(); }
      createBuffer() { return {}; }
      createBufferSource() { return { connect() {}, start() {} }; }
    };
    window.webkitAudioContext = window.AudioContext;
    window.__mcHostAudio = [];
    window.addEventListener('mbfd:audio-policy-state', (event) => {
      window.__mcHostAudio.push({
        audioAllowed: event.detail.audio_allowed,
        muted: event.detail.muted,
      });
    });
    window.mbfdKioskAudio = {
      confirmHostMuted: (state) => Promise.resolve({
        version: 1,
        confirmed: true,
        process_muted: true,
        ...state,
      }),
    };
    window.__playerConfig = {
      managedDisplay: {
        deviceId: id,
        deviceToken: 'test-token',
        deviceName: id,
        serverUrl: origin,
        audioEnabled: true,
      },
    };
  }, { id: deviceId, origin: ORIGIN });
  await page.goto(`${ORIGIN}/player/index.html`);
  await page.waitForFunction(() => window.__mcTestSocket);
}

async function emitPlaylist(page, payload) {
  await page.evaluate((nextPayload) => window.__mcTestSocket.__serverEmit('device:playlist-update', nextPayload), payload);
}

async function emitSocket(page, event, payload) {
  await page.evaluate(({ eventName, nextPayload }) => (
    window.__mcTestSocket.__serverEmit(eventName, nextPayload)
  ), { eventName: event, nextPayload: payload });
}

async function latestReportedState(page) {
  return page.evaluate(() => {
    const reports = window.__mcTestSocket.__emitted
      .filter((entry) => entry.event === 'device:state-report');
    const latest = reports.at(-1)?.args?.[0];
    return latest?.state || latest || null;
  });
}

async function prepareMountedVideoForRestore(page) {
  await page.locator('#playerContainer video').evaluate((video) => {
    Object.defineProperties(video, {
      readyState: { configurable: true, get: () => 4 },
      duration: { configurable: true, get: () => 60 },
      currentTime: { configurable: true, writable: true, value: 4 },
      paused: { configurable: true, get: () => false },
    });
  });
}

test('late owner grant does not let stale fail-muted display state re-mute the mounted HTML5 video', async ({ page }) => {
  await bootManagedPlayer(page);
  await emitPlaylist(page, playlistPayload({ ownerDeviceId: null, revision: 1 }));
  const video = page.locator('#playerContainer video');
  await expect(video).toHaveCount(1);
  const originalVideo = await video.elementHandle();
  await expect(video).toHaveJSProperty('muted', true);
  await prepareMountedVideoForRestore(page);
  await page.evaluate(() => { window.__mcMutedWrites.length = 0; });

  await emitPlaylist(page, playlistPayload({
    ownerDeviceId: 'owner-a',
    revision: 2,
    displayState: {
      current_content_id: 'content-video-a',
      current_asset_id: 'content-video-a',
      content_type: 'video',
      current_time: 4,
      paused: false,
      muted: true,
      state_revision: 5,
    },
  }));

  await page.waitForTimeout(180);
  expect(await originalVideo.evaluate((element) => (
    element.isConnected
    && element === document.querySelector('#playerContainer video')
    && element.muted === false
  ))).toBe(true);
  await expect(video).toHaveJSProperty('muted', false);
  const writes = await page.evaluate(() => window.__mcMutedWrites);
  expect(writes.some((entry) => (
    entry.value === false && entry.stack.includes('tryApplyMediaStateRestore')
  ))).toBe(true);
  expect(writes.filter((entry) => entry.value === true && entry.stack.includes('tryApplyMediaStateRestore'))).toEqual([]);
});

test('an operator mute remains effective across an authoritative owner-policy refresh', async ({ page }) => {
  await bootManagedPlayer(page);
  await emitPlaylist(page, playlistPayload({ ownerDeviceId: 'owner-a', revision: 1 }));
  const video = page.locator('#playerContainer video');
  await expect(video).toHaveJSProperty('muted', false);

  await emitSocket(page, 'device:remote-key', { keycode: 'KEYCODE_MENU' });
  await expect(video).toHaveJSProperty('muted', true);

  await emitPlaylist(page, playlistPayload({ ownerDeviceId: 'owner-a', revision: 2 }));
  await expect(video).toHaveJSProperty('muted', true);
  await expect.poll(() => page.evaluate(() => window.__mcHostAudio.at(-1))).toEqual({
    audioAllowed: true,
    muted: true,
  });
});

test('owner transfer keeps exactly one mounted HTML5 renderer audible', async ({ page, browser }) => {
  const contextB = await browser.newContext();
  const pageB = await contextB.newPage();
  try {
    await bootManagedPlayer(page, 'owner-a');
    await bootManagedPlayer(pageB, 'owner-b');
    const payloadA1 = playlistPayload({ ownerDeviceId: 'owner-a', revision: 1 });
    await emitPlaylist(page, payloadA1);
    await emitPlaylist(pageB, payloadA1);
    const videoA = page.locator('#playerContainer video');
    const videoB = pageB.locator('#playerContainer video');
    await expect(videoA).toHaveJSProperty('muted', false);
    await expect(videoB).toHaveJSProperty('muted', true);

    const payloadB2 = playlistPayload({ ownerDeviceId: 'owner-b', revision: 2 });
    await emitPlaylist(page, payloadB2);
    await emitPlaylist(pageB, payloadB2);
    await expect(videoA).toHaveJSProperty('muted', true);
    await expect(videoB).toHaveJSProperty('muted', false);
    const audibleCount = await Promise.all([videoA, videoB]
      .map((locator) => locator.evaluate((element) => Number(!element.muted))));
    expect(audibleCount.reduce((sum, value) => sum + value, 0)).toBe(1);
  } finally {
    await contextB.close();
  }
});

test('a persisted fail-muted report is legacy telemetry, not later operator intent', async ({ page }) => {
  await bootManagedPlayer(page);
  await emitPlaylist(page, playlistPayload({ ownerDeviceId: null, revision: 1 }));
  const video = page.locator('#playerContainer video');
  await expect(video).toHaveJSProperty('muted', true);
  await page.waitForFunction(() => window.__mcTestSocket.__emitted
    .some((entry) => entry.event === 'device:state-report'));
  const failMutedState = await latestReportedState(page);
  expect(failMutedState).toMatchObject({ muted: true });
  expect(failMutedState.operator_muted ?? null).toBeNull();

  await emitPlaylist(page, playlistPayload({
    ownerDeviceId: 'owner-a',
    revision: 2,
    displayState: failMutedState,
  }));
  await expect(video).toHaveJSProperty('muted', false);
});

test('explicit operator mute round-trips into a fresh authorized renderer', async ({ page, browser }) => {
  await bootManagedPlayer(page, 'owner-a');
  await emitPlaylist(page, playlistPayload({ ownerDeviceId: 'owner-a', revision: 1 }));
  await emitSocket(page, 'device:remote-key', { keycode: 'KEYCODE_MENU' });
  await page.waitForFunction(() => window.__mcTestSocket.__emitted
    .some((entry) => entry.event === 'device:state-report'
      && entry.args?.[0]?.state?.operator_muted === true));
  const persistedState = await latestReportedState(page);
  expect(persistedState).toMatchObject({ muted: true, operator_muted: true });

  const restoredContext = await browser.newContext();
  const restoredPage = await restoredContext.newPage();
  try {
    await bootManagedPlayer(restoredPage, 'owner-a');
    await emitPlaylist(restoredPage, playlistPayload({
      ownerDeviceId: 'owner-a',
      revision: 1,
      displayState: persistedState,
    }));
    await expect(restoredPage.locator('#playerContainer video')).toHaveJSProperty('muted', true);
    await expect.poll(() => restoredPage.evaluate(() => window.__mcHostAudio.at(-1))).toEqual({
      audioAllowed: true,
      muted: true,
    });
  } finally {
    await restoredContext.close();
  }
});

test('owner loss mutes every mounted renderer', async ({ page, browser }) => {
  const contextB = await browser.newContext();
  const pageB = await contextB.newPage();
  try {
    await bootManagedPlayer(page, 'owner-a');
    await bootManagedPlayer(pageB, 'owner-b');
    const ownerA = playlistPayload({ ownerDeviceId: 'owner-a', revision: 1 });
    await emitPlaylist(page, ownerA);
    await emitPlaylist(pageB, ownerA);
    await expect(page.locator('#playerContainer video')).toHaveJSProperty('muted', false);
    await expect(pageB.locator('#playerContainer video')).toHaveJSProperty('muted', true);

    const noOwner = playlistPayload({ ownerDeviceId: null, revision: 2 });
    await emitPlaylist(page, noOwner);
    await emitPlaylist(pageB, noOwner);
    await expect(page.locator('#playerContainer video')).toHaveJSProperty('muted', true);
    await expect(pageB.locator('#playerContainer video')).toHaveJSProperty('muted', true);
  } finally {
    await contextB.close();
  }
});

test('same-origin live-source iframe follows grant and owner-transfer mute fencing', async ({ page }) => {
  await bootManagedPlayer(page);
  const assignments = [liveSourceAssignment()];
  await emitPlaylist(page, playlistPayload({ ownerDeviceId: null, revision: 1, assignments }));
  const childVideo = page.frameLocator('#playerContainer iframe').locator('video');
  await expect(childVideo).toHaveCount(1);
  await expect(childVideo).toHaveJSProperty('muted', true);

  await emitPlaylist(page, playlistPayload({ ownerDeviceId: 'owner-a', revision: 2, assignments }));
  await expect(childVideo).toHaveJSProperty('muted', false);

  await emitPlaylist(page, playlistPayload({ ownerDeviceId: 'owner-b', revision: 3, assignments }));
  await expect(childVideo).toHaveJSProperty('muted', true);
});

test('same-origin HLS iframe follows grant and owner-transfer mute fencing', async ({ page }) => {
  await bootManagedPlayer(page);
  const assignments = [hlsAssignment()];
  await emitPlaylist(page, playlistPayload({ ownerDeviceId: null, revision: 1, assignments }));
  const childVideo = page.frameLocator('#playerContainer iframe').locator('video');
  await expect(childVideo).toHaveCount(1);
  await expect(childVideo).toHaveJSProperty('muted', true);

  await emitPlaylist(page, playlistPayload({ ownerDeviceId: 'owner-a', revision: 2, assignments }));
  await expect(childVideo).toHaveJSProperty('muted', false);

  await emitPlaylist(page, playlistPayload({ ownerDeviceId: 'owner-b', revision: 3, assignments }));
  await expect(childVideo).toHaveJSProperty('muted', true);
});

test('a transport seek cannot restore a fail-muted snapshot after a late owner grant', async ({ page }) => {
  await bootManagedPlayer(page);
  await emitPlaylist(page, playlistPayload({ ownerDeviceId: null, revision: 1 }));
  const video = page.locator('#playerContainer video');
  await expect(video).toHaveJSProperty('muted', true);
  await video.evaluate((element) => {
    element.__mcTestTime = 0;
    Object.defineProperties(element, {
      duration: { configurable: true, get: () => 60 },
      currentTime: {
        configurable: true,
        get: () => element.__mcTestTime,
        set: (value) => { element.__mcPendingTime = value; },
      },
      paused: { configurable: true, get: () => false },
    });
  });

  await emitSocket(page, 'device:command', {
    command_id: 'seek-race-1',
    action: 'seek',
    payload: { position_seconds: 10 },
    issued_at: new Date().toISOString(),
  });
  await page.waitForFunction(() => document.querySelector('#playerContainer video')?.__mcPendingTime === 10);
  await emitPlaylist(page, playlistPayload({ ownerDeviceId: 'owner-a', revision: 2 }));
  await video.evaluate((element) => {
    element.__mcTestTime = element.__mcPendingTime;
    element.dispatchEvent(new Event('seeked'));
  });
  await expect(video).toHaveJSProperty('muted', false);
});

test('mocked YouTube IFrame API keeps a valid owner audible despite legacy muted telemetry', async ({ page }) => {
  await page.route('https://www.youtube.com/iframe_api', (route) => route.fulfill({
    contentType: 'application/javascript',
    body: `
      window.__mcYtCalls = [];
      window.__mcYtPlayers = [];
      window.YT = {
        Player: class Player {
          constructor(id, options) {
            this.id = id; this.options = options; this.state = -1; this.time = 0;
            window.__mcYtPlayers.push(this);
            setTimeout(() => options.events.onReady({ target: this }), 0);
          }
          mute() { window.__mcYtCalls.push('mute'); this.muted = true; }
          unMute() { window.__mcYtCalls.push('unMute'); this.muted = false; }
          setVolume(value) { window.__mcYtCalls.push('volume:' + value); this.volume = value; }
          playVideo() { window.__mcYtCalls.push('play'); this.state = 1; }
          pauseVideo() { window.__mcYtCalls.push('pause'); this.state = 2; }
          seekTo(value) { window.__mcYtCalls.push('seek:' + value); this.time = value; }
          getPlayerState() { return this.state; }
          getCurrentTime() { return this.time; }
          getDuration() { return 60; }
          isMuted() { return !!this.muted; }
          destroy() { window.__mcYtCalls.push('destroy'); }
        },
      };
      setTimeout(() => window.onYouTubeIframeAPIReady && window.onYouTubeIframeAPIReady(), 0);
    `,
  }));
  await bootManagedPlayer(page);
  const assignments = [youtubeAssignment()];
  await emitPlaylist(page, playlistPayload({ ownerDeviceId: null, revision: 1, assignments }));
  await page.waitForFunction(() => window.__mcYtPlayers?.length === 1);
  await page.evaluate(() => { window.__mcYtCalls.length = 0; });

  await emitPlaylist(page, playlistPayload({
    ownerDeviceId: 'owner-a',
    revision: 2,
    assignments,
    displayState: {
      current_content_id: 'content-youtube-a',
      current_asset_id: 'content-youtube-a',
      content_type: 'youtube',
      current_time: 4,
      paused: false,
      muted: true,
      state_revision: 7,
    },
  }));
  await expect.poll(() => page.evaluate(() => window.__mcYtCalls)).toContain('unMute');
  expect(await page.evaluate(() => window.__mcYtCalls)).not.toContain('mute');
});
