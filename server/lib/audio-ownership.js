'use strict';

const FRONT_LEFT_NAMES = new Set([
  'front left',
  'classroom 1 - front left',
  'classroom1 - front left',
]);

function id(value) {
  const normalized = String(value || '').trim();
  return normalized || null;
}

function uniqueIds(values) {
  return [...new Set((Array.isArray(values) ? values : []).map(id).filter(Boolean))];
}

function physicalRoleRank(name) {
  const normalized = String(name || '').trim().toLowerCase().replace(/\s+/g, ' ');
  if (normalized.includes('front left')) return 0;
  if (normalized.includes('front center')) return 1;
  if (normalized.includes('front right')) return 2;
  if (normalized.includes('side left')) return 3;
  if (normalized.includes('side right')) return 4;
  return 100;
}

function isClassroomRendererDevice(device) {
  return Boolean(device && id(device.id) && physicalRoleRank(device.name) < 100);
}

function orderedRendererDeviceIds(devices) {
  return (Array.isArray(devices) ? devices : [])
    .filter(isClassroomRendererDevice)
    .map((device, index) => ({ device, index }))
    .sort((left, right) => (
      physicalRoleRank(left.device.name) - physicalRoleRank(right.device.name)
      || String(left.device.name || '').localeCompare(String(right.device.name || ''))
      || id(left.device.id).localeCompare(id(right.device.id))
      || left.index - right.index
    ))
    .map(({ device }) => id(device.id));
}

function resolvePhysicalAudioOutputDeviceId(devices) {
  const display = (Array.isArray(devices) ? devices : []).find((candidate) => (
    candidate
    && id(candidate.id)
    && FRONT_LEFT_NAMES.has(String(candidate.name || '').trim().toLowerCase().replace(/\s+/g, ' '))
  ));
  return display ? id(display.id) : null;
}

function resolveDeterministicAudioOwner({
  targetDeviceIds,
  preferredDeviceId,
  orderedDeviceIds,
  onlineDeviceIds,
} = {}) {
  const targets = uniqueIds(targetDeviceIds);
  if (!targets.length) return null;
  const targetSet = new Set(targets);
  const hasOnlineFilter = Array.isArray(onlineDeviceIds);
  const onlineTargets = uniqueIds(onlineDeviceIds).filter((deviceId) => targetSet.has(deviceId));
  if (hasOnlineFilter && onlineTargets.length === 0) return null;
  const candidates = hasOnlineFilter ? onlineTargets : targets;
  const candidateSet = new Set(candidates);
  const preferred = id(preferredDeviceId);
  if (preferred && candidateSet.has(preferred)) return preferred;

  const stableOrder = uniqueIds(orderedDeviceIds).filter((deviceId) => candidateSet.has(deviceId));
  const orderedSet = new Set(stableOrder);
  stableOrder.push(...candidates.filter((deviceId) => !orderedSet.has(deviceId)).sort());
  return stableOrder[0] || null;
}

function finiteNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function positiveSafeInteger(value) {
  const number = finiteNumber(value);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}

function hasValidAudioPolicyEpoch(policy) {
  return Boolean(
    policy
    && Number(policy.version) === 1
    && id(policy.output_device_id)
    && id(policy.content_instance_id)
    && id(policy.transaction_id)
    && positiveSafeInteger(policy.generation) !== null
    && positiveSafeInteger(policy.revision) !== null,
  );
}

function buildAudioPolicy({
  outputDeviceId,
  ownerDeviceId,
  contentInstanceId,
  transactionId,
  generation,
  revision,
  sourceKey,
} = {}) {
  const normalizedSourceKey = id(sourceKey);
  return {
    version: 1,
    output_device_id: id(outputDeviceId),
    owner_device_id: id(ownerDeviceId),
    content_instance_id: id(contentInstanceId),
    transaction_id: id(transactionId),
    generation: positiveSafeInteger(generation),
    revision: positiveSafeInteger(revision),
    ...(normalizedSourceKey ? { source_key: normalizedSourceKey } : {}),
  };
}

function policyForDevice(policy, deviceId, playlistRevision = null) {
  if (!policy || typeof policy !== 'object' || Number(policy.version) !== 1) return null;
  const normalized = buildAudioPolicy({
    outputDeviceId: policy.output_device_id,
    ownerDeviceId: policy.owner_device_id,
    contentInstanceId: policy.content_instance_id,
    transactionId: policy.transaction_id,
    generation: policy.generation,
    revision: policy.revision,
    sourceKey: policy.source_key,
  });
  if (!hasValidAudioPolicyEpoch(normalized)) return null;
  const audioAllowed = Boolean(normalized.owner_device_id)
    && normalized.owner_device_id === id(deviceId);
  return {
    ...normalized,
    ...(playlistRevision ? { playlist_revision: String(playlistRevision) } : {}),
    audio_allowed: audioAllowed,
    force_muted: !audioAllowed,
  };
}

