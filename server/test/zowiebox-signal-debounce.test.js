'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createSignalDebouncer,
  normalizeZowieInput,
} = require('../../kamrui-media-edge/camera-api/live-source-health');

test('ZowieBox HDMI input normalization requires device response, HDMI lock, and input presence', () => {
  assert.deepEqual(
    normalizeZowieInput({
      hdmi_signal: 1,
      audio_signal: 1,
      width: 1920,
      height: 1080,
      framerate: 59.94,
      gsv2001: { input_exist: 1 },
    }),
    {
      signalPresent: true,
      audioDetected: true,
      width: 1920,
      height: 1080,
      frameRate: 59.94,
      resolution: '1920x1080',
    },
  );
  assert.equal(normalizeZowieInput({ hdmi_signal: 1, gsv2001: { input_exist: 0 } }).signalPresent, false);
  assert.equal(normalizeZowieInput(null).signalPresent, false);
});

test('Guest Computer becomes visible after signal-on debounce and hides after the longer loss debounce', () => {
  const debounce = createSignalDebouncer({ signalOnMs: 2_000, signalOffMs: 5_000 });

  assert.equal(debounce.update(true, 1_000).available, false);
  assert.equal(debounce.update(true, 2_999).available, false);
  assert.equal(debounce.update(true, 3_000).available, true);
  assert.equal(debounce.update(false, 3_100).available, true);
  assert.equal(debounce.update(false, 8_099).available, true);
  assert.equal(debounce.update(false, 8_100).available, false);
});

test('signal flaps reset the pending transition instead of creating duplicate source identities', () => {
  const debounce = createSignalDebouncer({ signalOnMs: 1_000, signalOffMs: 3_000 });

  debounce.update(true, 0);
  debounce.update(false, 500);
  assert.equal(debounce.update(true, 900).available, false);
  assert.equal(debounce.update(true, 1_900).available, true);
  assert.equal(debounce.snapshot().transitionCount, 1);
});
