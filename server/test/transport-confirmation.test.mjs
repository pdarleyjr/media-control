import test from 'node:test';
import assert from 'node:assert/strict';

import { matchesExpectedTransportState } from '../../frontend/js/views/media-control/transport-confirmation.js';

const entry = {
  commandId: 'command-3',
  deviceId: 'display-1',
  action: 'go_to_slide',
  payload: { slide: 3 },
  contentInstanceId: 'deck-content-1',
};

test('slide confirmation accepts camel-case live-store state for the exact command', () => {
  assert.equal(matchesExpectedTransportState(entry, {
    device_id: 'display-1',
    content_instance_id: 'deck-content-1',
    slideIndex: 3,
    command_revision: 'command-3',
  }), true);
});

test('slide confirmation accepts a matching content id when the renderer instance id is distinct', () => {
  assert.equal(matchesExpectedTransportState(entry, {
    device_id: 'display-1',
    content_instance_id: 'assignment-instance-9',
    current_content_id: 'deck-content-1',
    slide_index: 3,
    command_revision: 'command-3',
  }), true);
});

test('slide confirmation rejects stale command, wrong content, wrong device, and wrong slide state', () => {
  assert.equal(matchesExpectedTransportState(entry, {
    device_id: 'display-1', current_content_id: 'deck-content-1', slide_index: 3, command_revision: 'older-command',
  }), false);
  assert.equal(matchesExpectedTransportState(entry, {
    device_id: 'display-1', current_content_id: 'other-deck', slide_index: 3, command_revision: 'command-3',
  }), false);
  assert.equal(matchesExpectedTransportState(entry, {
    device_id: 'display-2', current_content_id: 'deck-content-1', slide_index: 3, command_revision: 'command-3',
  }), false);
  assert.equal(matchesExpectedTransportState(entry, {
    device_id: 'display-1', current_content_id: 'deck-content-1', slide_index: 2, command_revision: 'command-3',
  }), false);
  assert.equal(matchesExpectedTransportState(entry, {
    device_id: 'display-1', slide_index: 3, command_revision: 'command-3',
  }), false);
});