let lastIssuedRevision = 0;

function nextAudioPolicyRevision({ now = Date.now, persistedRevision = 0 } = {}) {
  const wallClockRevision = Math.trunc((Number(now()) || Date.now()) * 1000);
  lastIssuedRevision = Math.max(
    wallClockRevision,
    lastIssuedRevision + 1,
    (positiveSafeInteger(persistedRevision) || 0) + 1,
  );
  return lastIssuedRevision;
}

function commonAudioPolicyFromAssignments(assignments) {
  const items = Array.isArray(assignments) ? assignments : [];
  if (items.length === 0) return null;
  const policies = items.map((item) => item?.audio_policy);
  if (policies.some((policy) => !hasValidAudioPolicyEpoch(policy))) return null;
  const first = policies[0];
  const keys = [
    'transaction_id',
    'content_instance_id',
    'owner_device_id',
    'output_device_id',
    'generation',
    'revision',
    'source_key',
  ];
  if (!policies.every((policy) => keys.every((key) => (
    String(policy[key] ?? '') === String(first[key] ?? '')
  )))) return null;
  return buildAudioPolicy({
    outputDeviceId: first.output_device_id,
    ownerDeviceId: first.owner_device_id,
    contentInstanceId: first.content_instance_id,
    transactionId: first.transaction_id,
    generation: first.generation,
    revision: first.revision,
    sourceKey: first.source_key,
  });
}

