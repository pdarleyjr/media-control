function uniqueIds(values) {
  return [...new Set((Array.isArray(values) ? values : []).filter(Boolean).map(String))];
}

function wallMemberIds(wall) {
  return uniqueIds((wall?.devices || []).map((member) => member?.device_id));
}

function preferredPlayerDeviceId(memberIds, authoredLeaderId, byId) {
  const ids = uniqueIds(memberIds);
  if (ids.length === 0) return null;
  const preferred = authoredLeaderId && ids.includes(String(authoredLeaderId))
    ? String(authoredLeaderId)
    : ids[0];
  if (byId.get(preferred)?.online !== false) return preferred;
  return ids.find((id) => byId.get(id)?.online !== false) || preferred;
}

function addTarget(targets, key, target) {
  if (!key || !target?.deviceId) return;
  targets.set(key, { key, ...target });
}

/**
 * Describe the visible logical playback surfaces that own passive live previews.
 * Operator selection is deliberately absent: it controls transport/highlight
 * state, never whether a program has a mounted preview session.
 */
export function buildLivePreviewTargets({
  displays = [],
  walls = [],
  byId = new Map(),
  selectedIds = [],
} = {}) {
  const targets = new Map();
  const selected = new Set(uniqueIds(selectedIds));

  for (const display of displays) {
    if (!display?.id || !selected.has(String(display.id))) continue;
    const deviceId = String(display.id);
    addTarget(targets, `display:${deviceId}`, {
      kind: 'display',
      deviceId,
      memberIds: [deviceId],
    });
  }

  for (const wall of walls) {
    if (!wall?.id) continue;
    const wallId = String(wall.id);
    const members = wallMemberIds(wall);
    if (members.length === 0) continue;

    if (wall.layout_mode === 'groups') {
      for (const group of (wall.layout?.groups || [])) {
        if (!group?.id) continue;
        const groupMembers = uniqueIds(group.member_ids).filter((id) => members.includes(id));
        const deviceId = preferredPlayerDeviceId(groupMembers, group.leader_device_id, byId);
        addTarget(targets, `wall-group:${wallId}:${group.id}`, {
          kind: 'wall-group',
          wallId,
          groupId: String(group.id),
          deviceId,
          memberIds: groupMembers,
        });
      }
      continue;
    }

    if (wall.layout_mode === 'split') {
      const regions = (wall.layout?.regions || [])
        .filter((region) => region?.enabled !== false && region?.id)
        .filter((region) => !region.player_device_id || members.includes(String(region.player_device_id)));
      if (members.length === 1 && (regions.length > 0 || Number(wall.grid_cols) > 1)) {
        addTarget(targets, `wall-regions:${wallId}`, {
          kind: 'wall-regions',
          wallId,
          deviceId: members[0],
          memberIds: members,
          regionIds: regions.map((region) => String(region.id)),
        });
        continue;
      }
      for (const deviceId of members) {
        addTarget(targets, `wall-split:${wallId}:${deviceId}`, {
          kind: 'wall-split',
          wallId,
          deviceId,
          memberIds: [deviceId],
        });
      }
      continue;
    }

    const deviceId = preferredPlayerDeviceId(members, wall.leader_device_id, byId);
    addTarget(targets, `wall:${wallId}`, {
      kind: 'wall',
      wallId,
      deviceId,
      memberIds: members,
    });
  }

  return targets;
}

export function livePreviewTargetDeviceIds(targets) {
  if (!(targets instanceof Map)) return [];
  return uniqueIds([...targets.values()].map((target) => target?.deviceId));
}
