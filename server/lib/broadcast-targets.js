'use strict';

const LIVE_STREAM_DEVICE_PREFIX = 'live-stream-program-';

function isExplicitRevision(value) {
  return value !== undefined
    && value !== null
    && value !== ''
    && Number.isInteger(Number(value))
    && Number(value) >= 0;
}

function isManagedLiveStreamTarget(id) {
  return String(id || '').startsWith(LIVE_STREAM_DEVICE_PREFIX);
}

function layoutConflict(wallId, expectedRevision, currentRevision, error = 'Wall topology changed; refresh targets and try again') {
  return {
    ok: false,
    status: 409,
    targets: [],
    body: {
      error,
      code: 'LAYOUT_REVISION_CONFLICT',
      wall_id: wallId || null,
      expected_revision: isExplicitRevision(expectedRevision) ? Number(expectedRevision) : null,
      current_revision: isExplicitRevision(currentRevision) ? Number(currentRevision) : null,
    },
  };
}

function typedTargetError(error) {
  return { ok: false, status: 400, targets: [], body: { error } };
}

function typedTargetNotFound(type, id) {
  return {
    ok: false,
    status: 404,
    targets: [],
    body: { error: `${type} ${id} no longer exists; refresh targets and try again`, code: 'TARGET_NOT_FOUND' },
  };
}