function parsePublishedAssignments(raw) {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function audioPolicyCanReplaceAssignments(assignments, policy) {
  const proposed = buildAudioPolicy({
    outputDeviceId: policy?.output_device_id,
    ownerDeviceId: policy?.owner_device_id,
    contentInstanceId: policy?.content_instance_id,
    transactionId: policy?.transaction_id,
    generation: policy?.generation,
    revision: policy?.revision,
    sourceKey: policy?.source_key,
  });
  if (!hasValidAudioPolicyEpoch(proposed)) return false;
  const storedRevisions = (Array.isArray(assignments) ? assignments : [])
    .map((item) => positiveSafeInteger(item?.audio_policy?.revision))
    .filter((revision) => revision !== null);
  if (storedRevisions.length > 0) {
    const maximumStoredRevision = Math.max(...storedRevisions);
    if (proposed.revision > maximumStoredRevision) return true;
    if (proposed.revision < maximumStoredRevision) return false;
  }
  const current = commonAudioPolicyFromAssignments(assignments);
  if (!current) return storedRevisions.length === 0;
  return [
    'output_device_id',
    'owner_device_id',
    'content_instance_id',
    'transaction_id',
    'generation',
    'revision',
    'source_key',
  ].every((key) => String(proposed[key] ?? '') === String(current[key] ?? ''));
}

function canReplacePlaylistAudioPolicy(database, playlistId, policy) {
  if (!database || typeof database.prepare !== 'function' || !id(playlistId)) return false;
  try {
    const row = database.prepare('SELECT published_snapshot FROM playlists WHERE id = ?').get(id(playlistId));
    return Boolean(row) && audioPolicyCanReplaceAssignments(
      parsePublishedAssignments(row.published_snapshot),
      policy,
    );
  } catch {
    return false;
  }
}

function maxPersistedAudioPolicyRevision(database) {
  if (!database || typeof database.prepare !== 'function') return 0;
  let maximum = 0;
  try {
    const rows = database.prepare(`
      SELECT published_snapshot FROM playlists
      WHERE published_snapshot IS NOT NULL AND published_snapshot != ''
    `).all();
    for (const row of rows) {
      const assignments = parsePublishedAssignments(row.published_snapshot);
      for (const assignment of assignments) {
        maximum = Math.max(
          maximum,
          positiveSafeInteger(assignment?.audio_policy?.revision) || 0,
        );
      }
    }
  } catch {
    return maximum;
  }
  return maximum;
}

function stampPlaylistAudioPolicy(database, playlistId, policy, contentInstanceId = null) {
  if (!database || typeof database.prepare !== 'function' || !id(playlistId)) return false;
  const row = database.prepare('SELECT published_snapshot FROM playlists WHERE id = ?').get(id(playlistId));
  if (!row) return false;
  const assignments = parsePublishedAssignments(row.published_snapshot);
  if (assignments.length === 0) return false;
  const normalized = buildAudioPolicy({
    outputDeviceId: policy?.output_device_id,
    ownerDeviceId: policy?.owner_device_id,
    contentInstanceId: policy?.content_instance_id || contentInstanceId,
    transactionId: policy?.transaction_id,
    generation: policy?.generation,
    revision: policy?.revision,
    sourceKey: policy?.source_key,
  });
  const instanceId = id(contentInstanceId) || normalized.content_instance_id;
  if (!normalized.transaction_id || normalized.revision === null || !instanceId) return false;
  if (!audioPolicyCanReplaceAssignments(assignments, normalized)) return false;
  const stamped = assignments.map((item) => ({
    ...item,
    content_instance_id: instanceId,
    audio_policy: { ...normalized, content_instance_id: instanceId },
  }));
  database.prepare(`
    UPDATE playlists
    SET published_snapshot = ?, updated_at = strftime('%s','now')
    WHERE id = ?
  `).run(JSON.stringify(stamped), id(playlistId));
  return true;
}

function storedAudioPolicyForDevice(database, deviceId) {
  if (!database || typeof database.prepare !== 'function' || !id(deviceId)) return null;
  try {
    const row = database.prepare(`
      SELECT p.published_snapshot
      FROM devices d
      LEFT JOIN playlists p ON p.id = d.playlist_id
      WHERE d.id = ?
    `).get(id(deviceId));
    const common = commonAudioPolicyFromAssignments(parsePublishedAssignments(row?.published_snapshot));
    return common ? policyForDevice(common, id(deviceId)) : null;
  } catch {
    return null;
  }
}

function findAudioPolicyParticipants(database, { workspaceId, sourceKey, playlistId = null } = {}) {
  if (!database || typeof database.prepare !== 'function' || !id(workspaceId)) return [];
  try {
    const rows = database.prepare(`
      SELECT d.id, d.name, d.playlist_id, p.published_snapshot
      FROM devices d
      LEFT JOIN playlists p ON p.id = d.playlist_id
      WHERE d.workspace_id = ?
    `).all(id(workspaceId));
    return rows.filter((row) => {
      if (!isClassroomRendererDevice(row)) return false;
      if (id(playlistId) && id(row.playlist_id) === id(playlistId)) return true;
      const policy = commonAudioPolicyFromAssignments(parsePublishedAssignments(row.published_snapshot));
      return Boolean(id(sourceKey) && id(policy?.source_key) === id(sourceKey));
    }).map((row) => id(row.id));
  } catch {
    return [];
  }
}

function audioPolicyHeartbeatDecision(authoritativePolicy, reportedState) {
  const reported = reportedState && typeof reportedState === 'object' ? reportedState : {};
  if (!authoritativePolicy) {
    const claimsAudio = reported.audio_allowed === true || reported.muted === false;
    return claimsAudio
      ? { clamp: true, reason: 'authoritative_audio_policy_missing' }
      : { clamp: false, reason: null };
  }
  const identityMatches = (
    String(reported.transaction_id || '') === String(authoritativePolicy.transaction_id || '')
    && String(reported.content_instance_id || '') === String(authoritativePolicy.content_instance_id || '')
    && finiteNumber(reported.revision) === finiteNumber(authoritativePolicy.revision)
    && finiteNumber(reported.generation) === finiteNumber(authoritativePolicy.generation)
    && String(reported.playlist_revision || '') === String(authoritativePolicy.playlist_revision || '')
  );
  if (!identityMatches) return { clamp: true, reason: 'audio_policy_identity_mismatch' };
  if (authoritativePolicy.audio_allowed !== true
      && (reported.audio_allowed === true || reported.muted === false)) {
    return { clamp: true, reason: 'renderer_unmuted_without_authority' };
  }
  return { clamp: false, reason: null };
}

module.exports = {
  audioPolicyCanReplaceAssignments,
  audioPolicyHeartbeatDecision,
  buildAudioPolicy,
  canReplacePlaylistAudioPolicy,
  commonAudioPolicyFromAssignments,
  findAudioPolicyParticipants,
  isClassroomRendererDevice,
  maxPersistedAudioPolicyRevision,
  nextAudioPolicyRevision,
  orderedRendererDeviceIds,
  policyForDevice,
  resolveDeterministicAudioOwner,
  resolvePhysicalAudioOutputDeviceId,
  stampPlaylistAudioPolicy,
  storedAudioPolicyForDevice,
};
