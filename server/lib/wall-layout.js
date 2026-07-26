const crypto = require('crypto');

const LAYOUT_VERSION = 1;
const FIT_MODES = new Set(['contain', 'cover', 'fill', 'none', 'scale-down']);

class InvalidStoredWallLayoutError extends Error {
  constructor(wallId, cause) {
    super(`Stored layout for wall ${wallId || '(unknown)'} is invalid`);
    this.name = 'InvalidStoredWallLayoutError';
    this.code = 'INVALID_STORED_WALL_LAYOUT';
    this.wallId = wallId || null;
    this.cause = cause;
  }
}

function finitePercent(value, field, { positive = false } = {}) {
  const number = Number(value);
  if (!Number.isFinite(number)) throw new Error(`Region ${field} must be a finite percentage`);
  if (number < 0 || number > 100 || (positive && number === 0)) {
    throw new Error(`Region ${field} must be ${positive ? 'greater than 0 and ' : ''}between 0 and 100`);
  }
  return number;
}

function normalizeWallRegions(wall, members, input, options = {}) {
  const rawRegions = Array.isArray(input?.regions) ? input.regions : [];
  if (!rawRegions.length) return [];
  const revision = Number(options.revision ?? input?.revision ?? wall?.layout_revision) || 0;
  const memberIds = new Set((members || []).map((member) => String(member.device_id)));
  const seen = new Set();
  const seenZoneIds = new Set();

  return rawRegions.map((candidate, index) => {
    const id = String(candidate?.id || '').trim();
    if (!id) throw new Error('Wall regions require a stable id');
    if (seen.has(id)) throw new Error(`Wall region ${id} appears more than once`);
    seen.add(id);
    const name = String(candidate?.name || '').trim();
    if (!name) throw new Error(`Wall region ${id} requires a name`);
    const playerDeviceId = String(
      candidate?.player_device_id ?? candidate?.playerDeviceId ?? ''
    ).trim();
    if (!playerDeviceId || !memberIds.has(playerDeviceId)) {
      throw new Error(`Wall region ${id} player must be a current wall member`);
    }
    const zoneId = String(candidate?.zone_id ?? candidate?.zoneId ?? id).trim();
    if (!zoneId) throw new Error(`Wall region ${id} requires a stable zone id`);
    if (seenZoneIds.has(zoneId)) throw new Error(`Wall region zone ${zoneId} appears more than once`);
    seenZoneIds.add(zoneId);
    const x = finitePercent(candidate?.x ?? candidate?.x_percent, `${id} x`);
    const y = finitePercent(candidate?.y ?? candidate?.y_percent, `${id} y`);
    const width = finitePercent(
      candidate?.width ?? candidate?.width_percent,
      `${id} width`,
      { positive: true },
    );
    const height = finitePercent(
      candidate?.height ?? candidate?.height_percent,
      `${id} height`,
      { positive: true },
    );
    if (x + width > 100.0001 || y + height > 100.0001) {
      throw new Error(`Wall region ${id} exceeds the normalized canvas`);
    }
    const candidateRevision = candidate?.revision == null
      ? revision
      : Number(candidate.revision);
    if (!Number.isInteger(candidateRevision) || candidateRevision !== revision) {
      throw new Error(`Wall region ${id} revision must match wall revision ${revision}`);
    }
    const fitMode = String(candidate?.fit_mode || 'contain').trim().toLowerCase();
    if (!FIT_MODES.has(fitMode)) throw new Error(`Wall region ${id} has an invalid fit mode`);
    const zIndex = Number(candidate?.z_index ?? index);
    if (!Number.isInteger(zIndex)) throw new Error(`Wall region ${id} z-index must be an integer`);
    return {
      id,
      name,
      x,
      y,
      width,
      height,
      coordinate_system: 'normalized-percent',
      player_device_id: playerDeviceId,
      zone_id: zoneId,
      z_index: zIndex,
      fit_mode: fitMode,
      enabled: candidate?.enabled !== false,
      revision,
    };
  });
}

function orderedMembers(members) {
  return [...(members || [])].sort((a, b) =>
    (Number(a.grid_row) - Number(b.grid_row))
    || (Number(a.grid_col) - Number(b.grid_col))
    || String(a.device_id).localeCompare(String(b.device_id))
  );
}

function groupId(wallId, memberIds) {
  const digest = crypto.createHash('sha1').update(memberIds.join('|')).digest('hex').slice(0, 10);
  return `${wallId}:group:${digest}`;
}

