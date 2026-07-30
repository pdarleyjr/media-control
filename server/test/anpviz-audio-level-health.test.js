'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  classifyAudioLevel,
  parseVolumeDetect,
} = require('../../kamrui-media-edge/camera-api/audio-level-health');

test('parses FFmpeg volumedetect output without depending on localized spacing', () => {
  const parsed = parseVolumeDetect(`
    [Parsed_volumedetect_0 @ 0x01] mean_volume: -31.4 dB
    [Parsed_volumedetect_0 @ 0x01] max_volume: -4.8 dB
  `);

  assert.deepEqual(parsed, {
    meanDb: -31.4,
    peakDb: -4.8,
  });
});

test('classifies active, silent, clipping, and unavailable audio conservatively', () => {
  assert.deepEqual(
    classifyAudioLevel({ meanDb: -28, peakDb: -6 }),
    { status: 'detected', audioDetected: true, silenceDetected: false, clipping: false },
  );
  assert.deepEqual(
    classifyAudioLevel({ meanDb: -72, peakDb: -61 }),
    { status: 'silent', audioDetected: false, silenceDetected: true, clipping: false },
  );
  assert.deepEqual(
    classifyAudioLevel({ meanDb: -8, peakDb: -0.4 }),
    { status: 'clipping', audioDetected: true, silenceDetected: false, clipping: true },
  );
  assert.deepEqual(
    classifyAudioLevel(null),
    { status: 'unavailable', audioDetected: false, silenceDetected: false, clipping: false },
  );
});
