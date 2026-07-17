const crypto = require('crypto');

const LAYOUT_VERSION = 1;

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
    source: 'legacy',
    groups,
  };
}

function parseStoredLayout(wall, members) {
  if (!wall?.layout_json) return legacyLayout(wall, members);
  try {
    const parsed = JSON.parse(wall.layout_json);
    return validateLayout(wall, members, parsed, { revision: Number(wall.layout_revision) || Number(parsed.revision) || 0, source: 'stored' });
  } catch (_) {
    return legacyLayout(wall, members);
  }
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

function validateLayout(wall, members, input, options = {}) {
  const ordered = orderedMembers(members);
  const orderedIds = ordered.map((member) => member.device_id);
  const memberById = new Map(ordered.map((member) => [member.device_id, member]));
  const groupsInput = Array.isArray(input?.groups) ? input.groups : [];
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
  const revision = Number(options.revision ?? input.revision ?? wall.layout_revision) || 0;
  return {
    version: LAYOUT_VERSION,
    id: `${wall.id}:layout:${revision}`,
    wall_id: wall.id,
    mode: 'groups',
    revision,
    source: options.source || 'request',
    groups,
  };
}

function groupForDevice(layout, deviceId) {
  return layout?.groups?.find((group) => group.member_ids.includes(deviceId)) || null;
}

module.exports = {
  LAYOUT_VERSION,
  orderedMembers,
  legacyLayout,
  parseStoredLayout,
  presetGroups,
  validateLayout,
  groupForDevice,
};