function resolveTypedBroadcastTargets({ db, refs, workspaceId }) {
  if (!Array.isArray(refs)) return typedTargetError('targets must be an array');

  const resolved = [];
  const seen = new Set();
  const add = (id) => {
    const normalized = String(id || '');
    if (normalized && !seen.has(normalized)) {
      seen.add(normalized);
      resolved.push(normalized);
    }
  };

  const loadWall = (wallId, expectedRevision) => {
    const wall = db.prepare(`
      SELECT id, workspace_id, layout_revision, layout_json
      FROM video_walls WHERE id = ?
    `).get(wallId);
    if (!wall) return { error: layoutConflict(wallId, expectedRevision, null, 'Wall topology no longer exists; refresh targets and try again') };
    if (wall.workspace_id !== workspaceId) {
      return { error: { ok: false, status: 403, targets: [], body: { error: `Wall ${wallId} is not in this workspace` } } };
    }
    if (!isExplicitRevision(wall.layout_revision)) {
      return { error: layoutConflict(wallId, expectedRevision, null, 'Wall topology revision is unavailable; refresh targets and try again') };
    }
    const currentRevision = Number(wall.layout_revision);
    if (!isExplicitRevision(expectedRevision) || Number(expectedRevision) !== currentRevision) {
      return { error: layoutConflict(wallId, expectedRevision, currentRevision) };
    }
    const members = db.prepare(`
      SELECT vwd.device_id, d.workspace_id
      FROM video_wall_devices vwd
      JOIN devices d ON d.id = vwd.device_id
      WHERE vwd.wall_id = ?
    `).all(wallId);
    if (!members.length || members.some((member) => member.workspace_id !== workspaceId)) {
      return { error: layoutConflict(wallId, expectedRevision, currentRevision, 'Wall topology is incomplete; refresh targets and try again') };
    }
    return { wall, members, currentRevision };
  };

  for (const ref of refs) {
    if (!ref || typeof ref !== 'object' || Array.isArray(ref)) {
      return typedTargetError('Each target must be a typed object');
    }
    const type = String(ref.type || '').trim().toLowerCase().replace(/_/g, '-');
    if (type === 'display') {
      const id = String(ref.id || '');
      if (!id) return typedTargetError('Display targets require id');
      const device = db.prepare('SELECT id, workspace_id FROM devices WHERE id = ?').get(id);
      if (!device) return typedTargetNotFound('Display', id);
      if (device.workspace_id !== workspaceId) {
        return { ok: false, status: 403, targets: [], body: { error: `Device ${id} is not in this workspace` } };
      }
      add(id);
      continue;
    }

    if (type === 'group' || type === 'device-group') {
      const groupId = String(ref.id || ref.group_id || '');
      if (!groupId) return typedTargetError('Device-group targets require id');
      const group = db.prepare('SELECT id, workspace_id FROM device_groups WHERE id = ?').get(groupId);
      if (!group) return typedTargetNotFound('Device group', groupId);
      if (group.workspace_id !== workspaceId) {
        return { ok: false, status: 403, targets: [], body: { error: `Device group ${groupId} is not in this workspace` } };
      }
      const members = db.prepare(`
        SELECT dgm.device_id, d.workspace_id
        FROM device_group_members dgm
        LEFT JOIN devices d ON d.id = dgm.device_id
        WHERE dgm.group_id = ?
      `).all(groupId);
      if (!members.length || members.some((member) => member.workspace_id !== workspaceId)) {
        return { ok: false, status: 409, targets: [], body: { error: 'Device-group membership is empty or inconsistent', code: 'TOPOLOGY_CONFLICT' } };
      }
      members.forEach((member) => add(member.device_id));
      continue;
    }

    if (type === 'wall' || type === 'wall-group') {
      const wallId = String(type === 'wall' ? ref.id : ref.wall_id || '');
      if (!wallId) return typedTargetError(`${type} targets require ${type === 'wall' ? 'id' : 'wall_id'}`);
      const loaded = loadWall(wallId, ref.layout_revision);
      if (loaded.error) return loaded.error;

      if (type === 'wall') {
        loaded.members.forEach((member) => add(member.device_id));
        continue;
      }

      const groupId = String(ref.group_id || ref.id || '');
      if (!groupId) return typedTargetError('Wall-group targets require group_id');
      let layout;
      try {
        layout = loaded.wall.layout_json ? JSON.parse(loaded.wall.layout_json) : null;
      } catch (_) {
        layout = null;
      }
      const layoutGroups = Array.isArray(layout?.groups) ? layout.groups : [];
      const currentMemberIds = new Set(loaded.members.map((member) => String(member.device_id)));
      const layoutMemberIds = layoutGroups.flatMap((candidate) => (
        Array.isArray(candidate?.member_ids) ? candidate.member_ids.map(String) : []
      ));
      const layoutMemberSet = new Set(layoutMemberIds);
      const completeCurrentLayout = layoutGroups.length > 0
        && layoutGroups.every((candidate) => Array.isArray(candidate?.member_ids) && candidate.member_ids.length > 0)
        && layoutMemberSet.size === layoutMemberIds.length
        && layoutMemberSet.size === currentMemberIds.size
        && [...currentMemberIds].every((id) => layoutMemberSet.has(id));
      if (!completeCurrentLayout) {
        return layoutConflict(wallId, ref.layout_revision, loaded.currentRevision, 'Wall-group topology no longer exists; refresh targets and try again');
      }
      const group = layoutGroups.find((candidate) => String(candidate?.id || '') === groupId);
      const memberIds = Array.isArray(group?.member_ids) ? group.member_ids.map(String) : [];
      if (!group || !memberIds.length || memberIds.some((id) => !currentMemberIds.has(id))) {
        return layoutConflict(wallId, ref.layout_revision, loaded.currentRevision, 'Wall-group topology no longer exists; refresh targets and try again');
      }
      memberIds.forEach(add);
      continue;
    }

    return typedTargetError(`Unsupported target type: ${ref.type || '(missing)'}`);
  }

  return { ok: true, targets: resolved };
}

function resolveBroadcastTargets({ db, requestedIds, workspaceId, allowLiveStream = false }) {
  const requested = [...new Set((requestedIds || []).map(String))];
  const targets = [];
  const missing = [];

  for (const id of requested) {
    if (isManagedLiveStreamTarget(id) && allowLiveStream !== true) {
      return {
        ok: false,
        status: 400,
        body: {
          error: 'The live-stream program target requires explicit inclusion',
          code: 'LIVE_STREAM_CONFIRMATION_REQUIRED',
        },
      };
    }
    const device = db.prepare('SELECT id, workspace_id FROM devices WHERE id = ?').get(id);
    if (!device) {
      missing.push(id);
      continue;
    }
    if (device.workspace_id !== workspaceId) {
      return {
        ok: false,
        status: 403,
        body: { error: `Device ${id} is not in this workspace` },
      };
    }
    targets.push(id);
  }

  if (targets.length === 0) {
    return {
      ok: false,
      status: 404,
      body: { error: 'No valid target devices found', missing },
    };
  }

  return { ok: true, requested, targets, missing };
}

module.exports = {
  LIVE_STREAM_DEVICE_PREFIX,
  isManagedLiveStreamTarget,
  resolveBroadcastTargets,
  resolveTypedBroadcastTargets,
};