function buildGroup(wallId, rows, layout = 'solo', existing = {}) {
  const memberIds = rows.map((row) => row.device_id);
  const columns = new Set(rows.map((row) => Number(row.grid_col))).size || 1;
  const rowCount = new Set(rows.map((row) => Number(row.grid_row))).size || 1;
  return {
    id: existing.id || groupId(wallId, memberIds),
    name: existing.name || (memberIds.length > 1 ? `Displays ${rows.map((row) => Number(row.grid_col) + 1).join('+')}` : (rows[0]?.device_name || `Display ${Number(rows[0]?.grid_col) + 1}`)),
    layout: memberIds.length > 1 && layout === 'span' ? 'span' : 'solo',
    member_ids: memberIds,
    leader_device_id: existing.leader_device_id && memberIds.includes(existing.leader_device_id)
      ? existing.leader_device_id
      : memberIds[0],
    geometry: { columns, rows: rowCount },
    playlist_id: existing.playlist_id || null,
    audio_policy: { mode: 'managed-display' },
  };
}

function legacyLayout(wall, members) {
  const ordered = orderedMembers(members);
  const split = String(wall?.layout_mode || 'span') === 'split';
  const groups = split
    ? ordered.map((member) => buildGroup(wall.id, [member], 'solo', { playlist_id: member.playlist_id || null }))
    : [buildGroup(wall.id, ordered, 'span', {
      leader_device_id: wall?.leader_device_id,
      playlist_id: wall?.playlist_id || ordered[0]?.playlist_id || null,
    })].filter((group) => group.member_ids.length > 0);
  return {
    version: LAYOUT_VERSION,
    id: `${wall.id}:layout:${Number(wall.layout_revision) || 0}`,
    wall_id: wall.id,
    mode: 'groups',
    revision: Number(wall.layout_revision) || 0,
    preset: split ? 'split-all' : 'span-all',
    source: 'legacy',
    groups,
  };
}

function parseStoredLayout(wall, members, options = {}) {
  if (!wall?.layout_json) return legacyLayout(wall, members);
  try {
    const parsed = JSON.parse(wall.layout_json);
    return validateLayout(wall, members, parsed, { revision: Number(wall.layout_revision) || Number(parsed.revision) || 0, source: 'stored' });
  } catch (error) {
    const invalid = new InvalidStoredWallLayoutError(wall?.id, error);
    if (options.onInvalid === 'return') {
      return {
        version: LAYOUT_VERSION,
        id: `${wall?.id || 'wall'}:layout:${Number(wall?.layout_revision) || 0}`,
        wall_id: wall?.id || null,
        mode: 'invalid',
        revision: Number(wall?.layout_revision) || 0,
        preset: null,
        source: 'invalid',
        valid: false,
        error: {
          code: invalid.code,
          message: invalid.message,
        },
        groups: [],
        regions: [],
      };
    }
    throw invalid;
  }
}

function regionsFromLayoutZones(wall, members, zones, options = {}) {
  const currentMembers = Array.isArray(members) ? members : [];
  if (String(wall?.layout_mode || '') !== 'split' || currentMembers.length !== 1) {
    throw new Error('Mosaic region synchronization requires exactly one current wall member in split mode');
  }
  if (!Array.isArray(zones) || zones.length === 0) {
    throw new Error('Mosaic region synchronization requires at least one layout zone');
  }
  const revision = Number(options.revision);
  if (!Number.isInteger(revision) || revision < 0) {
    throw new Error('Mosaic region synchronization requires a non-negative revision');
  }
  const playerDeviceId = String(currentMembers[0].device_id || '');
  return normalizeWallRegions(
    { ...wall, layout_revision: revision },
    currentMembers,
    {
      revision,
      regions: zones.map((zone, index) => ({
        id: String(zone.region_id || zone.id || '').trim(),
        name: String(zone.name || `Region ${index + 1}`).trim(),
        x: zone.x_percent,
        y: zone.y_percent,
        width: zone.width_percent,
        height: zone.height_percent,
        player_device_id: playerDeviceId,
        zone_id: String(zone.id || '').trim(),
        z_index: Number.isInteger(Number(zone.z_index)) ? Number(zone.z_index) : index,
        fit_mode: zone.fit_mode || 'contain',
        enabled: zone.enabled !== false,
        revision,
      })),
    },
    { revision },
  );
}

function presetGroups(wall, members, preset) {
  const ordered = orderedMembers(members);
  if (!ordered.length) return [];
  if (preset === 'span-all') return [buildGroup(wall.id, ordered, 'span')];
  if (preset === 'split-all') return ordered.map((member) => buildGroup(wall.id, [member], 'solo'));
  if (ordered.length === 3 && preset === 'span-left') {
    return [buildGroup(wall.id, ordered.slice(0, 2), 'span'), buildGroup(wall.id, ordered.slice(2), 'solo')];
  }
  if (ordered.length === 3 && preset === 'span-right') {
    return [buildGroup(wall.id, ordered.slice(0, 1), 'solo'), buildGroup(wall.id, ordered.slice(1), 'span')];
  }
  throw new Error('Unsupported wall layout preset');
}

