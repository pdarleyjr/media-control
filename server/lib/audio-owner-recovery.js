'use strict';

const crypto = require('crypto');
const {
  buildAudioPolicy,
  isClassroomRendererDevice,
  maxPersistedAudioPolicyRevision,
  nextAudioPolicyRevision,
  orderedRendererDeviceIds,
  resolveDeterministicAudioOwner,
  stampPlaylistAudioPolicy,
  storedAudioPolicyForDevice,
} = require('./audio-ownership');
const { fenceAudioOwnershipTargets } = require('./audio-ownership-transaction');

function sameOwnershipSession(left, right) {
  if (!left || !right) return false;
  if (left.source_key || right.source_key) {
    return String(left.source_key || '') === String(right.source_key || '')
      && String(left.content_instance_id || '') === String(right.content_instance_id || '');
  }
  return String(left.transaction_id || '') === String(right.transaction_id || '');
}

async function recoverAudioOwnershipAfterLoss(options = {}) {
  const {
    database = null,
    namespace = null,
    lostDeviceId,
    buildPayload = null,
  } = options;
  const listWorkspaceDevices = options.listWorkspaceDevices || ((workspaceId) => database.prepare(`
    SELECT id, name, playlist_id
    FROM devices
    WHERE workspace_id = ?
  `).all(workspaceId).filter(isClassroomRendererDevice));
  const getStoredPolicy = options.getStoredPolicy
    || ((deviceId) => storedAudioPolicyForDevice(database, deviceId));
  const isOnline = options.isOnline || ((deviceId) => {
    const room = namespace?.adapter?.rooms?.get(deviceId);
    return Boolean(room && room.size > 0);
  });
  const fenceTargets = options.fenceTargets || (({ deviceIds, policy }) => (
    fenceAudioOwnershipTargets(namespace, { deviceIds, policy })
  ));
  const persistPolicy = options.persistPolicy || ((playlistId, policy) => (
    stampPlaylistAudioPolicy(database, playlistId, policy, policy.content_instance_id)
  ));
  const emitPolicyUpdate = options.emitPolicyUpdate || (() => {});
  const randomUUID = options.randomUUID || crypto.randomUUID;
  const now = options.now || Date.now;
  const persistedRevision = typeof options.persistedRevision === 'function'
    ? options.persistedRevision()
    : (options.persistedRevision ?? maxPersistedAudioPolicyRevision(database));

  const lostId = String(lostDeviceId || '').trim();
  const anchorId = String(options.anchorDeviceId || lostId).trim();
  if (!anchorId) return { recovered: false, reason: 'missing_lost_device_id' };
  const lostPolicy = getStoredPolicy(anchorId);
  if (!lostPolicy || (!options.allowUnowned && String(lostPolicy.owner_device_id || '') !== lostId)) {
    return { recovered: false, reason: 'lost_device_was_not_audio_owner' };
  }

  let workspaceId = options.workspaceId || null;
  if (!workspaceId && database) {
    workspaceId = database.prepare('SELECT workspace_id FROM devices WHERE id = ?').get(anchorId)?.workspace_id || null;
  }
  const devices = (listWorkspaceDevices(workspaceId) || []).filter(isClassroomRendererDevice);
  const participants = devices.filter((device) => sameOwnershipSession(
    getStoredPolicy(device.id),
    lostPolicy,
  ));
  const connectedIds = participants
    .map((device) => String(device.id))
    .filter((deviceId) => isOnline(deviceId));
  const eligibleOwnerIds = connectedIds
    .filter((deviceId) => !lostId || deviceId !== lostId);
  const replacementOwnerId = resolveDeterministicAudioOwner({
    targetDeviceIds: eligibleOwnerIds,
    preferredDeviceId: lostPolicy.output_device_id,
    orderedDeviceIds: orderedRendererDeviceIds(participants),
    onlineDeviceIds: eligibleOwnerIds,
  });
  const proposed = buildAudioPolicy({
    outputDeviceId: lostPolicy.output_device_id,
    ownerDeviceId: replacementOwnerId,
    contentInstanceId: lostPolicy.content_instance_id,
    transactionId: `audio-recovery:${randomUUID()}`,
    generation: lostPolicy.generation,
    revision: nextAudioPolicyRevision({ now, persistedRevision }),
    sourceKey: lostPolicy.source_key,
  });
  const fence = connectedIds.length > 0
    ? await fenceTargets({ deviceIds: connectedIds, policy: proposed })
    : {
        ok: false,
        acknowledged_device_ids: [],
        failed_device_ids: [],
        offline_device_ids: participants.map((device) => device.id),
        committed_policy: { ...proposed, owner_device_id: null },
      };
  const committed = fence.committed_policy || { ...proposed, owner_device_id: null };
  const stampedPlaylists = new Set();
  for (const device of participants) {
    if (!device.playlist_id || stampedPlaylists.has(device.playlist_id)) continue;
    if (persistPolicy(device.playlist_id, committed) === true) stampedPlaylists.add(device.playlist_id);
  }
  for (const device of participants) {
    if (!device.playlist_id || !stampedPlaylists.has(device.playlist_id)) continue;
    emitPolicyUpdate(device.id, buildPayload);
  }
  const recovered = fence.ok === true && Boolean(committed.owner_device_id);
  return {
    recovered,
    reason: recovered ? null : 'audio_recovery_failed_muted',
    lost_device_id: lostId || null,
    participant_device_ids: participants.map((device) => device.id),
    policy: committed,
    fence,
  };
}

async function ensureAudioOwnershipAfterReconnect(options = {}) {
  const deviceId = String(options.deviceId || '').trim();
  if (!deviceId) return { recovered: false, reason: 'missing_reconnected_device_id' };
  const getStoredPolicy = options.getStoredPolicy
    || ((targetId) => storedAudioPolicyForDevice(options.database, targetId));
  const isOnline = options.isOnline || ((targetId) => {
    const room = options.namespace?.adapter?.rooms?.get(targetId);
    return Boolean(room && room.size > 0);
  });
  const policy = getStoredPolicy(deviceId);
  if (!policy) return { recovered: false, reason: 'audio_policy_missing' };
  const ownerId = String(policy.owner_device_id || '').trim();
  if (ownerId && isOnline(ownerId)) {
    return { recovered: false, reason: 'audio_owner_already_online' };
  }
  return recoverAudioOwnershipAfterLoss({
    ...options,
    anchorDeviceId: deviceId,
    lostDeviceId: ownerId || null,
    allowUnowned: true,
  });
}

module.exports = {
  ensureAudioOwnershipAfterReconnect,
  recoverAudioOwnershipAfterLoss,
  sameOwnershipSession,
};
