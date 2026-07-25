'use strict';

const { db } = require('../db/database');
const { liveStreamDeviceId, liveStreamProgramState } = require('./live-stream-display');
const deviceContract = require('../player/device-contract');

const liveStreamSlideState = new Map();

function syncLiveStreamToConfirmedSlide(deviceNs, deviceId, state) {
  if (!state || state.slide_index == null) return { synced: false, reason: 'no_slide_index' };
  const device = db.prepare('SELECT workspace_id FROM devices WHERE id = ?').get(deviceId);
  if (!device || !device.workspace_id) return { synced: false, reason: 'device_not_found' };
  const liveState = liveStreamProgramState(device.workspace_id);
  if (!liveState.content_active) return { synced: false, reason: 'stream_not_active' };
  const liveDeviceId = liveStreamDeviceId(device.workspace_id);
  if (liveDeviceId === deviceId) return { synced: false, reason: 'self_report' };
  const lastSynced = liveStreamSlideState.get(liveDeviceId);
  if (lastSynced && lastSynced.slideIndex === state.slide_index && lastSynced.revision === state.state_revision) {
    return { synced: false, reason: 'already_synced' };
  }
  const slideEnvelope = deviceContract.createCommand({
    command_id: `sync-${deviceId}-${Date.now()}`,
    device_id: liveDeviceId,
    payload: { action: 'go_to_slide', slide: state.slide_index },
    target_scope: 'display',
  });
  const room = deviceNs.adapter.rooms.get(liveDeviceId);
  if (room && room.size > 0) {
    deviceNs.to(liveDeviceId).emit('device:command', slideEnvelope);
    liveStreamSlideState.set(liveDeviceId, { slideIndex: state.slide_index, revision: state.state_revision });
    return { synced: true, slideIndex: state.slide_index, revision: state.state_revision };
  }
  return { synced: false, reason: 'stream_device_offline' };
}

function resetSlideSyncState(liveDeviceId) {
  if (liveDeviceId) {
    liveStreamSlideState.delete(liveDeviceId);
  } else {
    liveStreamSlideState.clear();
  }
}

function getSlideSyncState(liveDeviceId) {
  return liveStreamSlideState.get(liveDeviceId) || null;
}

module.exports = {
  syncLiveStreamToConfirmedSlide,
  resetSlideSyncState,
  getSlideSyncState,
};
