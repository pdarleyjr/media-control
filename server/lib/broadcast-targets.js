'use strict';

const { parseStoredLayout } = require('./wall-layout');

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
  const routes = [];
  const seenRoutes = new Set();
  const add = (id) => {
    const normalized = String(id || '');
    if (normalized && !seen.has(normalized)) {
      seen.add(normalized);
      resolved.push(normalized);
    }
  };
  const addRoute = (route) => {
    const deviceId = String(route?.device_id || '');
    if (!deviceId) return;
    const key = route.type === 'wall-region'
      ? `${deviceId}:region:${route.region_id}`
      : deviceId;
    if (!seenRoutes.has(key)) {
      seenRoutes.add(key);
      routes.push({ ...route, device_id: deviceId });
    }
    add(deviceId);
  };

  const loadWall = (wallId, expectedRevision) => {
    const wall = db.prepare(`
      SELECT id, workspace_id, layout_mode, layout_revision, layout_json
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
      SELECT vwd.*, d.workspace_id, d.name AS device_name, d.playlist_id,
             d.status, d.layout_id, d.screen_width, d.screen_height
      FROM video_wall_devices vwd
      JOIN devices d ON d.id = vwd.device_id
      WHERE vwd.wall_id = ?
    `).all(wallId);
    if (!members.length || members.some((member) => member.workspace_id !== workspaceId)) {
      return { error: layoutConflict(wallId, expectedRevision, currentRevision, 'Wall topology is incomplete; refresh targets and try again') };
    }
    return { wall, members, currentRevision };
  };

  const loadAuthoritativeLayout = (loaded, wallId) => {
    try {
      return { layout: parseStoredLayout(loaded.wall, loaded.members) };
    } catch (error) {
      if (error?.code === 'INVALID_STORED_WALL_LAYOUT') {
        return {
          error: {
            ok: false,
            status: 409,
            targets: [],
            body: {
              error: 'Stored wall layout is invalid; repair or resynchronize it before broadcasting',
              code: 'INVALID_STORED_WALL_LAYOUT',
              wall_id: wallId,
              current_revision: loaded.currentRevision,
            },
          },
        };
      }
      throw error;
    }
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
      addRoute({ type: 'display', device_id: id });
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
      members.forEach((member) => addRoute({
        type: 'device-group',
        device_id: member.device_id,
        group_id: groupId,
      }));
      continue;
    }

    if (type === 'wall' || type === 'wall-group' || type === 'wall-member' || type === 'wall-region') {
      const wallId = String(type === 'wall' ? ref.id : ref.wall_id || '');
      if (!wallId) return typedTargetError(`${type} targets require ${type === 'wall' ? 'id' : 'wall_id'}`);
      const loaded = loadWall(wallId, ref.layout_revision);
      if (loaded.error) return loaded.error;

      if (type === 'wall') {
        const authoritative = loadAuthoritativeLayout(loaded, wallId);
        if (authoritative.error) return authoritative.error;
        const layout = authoritative.layout;
        const mosaicRegions = String(loaded.wall.layout_mode || '') === 'split'
          && loaded.members.length === 1
          ? (layout.regions || []).filter((region) => region.enabled !== false)
          : [];
        if (mosaicRegions.length > 0) {
          const playerDeviceId = String(loaded.members[0].device_id);
          for (const region of mosaicRegions) {
            const zoneId = String(region.zone_id || '');
            const zone = db.prepare(`
              SELECT lz.id
              FROM layout_zones lz
              JOIN devices d ON d.layout_id = lz.layout_id
              WHERE lz.id = ? AND d.id = ?
            `).get(zoneId, playerDeviceId);
            if (!zone) {
              return layoutConflict(
                wallId,
                ref.layout_revision,
                loaded.currentRevision,
                'Wall region is not bound to the current Mosaic player layout',
              );
            }
            addRoute({
              type: 'wall-region',
              device_id: playerDeviceId,
              wall_id: wallId,
              region_id: region.id,
              zone_id: zoneId,
              layout_revision: loaded.currentRevision,
              fit_mode: String(region.fit_mode || 'contain'),
              wall_replace: true,
            });
          }
        } else {
          loaded.members.forEach((member) => addRoute({
            type: 'wall',
            device_id: member.device_id,
            wall_id: wallId,
            layout_revision: loaded.currentRevision,
          }));
        }
        continue;
      }

      if (type === 'wall-member') {
        const deviceId = String(ref.device_id || ref.id || '');
        if (!deviceId) return typedTargetError('Wall-member targets require device_id');
        if (!loaded.members.some((member) => String(member.device_id) === deviceId)) {
          return typedTargetNotFound('Wall member', deviceId);
        }
        if (String(loaded.wall.layout_mode || '') !== 'split' || loaded.members.length <= 1) {
          return {
            ok: false,
            status: 409,
            targets: [],
            body: {
              error: 'Individual wall members are routable only on a current multi-player split wall',
              code: 'TOPOLOGY_CONFLICT',
              wall_id: wallId,
            },
          };
        }
        addRoute({
          type: 'wall-member',
          device_id: deviceId,
          wall_id: wallId,
          layout_revision: loaded.currentRevision,
        });
        continue;
      }

      if (type === 'wall-region') {
        const regionId = String(ref.region_id || ref.id || '');
        if (!regionId) return typedTargetError('Wall-region targets require region_id');
        if (String(loaded.wall.layout_mode || '') !== 'split' || loaded.members.length !== 1) {
          return {
            ok: false,
            status: 409,
            targets: [],
            body: {
              error: 'Wall regions require a current one-player Mosaic split wall',
              code: 'TOPOLOGY_CONFLICT',
              wall_id: wallId,
            },
          };
        }
        const authoritative = loadAuthoritativeLayout(loaded, wallId);
        if (authoritative.error) return authoritative.error;
        const region = (authoritative.layout.regions || [])
          .find((candidate) => String(candidate?.id || '') === regionId);
        if (!region || region.enabled === false) return typedTargetNotFound('Wall region', regionId);
        const playerDeviceId = String(region.player_device_id || region.playerDeviceId || '');
        const zoneId = String(region.zone_id || region.zoneId || region.id || '');
        if (
          Number(region.revision) !== loaded.currentRevision
          || !playerDeviceId
          || String(loaded.members[0].device_id) !== playerDeviceId
          || !zoneId
        ) {
          return layoutConflict(
            wallId,
            ref.layout_revision,
            loaded.currentRevision,
            'Wall-region topology is inconsistent; refresh targets and try again',
          );
        }
        const zone = db.prepare(`
          SELECT lz.id, lz.layout_id, d.id AS device_id
          FROM layout_zones lz
          JOIN devices d ON d.layout_id = lz.layout_id
          WHERE lz.id = ? AND d.id = ?
        `).get(zoneId, playerDeviceId);
        if (!zone) {
          return layoutConflict(
            wallId,
            ref.layout_revision,
            loaded.currentRevision,
            'Wall region is not bound to the current Mosaic player layout',
          );
        }
        addRoute({
          type: 'wall-region',
          device_id: playerDeviceId,
          wall_id: wallId,
          region_id: regionId,
          zone_id: zoneId,
          layout_revision: loaded.currentRevision,
          fit_mode: String(region.fit_mode || 'contain'),
        });
        continue;
      }

      const groupId = String(ref.group_id || ref.id || '');
      if (!groupId) return typedTargetError('Wall-group targets require group_id');
      const authoritative = loadAuthoritativeLayout(loaded, wallId);
      if (authoritative.error) return authoritative.error;
      const layoutGroups = Array.isArray(authoritative.layout?.groups) ? authoritative.layout.groups : [];
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
      memberIds.forEach((deviceId) => addRoute({
        type: 'wall-group',
        device_id: deviceId,
        wall_id: wallId,
        group_id: groupId,
        layout_revision: loaded.currentRevision,
      }));
      continue;
    }

    return typedTargetError(`Unsupported target type: ${ref.type || '(missing)'}`);
  }

  return { ok: true, targets: resolved, routes };
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