function presetForGroups(members, groups) {
  const orderedIds = orderedMembers(members).map((member) => member.device_id);
  const signature = (groups || []).map((group) => ({
    layout: group.layout,
    member_ids: [...(group.member_ids || [])],
  }));
  for (const preset of ['span-all', 'split-all', 'span-left', 'span-right']) {
    let expected;
    try {
      expected = presetGroups({ id: 'preset-check' }, members, preset).map((group) => ({
        layout: group.layout,
        member_ids: group.member_ids,
      }));
    } catch {
      continue;
    }
    if (JSON.stringify(signature) === JSON.stringify(expected)) return preset;
  }
  if (orderedIds.length === 0 && signature.length === 0) return 'split-all';
  return 'custom';
}

function validateLayout(wall, members, input, options = {}) {
  const ordered = orderedMembers(members);
  const orderedIds = ordered.map((member) => member.device_id);
  const memberById = new Map(ordered.map((member) => [member.device_id, member]));
  const revision = Number(options.revision ?? input.revision ?? wall.layout_revision) || 0;
  const regions = normalizeWallRegions(wall, ordered, input, { revision });
  const groupsInput = Array.isArray(input?.groups) && input.groups.length
    ? input.groups
    : (regions.length && ordered.length === 1 ? [buildGroup(wall.id, ordered, 'solo')] : []);
  if (!groupsInput.length && orderedIds.length) throw new Error('At least one layout group is required');

  const seen = new Set();
  const groups = groupsInput.map((candidate) => {
    const ids = Array.isArray(candidate.member_ids) ? candidate.member_ids.map(String) : [];
    if (!ids.length) throw new Error('Layout groups cannot be empty');
    for (const id of ids) {
      if (!memberById.has(id)) throw new Error(`Device ${id} is not a member of this wall`);
      if (seen.has(id)) throw new Error(`Device ${id} appears in more than one layout group`);
      seen.add(id);
    }
    const indexes = ids.map((id) => orderedIds.indexOf(id)).sort((a, b) => a - b);
    if (indexes.some((value, index) => index > 0 && value !== indexes[index - 1] + 1)) {
      throw new Error('Layout groups must contain contiguous displays');
    }
    const rows = indexes.map((index) => ordered[index]);
    return buildGroup(wall.id, rows, candidate.layout, candidate);
  });

  if (seen.size !== orderedIds.length) throw new Error('Every wall display must belong to exactly one layout group');
  return {
    version: LAYOUT_VERSION,
    id: `${wall.id}:layout:${revision}`,
    wall_id: wall.id,
    mode: 'groups',
    revision,
    preset: presetForGroups(ordered, groups),
    source: options.source || 'request',
    groups,
    regions,
  };
}

function groupForDevice(layout, deviceId) {
  return layout?.groups?.find((group) => group.member_ids.includes(deviceId)) || null;
}

// Keep the configured leader durable while deriving a deterministic online
// failover for the current payload. Reconnect/disconnect must never rewrite
// video_walls.leader_device_id or stored layout JSON. When the configured
// leader returns, it automatically resumes its role without a topology change.
function resolveEffectiveLayoutLeaders(layout, members) {
  if (!layout) return layout;
  const statusById = new Map((members || []).map((member) => [member.device_id, member.status]));
  return {
    ...layout,
    groups: (layout.groups || []).map((group) => {
      const configuredLeader = group.leader_device_id || group.member_ids?.[0] || null;
      const configuredOnline = configuredLeader && statusById.get(configuredLeader) === 'online';
      const effectiveLeader = configuredOnline
        ? configuredLeader
        : (group.member_ids || []).find((deviceId) => statusById.get(deviceId) === 'online') || configuredLeader;
      return {
        ...group,
        configured_leader_device_id: configuredLeader,
        leader_device_id: effectiveLeader,
        leader_failover_active: !!configuredLeader && effectiveLeader !== configuredLeader,
      };
    }),
  };
}

module.exports = {
  LAYOUT_VERSION,
  InvalidStoredWallLayoutError,
  orderedMembers,
  legacyLayout,
  parseStoredLayout,
  presetGroups,
  presetForGroups,
  validateLayout,
  normalizeWallRegions,
  regionsFromLayoutZones,
  groupForDevice,
  resolveEffectiveLayoutLeaders,
};
