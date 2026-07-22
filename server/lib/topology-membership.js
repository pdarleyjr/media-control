class TopologyConflictError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'TopologyConflictError';
    this.code = code;
    this.statusCode = 409;
    this.details = details;
  }
}

function wallMembershipFor(db, deviceId) {
  const membership = db.prepare(`
    SELECT wall_id AS wallId FROM video_wall_devices
    WHERE device_id = ? ORDER BY wall_id LIMIT 1
  `).get(deviceId);
  if (membership) return membership.wallId;
  return db.prepare('SELECT wall_id AS wallId FROM devices WHERE id = ?').get(deviceId)?.wallId || null;
}

function groupMembershipsFor(db, deviceId) {
  return db.prepare(`
    SELECT group_id AS groupId FROM device_group_members
    WHERE device_id = ? ORDER BY group_id
  `).all(deviceId).map((row) => row.groupId);
}

function assertCanJoinIndependentGroup(db, deviceId, groupId) {
  const wallId = wallMembershipFor(db, deviceId);
  if (wallId) {
    throw new TopologyConflictError(
      'DEVICE_ALREADY_IN_WALL',
      'Remove the display from its wall before adding it to an independent group.',
      { deviceId, wallId }
    );
  }
  const groupIds = groupMembershipsFor(db, deviceId);
  const otherGroupId = groupIds.find((id) => id !== groupId);
  if (otherGroupId) {
    throw new TopologyConflictError(
      'DEVICE_ALREADY_IN_GROUP',
      'A display may belong to only one independent group. Remove its current group membership first.',
      { deviceId, groupId: otherGroupId }
    );
  }
  return { alreadyMember: groupIds.includes(groupId) };
}

function assertCanJoinWall(db, deviceId, wallId) {
  const currentWallId = wallMembershipFor(db, deviceId);
  if (currentWallId && currentWallId !== wallId) {
    throw new TopologyConflictError(
      'DEVICE_ALREADY_IN_WALL',
      'A display may belong to only one wall. Remove it from the current wall before transferring it.',
      { deviceId, wallId: currentWallId }
    );
  }
  return { groupIdsToRemove: groupMembershipsFor(db, deviceId) };
}

module.exports = {
  TopologyConflictError,
  assertCanJoinIndependentGroup,
  assertCanJoinWall,
  groupMembershipsFor,
  wallMembershipFor,
};
