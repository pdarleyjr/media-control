'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildPodiumSourceHealth,
  buildGuestPublisherHealth,
} = require('../../kamrui-media-edge/camera-api/live-source-health');

test('Podium health requires debounced Zowie HDMI, H.264 video, and embedded AAC before it is routable', () => {
  const physical = {
    deviceOnline: true,
    available: true,
    input: {
      signalPresent: true,
      audioDetected: true,
      resolution: '1920x1080',
      frameRate: 60,
    },
    lastUpdate: '2026-08-27T15:00:00.000Z',
    model: 'ZowieBox',
    firmware: 'test',
  };

  assert.deepEqual(
    buildPodiumSourceHealth(physical, {
      ready: true,
      tracks: ['H264', 'MPEG-4 Audio'],
    }),
    {
      deviceOnline: true,
      signalPresent: true,
      streamReady: true,
      available: true,
      resolution: '1920x1080',
      frameRate: 60,
      embeddedAudioDetected: true,
      lastUpdate: '2026-08-27T15:00:00.000Z',
      model: 'ZowieBox',
      firmware: 'test',
    },
  );

  assert.equal(
    buildPodiumSourceHealth(physical, { ready: true, tracks: ['MPEG-4 Audio'] }).available,
    false,
    'an HDMI lock cannot make a video-less MediaMTX path routable',
  );
  assert.equal(
    buildPodiumSourceHealth(physical, { ready: true, tracks: ['H265', 'MPEG-4 Audio'] }).available,
    false,
    'the deployed H.264/AAC contract does not silently accept a different video codec',
  );
  const videoWithoutAudio = buildPodiumSourceHealth(physical, {
    ready: true,
    tracks: ['H264'],
  });
  assert.equal(videoWithoutAudio.streamReady, true, 'video readiness is reported separately');
  assert.equal(videoWithoutAudio.embeddedAudioDetected, false);
  assert.equal(
    videoWithoutAudio.available,
    false,
    'a video-only path cannot make the computer source draggable or routable',
  );

  assert.equal(
    buildPodiumSourceHealth({ available: false }, { ready: false, tracks: [] }).deviceOnline,
    null,
    'an unconfigured or not-yet-polled ZowieBox is unknown, not fabricated as offline',
  );
});

test('Guest publisher health reports only MediaMTX-publisher facts and never invents laptop reachability', () => {
  assert.deepEqual(
    buildGuestPublisherHealth({
      ready: true,
      tracks: ['H264', 'MPEG-4 Audio'],
      readyTime: '2026-08-27T15:01:00.000Z',
    }),
    {
      deviceOnline: null,
      deviceObservable: false,
      publisherOnline: true,
      signalPresent: true,
      streamReady: true,
      available: true,
      resolution: null,
      frameRate: null,
      embeddedAudioDetected: true,
      lastUpdate: '2026-08-27T15:01:00.000Z',
    },
  );

  const unavailable = buildGuestPublisherHealth({
    ready: true,
    tracks: ['MPEG-4 Audio'],
    readyTime: '2026-08-27T15:01:00.000Z',
  });
  assert.equal(unavailable.publisherOnline, false);
  assert.equal(unavailable.signalPresent, false);
  assert.equal(unavailable.streamReady, false);
  assert.equal(unavailable.available, false);
  assert.equal(unavailable.deviceOnline, null);

  assert.equal(
    buildGuestPublisherHealth({ ready: true, tracks: ['H265', 'MPEG-4 Audio'] }).available,
    false,
    'Guest availability requires the configured H.264 contract',
  );
  const videoWithoutAudio = buildGuestPublisherHealth({
    ready: true,
    tracks: ['H264'],
  });
  assert.equal(videoWithoutAudio.streamReady, true, 'the publisher video fact remains observable');
  assert.equal(videoWithoutAudio.embeddedAudioDetected, false);
  assert.equal(
    videoWithoutAudio.available,
    false,
    'a video-only guest publisher is not healthy enough to route',
  );
});
