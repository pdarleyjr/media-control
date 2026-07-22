// Pure projection from the revisioned room target catalog into the whiteboard
// transport envelope. Whiteboard must never rebuild topology from legacy wall
// grid assumptions because real rooms can mix resolutions and calibrated
// viewport offsets.

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function positive(value, fallback = null) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function screenshotFor(id, stateById, catalogDisplay = null) {
  const current = stateById.get(id) || {};
  const raw = catalogDisplay?.raw || {};
  const confirmed = catalogDisplay?.confirmedState || {};
  return current.screenshot_url || current.screenshotUrl
    || raw.screenshot_url || raw.screenshotUrl
    || confirmed.screenshot_url || confirmed.screenshotUrl
    || null;
}

function displayTarget(display, stateById) {
  const id = text(display?.id);
  if (!id) return null;
  const dimensions = display?.dimensions || {};
  return {
    target_type: 'display',
    target_id: id,
    preview_device_id: id,
    label: display.topologyLabel || display.label || display.name || id,
    screenshot_url: screenshotFor(id, stateById, display),
    width: positive(dimensions.width, 1920),
    height: positive(dimensions.height, 1080),
    catalog_revision: null,
  };
}

function wallTarget(wall, stateById, catalogRevision) {
  const wallId = text(wall?.id);
  const members = Array.isArray(wall?.members) ? wall.members : [];
  if (!wallId || members.length === 0 || members.some((member) => !member?.viewport)) return null;

  const minX = Math.min(...members.map((member) => Number(member.viewport.x)));
  const minY = Math.min(...members.map((member) => Number(member.viewport.y)));
  const maxX = Math.max(...members.map((member) => Number(member.viewport.x) + Number(member.viewport.width)));
  const maxY = Math.max(...members.map((member) => Number(member.viewport.y) + Number(member.viewport.height)));
  const boundsWidth = maxX - minX;
  const boundsHeight = maxY - minY;
  if (![minX, minY, boundsWidth, boundsHeight].every(Number.isFinite) || boundsWidth <= 0 || boundsHeight <= 0) {
    return null;
  }

  const normalizedMembers = members.map((member) => ({
    id: text(member.id),
    screenshot_url: screenshotFor(text(member.id), stateById, member),
    x: (Number(member.viewport.x) - minX) / boundsWidth,
    y: (Number(member.viewport.y) - minY) / boundsHeight,
    width: Number(member.viewport.width) / boundsWidth,
    height: Number(member.viewport.height) / boundsHeight,
  }));
  if (normalizedMembers.some((member) => !member.id)) return null;

  const preferredLeader = text(
    wall?.raw?.leaderDeviceId
      || wall?.raw?.leader_device_id
      || wall?.leaderDeviceId
      || wall?.leader_device_id,
  );
  const leaderId = normalizedMembers.some((member) => member.id === preferredLeader)
    ? preferredLeader
    : normalizedMembers[0].id;
  const dimensions = wall?.dimensions || {};
  return {
    target_type: 'wall',
    target_id: leaderId,
    wall_id: wallId,
    member_ids: normalizedMembers.map((member) => member.id),
    preview_device_id: leaderId,
    label: wall.topologyLabel || wall.label || wall.name || wallId,
    screenshot_url: screenshotFor(leaderId, stateById, members.find((member) => member.id === leaderId)),
    members: normalizedMembers,
    width: positive(dimensions.width, boundsWidth),
    height: positive(dimensions.height, boundsHeight),
    layout_revision: Number(wall.layoutRevision) || 0,
    catalog_revision: Number(catalogRevision) || 0,
  };
}

function groupTarget(group, stateById, catalogRevision) {
  const groupId = text(group?.id);
  const members = Array.isArray(group?.members) ? group.members.filter((member) => text(member?.id)) : [];
  if (!groupId || members.length === 0) return null;
  const leaderId = text(group?.raw?.leaderDeviceId || group?.raw?.leader_device_id) || text(members[0].id);
  const leader = members.find((member) => member.id === leaderId) || members[0];
  const width = Math.max(...members.map((member) => positive(member?.dimensions?.width, 1920)));
  const height = Math.max(...members.map((member) => positive(member?.dimensions?.height, 1080)));
  return {
    target_type: 'group',
    target_id: text(leader.id),
    group_id: groupId,
    member_ids: members.map((member) => text(member.id)),
    preview_device_id: text(leader.id),
    label: group.topologyLabel || group.label || group.name || groupId,
    screenshot_url: screenshotFor(text(leader.id), stateById, leader),
    // A saved display group mirrors the same logical board on every member;
    // unlike a wall, its members do not form one stitched canvas.
    members: members.map((member) => ({
      id: text(member.id),
      screenshot_url: screenshotFor(text(member.id), stateById, member),
      x: 0,
      y: 0,
      width: 1,
      height: 1,
    })),
    width,
    height,
    catalog_revision: Number(catalogRevision) || 0,
  };
}

export function buildWhiteboardTargets(catalog, displayRows = []) {
  if (!catalog || typeof catalog !== 'object') return [];
  const stateById = new Map(
    (Array.isArray(displayRows) ? displayRows : [])
      .filter((display) => text(display?.id))
      .map((display) => [text(display.id), display]),
  );
  const result = [];
  for (const wall of (Array.isArray(catalog.walls) ? catalog.walls : [])) {
    const target = wallTarget(wall, stateById, catalog.revision);
    if (target) result.push(target);
  }
  for (const group of (Array.isArray(catalog.groups) ? catalog.groups : [])) {
    const target = groupTarget(group, stateById, catalog.revision);
    if (target) result.push(target);
  }
  for (const display of (Array.isArray(catalog.standaloneDisplays) ? catalog.standaloneDisplays : [])) {
    const target = displayTarget(display, stateById);
    if (target) {
      target.catalog_revision = Number(catalog.revision) || 0;
      result.push(target);
    }
  }
  return result;
}

export function findWhiteboardTargetForActive(targets, catalog, activeTarget) {
  const choices = Array.isArray(targets) ? targets : [];
  const type = text(activeTarget?.type || activeTarget?.target_type);
  const id = text(activeTarget?.id || activeTarget?.target_id);
  if (!id) return choices[0] || null;

  if (type === 'wall') return choices.find((target) => target.wall_id === id) || null;
  if (type === 'group') return choices.find((target) => target.group_id === id) || null;
  if (type === 'display') {
    const direct = choices.find((target) => target.target_type === 'display' && target.target_id === id);
    if (direct) return direct;
    const parentWall = (catalog?.walls || []).find((wall) => wall.memberIds?.includes(id));
    return parentWall
      ? choices.find((target) => target.wall_id === parentWall.id) || null
      : null;
  }
  return choices[0] || null;
}
