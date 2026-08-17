import test from 'node:test';
import assert from 'node:assert/strict';

import { mergeDisplayList, mergeDisplayRecord } from '../../frontend/js/services/display-state-revision.js';

test('stale REST state cannot overwrite a newer socket confirmation', () => {
  const current = {
    id: 'display-1', screen_on: true, command_revision: 'on-8', state_revision: 8,
  };
  const stale = {
    id: 'display-1', screen_on: false, command_revision: 'off-7', state_revision: 7,
  };
  assert.deepEqual(mergeDisplayRecord(current, stale), current);
});

test('newer socket state replaces an older REST snapshot', () => {
  const current = {
    id: 'display-1', screen_on: false, command_revision: 'off-7', state_revision: 7,
  };
  const incoming = {
    id: 'display-1', screen_on: true, command_revision: 'on-8', state_revision: 8,
  };
  assert.deepEqual(mergeDisplayRecord(current, incoming), incoming);
});

test('unrevisioned additive preview patches do not erase confirmed state', () => {
  const current = {
    id: 'display-1', screen_on: false, command_revision: 'off-7', state_revision: 7,
  };
  assert.deepEqual(mergeDisplayRecord(current, { screenshot_url: '/new.png' }), {
    ...current,
    screenshot_url: '/new.png',
  });
});

test('dashboard reload preserves only the latest confirmed member state', () => {
  const current = new Map([['display-1', {
    id: 'display-1', screen_on: true, command_revision: 'on-9', state_revision: 9,
  }]]);
  const merged = mergeDisplayList(current, [{
    id: 'display-1', screen_on: false, command_revision: 'off-8', state_revision: 8,
  }]);
  assert.equal(merged.get('display-1').screen_on, true);
  assert.equal(merged.get('display-1').command_revision, 'on-9');
});

