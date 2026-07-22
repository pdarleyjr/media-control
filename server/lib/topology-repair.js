const crypto = require('node:crypto');
const { validateLayout } = require('./wall-layout');

const REPAIR_SCHEMA_VERSION = 1;
const MIGRATION_ID = 'display_topology_integrity_v1';
const AUDIT_TABLE = 'display_topology_repair_runs';

const REQUIRED_SCHEMA = {
  workspaces: ['id'],
  workspace_members: ['workspace_id', 'user_id'],
  devices: ['id', 'user_id', 'workspace_id', 'name', 'wall_id', 'screen_on'],
  device_groups: ['id', 'user_id', 'workspace_id', 'name'],
  device_group_members: ['device_id', 'group_id'],
  video_walls: [
    'id', 'user_id', 'workspace_id', 'name', 'grid_cols', 'grid_rows',
    'leader_device_id', 'layout_json', 'layout_revision',
  ],
  video_wall_devices: ['wall_id', 'device_id', 'grid_col', 'grid_row'],
  schedules: ['id', 'group_id'],
};

const GUARD_INDEXES = [
  'ux_device_group_members_one_group',
  'ux_video_wall_devices_one_wall',
  'ux_device_groups_workspace_name',
];

const GUARD_TRIGGERS = [
  'trg_device_groups_valid_insert',
  'trg_device_groups_valid_update',
  'trg_group_membership_valid_insert',
  'trg_group_membership_valid_update',
  'trg_wall_dimensions_valid_insert',
  'trg_wall_dimensions_valid_update',
  'trg_wall_leader_valid_insert',
  'trg_wall_leader_valid_update',
  'trg_wall_membership_valid_insert',
  'trg_wall_membership_valid_update',
  'trg_device_wall_reference_valid_update',
  'trg_wall_membership_assign_device',
  'trg_wall_membership_clear_device',
  'trg_wall_membership_choose_leader',
  'trg_wall_membership_reselect_leader',
];

function tableExists(db, table) {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);
}

function columnsFor(db, table) {
  return db.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name);
}

function assertRequiredSchema(db) {
  for (const [table, requiredColumns] of Object.entries(REQUIRED_SCHEMA)) {
    if (!tableExists(db, table)) throw new Error(`Required topology table is missing: ${table}`);
    const actual = new Set(columnsFor(db, table));
    for (const column of requiredColumns) {
      if (!actual.has(column)) throw new Error(`Required topology column is missing: ${table}.${column}`);
    }
  }
}

function snapshotRows(db, table, candidateColumns, orderBy) {
  const actual = new Set(columnsFor(db, table));
  const selected = candidateColumns.filter((column) => actual.has(column));
  return db.prepare(`SELECT ${selected.join(', ')} FROM ${table} ORDER BY ${orderBy}`).all();
}

function snapshotTopology(db) {
  assertRequiredSchema(db);
  return {
    devices: snapshotRows(
      db,
      'devices',
      ['id', 'workspace_id', 'wall_id', 'screen_on'],
      'id'
    ),
    device_groups: snapshotRows(
      db,
      'device_groups',
      ['id', 'user_id', 'workspace_id', 'name', 'color', 'playlist_id', 'created_at'],
      'id'
    ),
    device_group_members: snapshotRows(
      db,
      'device_group_members',
      ['device_id', 'group_id'],
      'group_id, device_id'
    ),
    video_walls: snapshotRows(
      db,
      'video_walls',
      [
        'id', 'workspace_id', 'name', 'grid_cols', 'grid_rows', 'leader_device_id',
        'layout_mode', 'layout_json', 'layout_revision',
      ],
      'id'
    ),
    video_wall_devices: snapshotRows(
      db,
      'video_wall_devices',
      [
        'id', 'wall_id', 'device_id', 'grid_col', 'grid_row', 'rotation',
        'canvas_x', 'canvas_y', 'canvas_width', 'canvas_height',
      ],
      'wall_id, grid_row, grid_col, device_id'
    ),
    schedules: snapshotRows(db, 'schedules', ['id', 'group_id'], 'id'),
  };
}

function snapshotHash(snapshot) {
  return crypto.createHash('sha256').update(JSON.stringify(snapshot)).digest('hex');
}

function layoutMembers(db, wallId) {
  return db.prepare(`
    SELECT vwd.*, d.name AS device_name
    FROM video_wall_devices vwd
    JOIN devices d ON d.id = vwd.device_id
    WHERE vwd.wall_id = ?
    ORDER BY vwd.grid_row, vwd.grid_col, vwd.device_id
  `).all(wallId);
}

function invalidStoredLayouts(db) {
  const invalid = [];
  const walls = db.prepare(`
    SELECT * FROM video_walls
    WHERE layout_json IS NOT NULL AND trim(layout_json) <> ''
    ORDER BY id
  `).all();
  for (const wall of walls) {
    try {
      const parsed = JSON.parse(wall.layout_json);
      validateLayout(wall, layoutMembers(db, wall.id), parsed, {
        revision: Number(wall.layout_revision) || Number(parsed.revision) || 0,
        source: 'repair-validation',
      });
    } catch (error) {
      invalid.push({ wallId: wall.id, wallName: wall.name, reason: error.message });
    }
  }
  return invalid;
}

function analyzeTopology(db) {
  assertRequiredSchema(db);
  const orphanGroups = db.prepare(`
    SELECT id, user_id AS userId, workspace_id AS workspaceId, name
    FROM device_groups
    WHERE workspace_id IS NULL OR trim(workspace_id) = ''
    ORDER BY id
  `).all();
  const wallGroupConflicts = db.prepare(`
    SELECT DISTINCT d.id AS deviceId, d.name AS deviceName,
           COALESCE(vwd.wall_id, d.wall_id) AS wallId,
           dgm.group_id AS groupId
    FROM devices d
    JOIN device_group_members dgm ON dgm.device_id = d.id
    LEFT JOIN video_wall_devices vwd ON vwd.device_id = d.id
    WHERE vwd.wall_id IS NOT NULL OR d.wall_id IS NOT NULL
    ORDER BY d.id, dgm.group_id
  `).all();
  const duplicateGroupMemberships = db.prepare(`
    SELECT device_id AS deviceId, COUNT(*) AS membershipCount,
           group_concat(group_id, ',') AS groupIds
    FROM device_group_members
    GROUP BY device_id
    HAVING COUNT(*) > 1
    ORDER BY device_id
  `).all();
  const duplicateWallMemberships = db.prepare(`
    SELECT device_id AS deviceId, COUNT(*) AS membershipCount,
           group_concat(wall_id, ',') AS wallIds
    FROM video_wall_devices
    GROUP BY device_id
    HAVING COUNT(*) > 1
    ORDER BY device_id
  `).all();
  const wallMembersScreenOff = db.prepare(`
    SELECT d.id AS deviceId, d.name AS deviceName, vwd.wall_id AS wallId
    FROM video_wall_devices vwd
    JOIN devices d ON d.id = vwd.device_id
    WHERE d.screen_on = 0
    ORDER BY vwd.wall_id, d.id
  `).all();
  const invalidLeaders = db.prepare(`
    SELECT w.id AS wallId, w.name AS wallName, w.leader_device_id AS leaderDeviceId,
           COUNT(vwd.device_id) AS memberCount
    FROM video_walls w
    LEFT JOIN video_wall_devices vwd ON vwd.wall_id = w.id
    GROUP BY w.id
    HAVING COUNT(vwd.device_id) > 0 AND (
      w.leader_device_id IS NULL OR NOT EXISTS (
        SELECT 1 FROM video_wall_devices leader
        WHERE leader.wall_id = w.id AND leader.device_id = w.leader_device_id
      )
    )
    ORDER BY w.id
  `).all();
  const invalidWallDimensions = db.prepare(`
    SELECT id AS wallId, name AS wallName, grid_cols AS gridCols, grid_rows AS gridRows
    FROM video_walls
    WHERE grid_cols IS NULL OR grid_rows IS NULL OR grid_cols <= 0 OR grid_rows <= 0
    ORDER BY id
  `).all();
  const invalidGridPositions = db.prepare(`
    SELECT vwd.wall_id AS wallId, vwd.device_id AS deviceId,
           vwd.grid_col AS gridCol, vwd.grid_row AS gridRow,
           w.grid_cols AS gridCols, w.grid_rows AS gridRows
    FROM video_wall_devices vwd
    JOIN video_walls w ON w.id = vwd.wall_id
    WHERE vwd.grid_col < 0 OR vwd.grid_row < 0
       OR vwd.grid_col >= w.grid_cols OR vwd.grid_row >= w.grid_rows
    ORDER BY vwd.wall_id, vwd.device_id
  `).all();
  const workspaceMismatches = [
    ...db.prepare(`
      SELECT 'group' AS ownerType, g.id AS ownerId, dgm.device_id AS deviceId,
             g.workspace_id AS ownerWorkspaceId, d.workspace_id AS deviceWorkspaceId
      FROM device_group_members dgm
      JOIN device_groups g ON g.id = dgm.group_id
      JOIN devices d ON d.id = dgm.device_id
      WHERE g.workspace_id IS NOT NULL
        AND (d.workspace_id IS NULL OR d.workspace_id <> g.workspace_id)
      ORDER BY g.id, dgm.device_id
    `).all(),
    ...db.prepare(`
      SELECT 'wall' AS ownerType, w.id AS ownerId, vwd.device_id AS deviceId,
             w.workspace_id AS ownerWorkspaceId, d.workspace_id AS deviceWorkspaceId
      FROM video_wall_devices vwd
      JOIN video_walls w ON w.id = vwd.wall_id
      JOIN devices d ON d.id = vwd.device_id
      WHERE w.workspace_id IS NULL OR d.workspace_id IS NULL OR d.workspace_id <> w.workspace_id
      ORDER BY w.id, vwd.device_id
    `).all(),
  ];
  const wallAssignmentDrift = db.prepare(`
    SELECT d.id AS deviceId, d.wall_id AS deviceWallId, vwd.wall_id AS memberWallId
    FROM devices d
    LEFT JOIN video_wall_devices vwd ON vwd.device_id = d.id
    WHERE COALESCE(d.wall_id, '') <> COALESCE(vwd.wall_id, '')
    ORDER BY d.id, vwd.wall_id
  `).all();
  const duplicateGroupNames = db.prepare(`
    SELECT workspace_id AS workspaceId, lower(trim(name)) AS normalizedName,
           COUNT(*) AS groupCount, group_concat(id, ',') AS groupIds
    FROM device_groups
    WHERE workspace_id IS NOT NULL
    GROUP BY workspace_id, lower(trim(name))
    HAVING COUNT(*) > 1
    ORDER BY workspace_id, normalizedName
  `).all();
  const wallAliasGroups = db.prepare(`
    SELECT g.id AS groupId, g.name, g.workspace_id AS workspaceId,
           w.id AS wallId, w.name AS wallName,
           COUNT(DISTINCT dgm.device_id) AS memberCount
    FROM device_groups g
    JOIN video_walls w ON w.workspace_id = g.workspace_id
      AND (
        lower(trim(g.name)) = lower(trim(w.name))
        OR lower(trim(g.name)) = lower(trim(w.name || ' Group'))
      )
    LEFT JOIN device_group_members dgm ON dgm.group_id = g.id
    WHERE g.workspace_id IS NOT NULL
    GROUP BY g.id, w.id
    ORDER BY g.id
  `).all();
  const misleadingGroups = db.prepare(`
    SELECT g.id AS groupId, g.name, g.workspace_id AS workspaceId,
           COUNT(DISTINCT dgm.device_id) AS memberCount,
           CASE WHEN g.workspace_id IS NOT NULL THEN (
             SELECT COUNT(*) FROM devices d
             WHERE d.workspace_id = g.workspace_id
               AND d.wall_id IS NULL
               AND NOT EXISTS (SELECT 1 FROM video_wall_devices vwd WHERE vwd.device_id = d.id)
           ) ELSE 0 END AS expectedCount
    FROM device_groups g
    LEFT JOIN device_group_members dgm ON dgm.group_id = g.id
    WHERE lower(g.name) LIKE '%all%display%'
    GROUP BY g.id
    HAVING memberCount <> expectedCount
    ORDER BY g.id
  `).all();
  const invalidLayouts = invalidStoredLayouts(db);
  const foreignKeyViolations = db.pragma('foreign_key_check');
  const categories = {
    orphanGroups,
    wallGroupConflicts,
    duplicateGroupMemberships,
    duplicateWallMemberships,
    wallMembersScreenOff,
    invalidLeaders,
    invalidWallDimensions,
    invalidGridPositions,
    invalidLayouts,
    workspaceMismatches,
    wallAssignmentDrift,
    duplicateGroupNames,
    wallAliasGroups,
    misleadingGroups,
    foreignKeyViolations,
  };
  const issueCount = Object.values(categories).reduce((sum, list) => sum + list.length, 0);
  return { schemaVersion: REPAIR_SCHEMA_VERSION, issueCount, ...categories };
}

function ensureAuditSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ${AUDIT_TABLE} (
      id TEXT PRIMARY KEY,
      migration_id TEXT NOT NULL,
      schema_version INTEGER NOT NULL,
      actor TEXT NOT NULL,
      plan_json TEXT NOT NULL,
      before_json TEXT NOT NULL,
      after_json TEXT NOT NULL,
      before_hash TEXT NOT NULL,
      after_hash TEXT NOT NULL,
      status TEXT NOT NULL,
      applied_at INTEGER NOT NULL,
      rolled_back_at INTEGER,
      rolled_back_by TEXT
    );
  `);
}

function requiredDecision(map, key, message) {
  const decision = map && map[key];
  if (!decision) throw new Error(`${key}: ${message}`);
  return decision;
}

function rejectUnexpectedKeys(mapName, map, allowed) {
  for (const key of Object.keys(map || {})) {
    if (!allowed.has(key)) throw new Error(`${mapName}: unexpected decision key ${key}`);
  }
}

function impactedWallIds(report, plan) {
  const impacted = new Set(report.invalidLayouts.map((row) => row.wallId));
  for (const row of report.wallGroupConflicts) {
    if (plan.membershipConflicts?.[row.deviceId]?.action === 'group_wins' && row.wallId) impacted.add(row.wallId);
  }
  for (const row of report.duplicateWallMemberships) {
    const keep = plan.duplicateWalls?.[row.deviceId]?.keepWallId;
    for (const wallId of row.wallIds.split(',')) if (wallId !== keep) impacted.add(wallId);
  }
  for (const row of report.workspaceMismatches) {
    if (row.ownerType === 'wall' && plan.workspaceMismatches?.[`${row.ownerType}:${row.ownerId}:${row.deviceId}`]?.action === 'remove_membership') {
      impacted.add(row.ownerId);
    }
  }
  for (const key of Object.keys(plan.gridPositions || {})) impacted.add(key.split(':')[0]);
  return impacted;
}

function membershipWillBeRemoved(report, plan, wallId, deviceId) {
  if (report.wallGroupConflicts.some((row) => row.wallId === wallId && row.deviceId === deviceId
    && plan.membershipConflicts?.[deviceId]?.action === 'group_wins')) return true;
  if (report.workspaceMismatches.some((row) => row.ownerType === 'wall' && row.ownerId === wallId && row.deviceId === deviceId
    && plan.workspaceMismatches?.[`wall:${wallId}:${deviceId}`]?.action === 'remove_membership')) return true;
  const duplicate = report.duplicateWallMemberships.find((row) => row.deviceId === deviceId);
  return !!duplicate && plan.duplicateWalls?.[deviceId]?.keepWallId !== wallId;
}

function validatePlan(db, report, plan, currentHash) {
  if (!plan || plan.schemaVersion !== REPAIR_SCHEMA_VERSION) {
    throw new Error(`Repair plan schemaVersion must be ${REPAIR_SCHEMA_VERSION}`);
  }
  if (!/^[a-f0-9]{64}$/i.test(plan.expectedSnapshotHash || '') || plan.expectedSnapshotHash !== currentHash) {
    throw new Error('Repair plan expectedSnapshotHash does not match the current topology snapshot hash');
  }
  if (report.foreignKeyViolations.length) {
    throw new Error('Foreign-key violations require a separate explicit data-recovery plan');
  }

  const deletedGroups = new Set();
  const orphanIds = new Set(report.orphanGroups.map((row) => row.id));
  rejectUnexpectedKeys('orphanGroups', plan.orphanGroups, orphanIds);
  for (const group of report.orphanGroups) {
    const decision = requiredDecision(plan.orphanGroups, group.id, 'explicit orphan-group decision required');
    if (!['assign_workspace', 'delete'].includes(decision.action)) {
      throw new Error(`${group.id}: orphan-group action must be assign_workspace or delete`);
    }
    if (decision.action === 'delete') {
      deletedGroups.add(group.id);
    } else {
      const workspace = decision.workspaceId && db.prepare('SELECT 1 FROM workspaces WHERE id = ?').get(decision.workspaceId);
      const membership = decision.workspaceId && db.prepare(
        'SELECT 1 FROM workspace_members WHERE workspace_id = ? AND user_id = ?'
      ).get(decision.workspaceId, group.userId);
      if (!workspace || !membership) throw new Error(`${group.id}: assigned workspace is not owned or accessible by the group owner`);
    }
  }

  const dispositionIds = new Set([
    ...report.wallAliasGroups.map((row) => row.groupId),
    ...report.misleadingGroups.map((row) => row.groupId),
  ].filter((groupId) => !orphanIds.has(groupId)));
  rejectUnexpectedKeys('groupDispositions', plan.groupDispositions, dispositionIds);
  for (const row of report.wallAliasGroups) {
    if (orphanIds.has(row.groupId)) continue;
    const decision = requiredDecision(plan.groupDispositions, row.groupId, 'explicit wall-alias disposition required');
    if (!['delete', 'rename'].includes(decision.action)) {
      throw new Error(`${row.groupId}: wall-alias disposition must be delete or rename`);
    }
    if (decision.action === 'rename' && (!decision.name || !decision.name.trim())) {
      throw new Error(`${row.groupId}: independent-group rename cannot be blank`);
    }
    if (decision.action === 'delete') deletedGroups.add(row.groupId);
  }
  for (const row of report.misleadingGroups) {
    if (orphanIds.has(row.groupId) || plan.groupDispositions?.[row.groupId]) continue;
    const decision = requiredDecision(plan.groupNames, row.groupId, 'explicit corrective group name or deletion required');
    if (!decision.name || !decision.name.trim()) throw new Error(`${row.groupId}: group name cannot be blank`);
  }
  for (const [groupId, decision] of Object.entries(plan.groupDispositions || {})) {
    if (decision.action === 'delete') deletedGroups.add(groupId);
    else if (decision.action !== 'rename' || !decision.name || !decision.name.trim()) {
      throw new Error(`${groupId}: group disposition must delete or provide a nonblank rename`);
    }
  }

  const conflictIds = new Set(report.wallGroupConflicts.filter((row) => !deletedGroups.has(row.groupId)).map((row) => row.deviceId));
  rejectUnexpectedKeys('membershipConflicts', plan.membershipConflicts, conflictIds);
  for (const deviceId of conflictIds) {
    const decision = requiredDecision(plan.membershipConflicts, deviceId, 'explicit wall/group membership decision required');
    if (!['wall_wins', 'group_wins'].includes(decision.action)) {
      throw new Error(`${deviceId}: membership action must be wall_wins or group_wins`);
    }
  }

  const remainingDuplicateGroups = (row) => row.groupIds.split(',').filter((groupId) => !deletedGroups.has(groupId));
  const duplicateGroupIds = new Set(report.duplicateGroupMemberships
    .filter((row) => !conflictIds.has(row.deviceId) && remainingDuplicateGroups(row).length > 1)
    .map((row) => row.deviceId));
  rejectUnexpectedKeys('duplicateMemberships', plan.duplicateMemberships, duplicateGroupIds);
  for (const duplicate of report.duplicateGroupMemberships) {
    if (conflictIds.has(duplicate.deviceId)) continue;
    const remainingGroups = remainingDuplicateGroups(duplicate);
    if (remainingGroups.length <= 1) continue;
    const decision = requiredDecision(plan.duplicateMemberships, duplicate.deviceId, 'explicit duplicate-group decision required');
    if (!remainingGroups.includes(decision.keepGroupId)) {
      throw new Error(`${duplicate.deviceId}: keepGroupId must name an existing membership`);
    }
  }

  const duplicateWallIds = new Set(report.duplicateWallMemberships.map((row) => row.deviceId));
  rejectUnexpectedKeys('duplicateWalls', plan.duplicateWalls, duplicateWallIds);
  for (const duplicate of report.duplicateWallMemberships) {
    const decision = requiredDecision(plan.duplicateWalls, duplicate.deviceId, 'explicit duplicate-wall decision required');
    if (!duplicate.wallIds.split(',').includes(decision.keepWallId)) {
      throw new Error(`${duplicate.deviceId}: keepWallId must name an existing membership`);
    }
  }

  const screenIds = new Set(report.wallMembersScreenOff.map((row) => row.deviceId));
  rejectUnexpectedKeys('screenState', plan.screenState, screenIds);
  for (const row of report.wallMembersScreenOff) {
    const decision = requiredDecision(plan.screenState, row.deviceId, 'explicit wall-member screen decision required');
    if (decision.action !== 'set_on') throw new Error(`${row.deviceId}: screenState action must be set_on`);
  }

  const dimensionIds = new Set(report.invalidWallDimensions.map((row) => row.wallId));
  rejectUnexpectedKeys('wallDimensions', plan.wallDimensions, dimensionIds);
  for (const row of report.invalidWallDimensions) {
    const decision = requiredDecision(plan.wallDimensions, row.wallId, 'explicit positive wall dimensions required');
    if (!Number.isInteger(decision.gridCols) || !Number.isInteger(decision.gridRows)
      || decision.gridCols <= 0 || decision.gridRows <= 0) {
      throw new Error(`${row.wallId}: wall dimensions must be positive integers`);
    }
  }

  const gridKeys = new Set(report.invalidGridPositions.map((row) => `${row.wallId}:${row.deviceId}`));
  rejectUnexpectedKeys('gridPositions', plan.gridPositions, gridKeys);
  for (const row of report.invalidGridPositions) {
    const key = `${row.wallId}:${row.deviceId}`;
    const decision = requiredDecision(plan.gridPositions, key, 'explicit grid position required');
    if (!Number.isInteger(decision.gridCol) || !Number.isInteger(decision.gridRow)
      || decision.gridCol < 0 || decision.gridRow < 0) {
      throw new Error(`${key}: grid position must be non-negative integers`);
    }
  }

  const workspaceKeys = new Set(report.workspaceMismatches.map((row) => `${row.ownerType}:${row.ownerId}:${row.deviceId}`));
  rejectUnexpectedKeys('workspaceMismatches', plan.workspaceMismatches, workspaceKeys);
  for (const key of workspaceKeys) {
    const decision = requiredDecision(plan.workspaceMismatches, key, 'explicit workspace ownership decision required');
    if (!['align_device_to_owner', 'remove_membership'].includes(decision.action)) {
      throw new Error(`${key}: unsupported workspace mismatch action`);
    }
  }

  const wallAssignmentIds = new Set(report.wallAssignmentDrift.map((row) => row.deviceId));
  rejectUnexpectedKeys('wallAssignments', plan.wallAssignments, wallAssignmentIds);
  for (const deviceId of wallAssignmentIds) {
    const decision = requiredDecision(plan.wallAssignments, deviceId, 'explicit wall assignment decision required');
    if (!['align_to_membership', 'clear_device_wall'].includes(decision.action)) {
      throw new Error(`${deviceId}: unsupported wall assignment action`);
    }
  }

  const allowedNameIds = new Set(report.misleadingGroups
    .filter((row) => !plan.groupDispositions?.[row.groupId])
    .map((row) => row.groupId));
  for (const row of report.duplicateGroupNames) for (const id of row.groupIds.split(',')) allowedNameIds.add(id);
  rejectUnexpectedKeys('groupNames', plan.groupNames, allowedNameIds);
  for (const row of report.duplicateGroupNames) {
    for (const groupId of row.groupIds.split(',').slice(1)) {
      requiredDecision(plan.groupNames, groupId, 'explicit unique group rename required');
    }
  }
  for (const row of report.misleadingGroups) {
    if (deletedGroups.has(row.groupId) || plan.groupDispositions?.[row.groupId]) continue;
    const decision = requiredDecision(plan.groupNames, row.groupId, 'explicit corrective group name required');
    if (!decision.name || !decision.name.trim()) throw new Error(`${row.groupId}: group name cannot be blank`);
  }
  for (const [groupId, decision] of Object.entries(plan.groupNames || {})) {
    if (!decision.name || !decision.name.trim()) throw new Error(`${groupId}: group name cannot be blank`);
  }

  const impacted = impactedWallIds(report, plan);
  const storedImpacted = new Set([...impacted].filter((wallId) => {
    const wall = db.prepare('SELECT layout_json FROM video_walls WHERE id = ?').get(wallId);
    return wall?.layout_json && String(wall.layout_json).trim();
  }));
  rejectUnexpectedKeys('layoutDefinitions', plan.layoutDefinitions, storedImpacted);
  for (const wallId of storedImpacted) {
    const decision = requiredDecision(plan.layoutDefinitions, wallId, 'explicit stored-layout decision required');
    if (!['preserve', 'regenerate_legacy', 'replace'].includes(decision.action)) {
      throw new Error(`${wallId}: layout action must be preserve, regenerate_legacy, or replace`);
    }
    if (decision.action === 'replace' && (!decision.layout || typeof decision.layout !== 'object')) {
      throw new Error(`${wallId}: replacement layout object required`);
    }
  }

  const leaderWallIds = new Set(report.invalidLeaders.map((row) => row.wallId));
  for (const wallId of impacted) leaderWallIds.add(wallId);
  rejectUnexpectedKeys('leaders', plan.leaders, leaderWallIds);
  for (const wallId of leaderWallIds) {
    const decision = requiredDecision(plan.leaders, wallId, 'explicit wall leader required');
    const remaining = db.prepare('SELECT device_id FROM video_wall_devices WHERE wall_id = ?').all(wallId)
      .map((row) => row.device_id)
      .filter((deviceId) => !membershipWillBeRemoved(report, plan, wallId, deviceId));
    if (remaining.length === 0) {
      if (decision.deviceId != null) throw new Error(`${wallId}: empty wall leader must be null`);
    } else if (!remaining.includes(decision.deviceId)) {
      throw new Error(`${wallId}: leader must be a retained wall member`);
    }
  }
}

function dropTopologyGuards(db) {
  for (const trigger of GUARD_TRIGGERS) db.exec(`DROP TRIGGER IF EXISTS ${trigger}`);
  for (const index of GUARD_INDEXES) db.exec(`DROP INDEX IF EXISTS ${index}`);
}

function installTopologyGuards(db) {
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS ux_device_group_members_one_group
      ON device_group_members(device_id);
    CREATE UNIQUE INDEX IF NOT EXISTS ux_video_wall_devices_one_wall
      ON video_wall_devices(device_id);
    CREATE UNIQUE INDEX IF NOT EXISTS ux_device_groups_workspace_name
      ON device_groups(workspace_id, lower(trim(name)))
      WHERE workspace_id IS NOT NULL;

    CREATE TRIGGER IF NOT EXISTS trg_device_groups_valid_insert
    BEFORE INSERT ON device_groups
    BEGIN
      SELECT CASE WHEN NEW.workspace_id IS NULL OR trim(NEW.workspace_id) = ''
        THEN RAISE(ABORT, 'Every independent group requires a workspace') END;
      SELECT CASE WHEN EXISTS (
        SELECT 1 FROM device_groups g
        WHERE g.workspace_id = NEW.workspace_id AND lower(trim(g.name)) = lower(trim(NEW.name))
      ) THEN RAISE(ABORT, 'Group name must be unique within workspace') END;
    END;
    CREATE TRIGGER IF NOT EXISTS trg_device_groups_valid_update
    BEFORE UPDATE OF workspace_id, name ON device_groups
    BEGIN
      SELECT CASE WHEN NEW.workspace_id IS NULL OR trim(NEW.workspace_id) = ''
        THEN RAISE(ABORT, 'Every independent group requires a workspace') END;
      SELECT CASE WHEN EXISTS (
        SELECT 1 FROM device_groups g
        WHERE g.id <> NEW.id AND g.workspace_id = NEW.workspace_id
          AND lower(trim(g.name)) = lower(trim(NEW.name))
      ) THEN RAISE(ABORT, 'Group name must be unique within workspace') END;
    END;

    CREATE TRIGGER IF NOT EXISTS trg_group_membership_valid_insert
    BEFORE INSERT ON device_group_members
    BEGIN
      SELECT CASE WHEN EXISTS (
        SELECT 1 FROM device_group_members dgm WHERE dgm.device_id = NEW.device_id
      ) THEN RAISE(ABORT, 'Display may belong to only one independent group') END;
      SELECT CASE WHEN EXISTS (
        SELECT 1 FROM video_wall_devices vwd WHERE vwd.device_id = NEW.device_id
      ) OR EXISTS (
        SELECT 1 FROM devices d WHERE d.id = NEW.device_id AND d.wall_id IS NOT NULL
      ) THEN RAISE(ABORT, 'Display cannot belong to a wall and an independent group') END;
      SELECT CASE WHEN NOT EXISTS (
        SELECT 1 FROM devices d JOIN device_groups g ON g.id = NEW.group_id
        WHERE d.id = NEW.device_id AND d.workspace_id = g.workspace_id AND g.workspace_id IS NOT NULL
      ) THEN RAISE(ABORT, 'Group member must belong to the group workspace') END;
    END;
    CREATE TRIGGER IF NOT EXISTS trg_group_membership_valid_update
    BEFORE UPDATE OF device_id, group_id ON device_group_members
    BEGIN
      SELECT CASE WHEN EXISTS (
        SELECT 1 FROM device_group_members dgm
        WHERE dgm.device_id = NEW.device_id
          AND (dgm.device_id <> OLD.device_id OR dgm.group_id <> OLD.group_id)
      ) THEN RAISE(ABORT, 'Display may belong to only one independent group') END;
      SELECT CASE WHEN EXISTS (
        SELECT 1 FROM video_wall_devices vwd WHERE vwd.device_id = NEW.device_id
      ) OR EXISTS (
        SELECT 1 FROM devices d WHERE d.id = NEW.device_id AND d.wall_id IS NOT NULL
      ) THEN RAISE(ABORT, 'Display cannot belong to a wall and an independent group') END;
      SELECT CASE WHEN NOT EXISTS (
        SELECT 1 FROM devices d JOIN device_groups g ON g.id = NEW.group_id
        WHERE d.id = NEW.device_id AND d.workspace_id = g.workspace_id AND g.workspace_id IS NOT NULL
      ) THEN RAISE(ABORT, 'Group member must belong to the group workspace') END;
    END;

    CREATE TRIGGER IF NOT EXISTS trg_wall_dimensions_valid_insert
    BEFORE INSERT ON video_walls
    WHEN NEW.grid_cols <= 0 OR NEW.grid_rows <= 0
    BEGIN SELECT RAISE(ABORT, 'Wall dimensions must be positive'); END;
    CREATE TRIGGER IF NOT EXISTS trg_wall_dimensions_valid_update
    BEFORE UPDATE OF grid_cols, grid_rows ON video_walls
    WHEN NEW.grid_cols <= 0 OR NEW.grid_rows <= 0
    BEGIN SELECT RAISE(ABORT, 'Wall dimensions must be positive'); END;

    CREATE TRIGGER IF NOT EXISTS trg_wall_leader_valid_insert
    BEFORE INSERT ON video_walls
    WHEN NEW.leader_device_id IS NOT NULL
    BEGIN SELECT RAISE(ABORT, 'Wall leader must be assigned after wall membership'); END;

    CREATE TRIGGER IF NOT EXISTS trg_wall_leader_valid_update
    BEFORE UPDATE OF leader_device_id ON video_walls
    WHEN (NEW.leader_device_id IS NULL AND EXISTS (
      SELECT 1 FROM video_wall_devices vwd WHERE vwd.wall_id = NEW.id
    )) OR (NEW.leader_device_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM video_wall_devices vwd
      WHERE vwd.wall_id = NEW.id AND vwd.device_id = NEW.leader_device_id
    ))
    BEGIN SELECT RAISE(ABORT, 'Wall leader must be a current wall member'); END;

    CREATE TRIGGER IF NOT EXISTS trg_wall_membership_valid_insert
    BEFORE INSERT ON video_wall_devices
    BEGIN
      SELECT CASE WHEN EXISTS (
        SELECT 1 FROM video_wall_devices vwd WHERE vwd.device_id = NEW.device_id
      ) THEN RAISE(ABORT, 'Display may belong to only one wall') END;
      SELECT CASE WHEN EXISTS (
        SELECT 1 FROM device_group_members dgm WHERE dgm.device_id = NEW.device_id
      ) THEN RAISE(ABORT, 'Display cannot belong to a wall and an independent group') END;
      SELECT CASE WHEN NOT EXISTS (
        SELECT 1 FROM devices d JOIN video_walls w ON w.id = NEW.wall_id
        WHERE d.id = NEW.device_id AND d.workspace_id = w.workspace_id AND w.workspace_id IS NOT NULL
      ) THEN RAISE(ABORT, 'Wall member must belong to the wall workspace') END;
      SELECT CASE WHEN NOT EXISTS (
        SELECT 1 FROM video_walls w WHERE w.id = NEW.wall_id
          AND NEW.grid_col >= 0 AND NEW.grid_row >= 0
          AND NEW.grid_col < w.grid_cols AND NEW.grid_row < w.grid_rows
      ) THEN RAISE(ABORT, 'Wall member grid position is outside wall bounds') END;
    END;
    CREATE TRIGGER IF NOT EXISTS trg_wall_membership_valid_update
    BEFORE UPDATE OF wall_id, device_id, grid_col, grid_row ON video_wall_devices
    BEGIN
      SELECT CASE WHEN EXISTS (
        SELECT 1 FROM video_wall_devices vwd
        WHERE vwd.device_id = NEW.device_id AND vwd.id <> OLD.id
      ) THEN RAISE(ABORT, 'Display may belong to only one wall') END;
      SELECT CASE WHEN EXISTS (
        SELECT 1 FROM device_group_members dgm WHERE dgm.device_id = NEW.device_id
      ) THEN RAISE(ABORT, 'Display cannot belong to a wall and an independent group') END;
      SELECT CASE WHEN NOT EXISTS (
        SELECT 1 FROM devices d JOIN video_walls w ON w.id = NEW.wall_id
        WHERE d.id = NEW.device_id AND d.workspace_id = w.workspace_id AND w.workspace_id IS NOT NULL
      ) THEN RAISE(ABORT, 'Wall member must belong to the wall workspace') END;
      SELECT CASE WHEN NOT EXISTS (
        SELECT 1 FROM video_walls w WHERE w.id = NEW.wall_id
          AND NEW.grid_col >= 0 AND NEW.grid_row >= 0
          AND NEW.grid_col < w.grid_cols AND NEW.grid_row < w.grid_rows
      ) THEN RAISE(ABORT, 'Wall member grid position is outside wall bounds') END;
    END;

    CREATE TRIGGER IF NOT EXISTS trg_device_wall_reference_valid_update
    BEFORE UPDATE OF wall_id ON devices
    WHEN NEW.wall_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM video_wall_devices vwd
      WHERE vwd.device_id = NEW.id AND vwd.wall_id = NEW.wall_id
    )
    BEGIN SELECT RAISE(ABORT, 'Device wall reference requires matching wall membership'); END;

    CREATE TRIGGER IF NOT EXISTS trg_wall_membership_assign_device
    AFTER INSERT ON video_wall_devices
    BEGIN UPDATE devices SET wall_id = NEW.wall_id WHERE id = NEW.device_id; END;
    CREATE TRIGGER IF NOT EXISTS trg_wall_membership_clear_device
    AFTER DELETE ON video_wall_devices
    BEGIN UPDATE devices SET wall_id = NULL WHERE id = OLD.device_id AND wall_id = OLD.wall_id; END;
    CREATE TRIGGER IF NOT EXISTS trg_wall_membership_choose_leader
    AFTER INSERT ON video_wall_devices
    WHEN (SELECT leader_device_id FROM video_walls WHERE id = NEW.wall_id) IS NULL
    BEGIN
      UPDATE video_walls SET leader_device_id = (
        SELECT device_id FROM video_wall_devices
        WHERE wall_id = NEW.wall_id ORDER BY grid_row, grid_col, device_id LIMIT 1
      ) WHERE id = NEW.wall_id;
    END;
    CREATE TRIGGER IF NOT EXISTS trg_wall_membership_reselect_leader
    AFTER DELETE ON video_wall_devices
    WHEN (SELECT leader_device_id FROM video_walls WHERE id = OLD.wall_id) = OLD.device_id
    BEGIN
      UPDATE video_walls SET leader_device_id = (
        SELECT device_id FROM video_wall_devices
        WHERE wall_id = OLD.wall_id ORDER BY grid_row, grid_col, device_id LIMIT 1
      ) WHERE id = OLD.wall_id;
    END;
  `);
  return { indexes: [...GUARD_INDEXES], triggers: [...GUARD_TRIGGERS] };
}

function applyLayoutDecision(db, wallId, decision) {
  const wall = db.prepare('SELECT * FROM video_walls WHERE id = ?').get(wallId);
  if (!wall) throw new Error(`${wallId}: wall no longer exists`);
  const nextRevision = Number(wall.layout_revision) + 1;
  if (decision.action === 'regenerate_legacy') {
    db.prepare('UPDATE video_walls SET layout_json = NULL, layout_revision = ? WHERE id = ?')
      .run(nextRevision, wallId);
    return;
  }
  const input = decision.action === 'replace' ? decision.layout : JSON.parse(wall.layout_json);
  const validated = validateLayout(wall, layoutMembers(db, wallId), input, {
    revision: nextRevision,
    source: 'repair',
  });
  db.prepare('UPDATE video_walls SET layout_json = ?, layout_revision = ? WHERE id = ?')
    .run(JSON.stringify(validated), nextRevision, wallId);
}

function applyTopologyRepair(db, plan, options = {}) {
  const beforeReport = analyzeTopology(db);
  if (beforeReport.issueCount === 0) {
    const guards = installTopologyGuards(db);
    return { noChanges: true, before: beforeReport, after: beforeReport, guards };
  }
  const beforeSnapshot = snapshotTopology(db);
  const beforeHash = snapshotHash(beforeSnapshot);
  validatePlan(db, beforeReport, plan, beforeHash);
  ensureAuditSchema(db);
  const runId = options.runId || `topology-${Date.now()}-${crypto.randomUUID()}`;
  const actor = options.actor || 'operator';

  const execute = db.transaction(() => {
    const lockedHash = snapshotHash(snapshotTopology(db));
    if (lockedHash !== beforeHash || lockedHash !== plan.expectedSnapshotHash) {
      throw new Error('Topology snapshot hash changed before the repair transaction acquired its write lock');
    }
    for (const [groupId, decision] of Object.entries(plan.orphanGroups || {})) {
      if (decision.action === 'delete') db.prepare('DELETE FROM device_groups WHERE id = ?').run(groupId);
      else db.prepare('UPDATE device_groups SET workspace_id = ? WHERE id = ?').run(decision.workspaceId, groupId);
    }
    for (const [groupId, decision] of Object.entries(plan.groupDispositions || {})) {
      if (decision.action === 'delete') db.prepare('DELETE FROM device_groups WHERE id = ?').run(groupId);
      else db.prepare('UPDATE device_groups SET name = ? WHERE id = ?').run(decision.name.trim(), groupId);
    }
    for (const [deviceId, decision] of Object.entries(plan.membershipConflicts || {})) {
      if (decision.action === 'wall_wins') {
        db.prepare('DELETE FROM device_group_members WHERE device_id = ?').run(deviceId);
      } else {
        db.prepare('DELETE FROM video_wall_devices WHERE device_id = ?').run(deviceId);
        db.prepare('UPDATE devices SET wall_id = NULL WHERE id = ?').run(deviceId);
      }
    }
    for (const [deviceId, decision] of Object.entries(plan.duplicateMemberships || {})) {
      db.prepare('DELETE FROM device_group_members WHERE device_id = ? AND group_id <> ?')
        .run(deviceId, decision.keepGroupId);
    }
    for (const [deviceId, decision] of Object.entries(plan.duplicateWalls || {})) {
      db.prepare('DELETE FROM video_wall_devices WHERE device_id = ? AND wall_id <> ?')
        .run(deviceId, decision.keepWallId);
    }
    for (const [deviceId, decision] of Object.entries(plan.screenState || {})) {
      if (decision.action === 'set_on') db.prepare('UPDATE devices SET screen_on = 1 WHERE id = ?').run(deviceId);
    }
    for (const [wallId, decision] of Object.entries(plan.wallDimensions || {})) {
      db.prepare('UPDATE video_walls SET grid_cols = ?, grid_rows = ? WHERE id = ?')
        .run(decision.gridCols, decision.gridRows, wallId);
    }
    for (const [key, decision] of Object.entries(plan.gridPositions || {})) {
      const [wallId, deviceId] = key.split(':');
      db.prepare('UPDATE video_wall_devices SET grid_col = ?, grid_row = ? WHERE wall_id = ? AND device_id = ?')
        .run(decision.gridCol, decision.gridRow, wallId, deviceId);
    }
    for (const [key, decision] of Object.entries(plan.workspaceMismatches || {})) {
      const [ownerType, ownerId, deviceId] = key.split(':');
      if (decision.action === 'align_device_to_owner') {
        const table = ownerType === 'wall' ? 'video_walls' : 'device_groups';
        const owner = db.prepare(`SELECT workspace_id FROM ${table} WHERE id = ?`).get(ownerId);
        if (!owner?.workspace_id) throw new Error(`${key}: owner has no valid workspace`);
        db.prepare('UPDATE devices SET workspace_id = ? WHERE id = ?').run(owner.workspace_id, deviceId);
      } else if (ownerType === 'wall') {
        db.prepare('DELETE FROM video_wall_devices WHERE wall_id = ? AND device_id = ?').run(ownerId, deviceId);
        db.prepare('UPDATE devices SET wall_id = NULL WHERE id = ? AND wall_id = ?').run(deviceId, ownerId);
      } else {
        db.prepare('DELETE FROM device_group_members WHERE group_id = ? AND device_id = ?').run(ownerId, deviceId);
      }
    }
    for (const [deviceId, decision] of Object.entries(plan.wallAssignments || {})) {
      if (decision.action === 'align_to_membership') {
        const member = db.prepare('SELECT wall_id FROM video_wall_devices WHERE device_id = ?').get(deviceId);
        db.prepare('UPDATE devices SET wall_id = ? WHERE id = ?').run(member ? member.wall_id : null, deviceId);
      } else {
        db.prepare('UPDATE devices SET wall_id = NULL WHERE id = ?').run(deviceId);
      }
    }
    for (const [groupId, decision] of Object.entries(plan.groupNames || {})) {
      db.prepare('UPDATE device_groups SET name = ? WHERE id = ?').run(decision.name.trim(), groupId);
    }
    for (const [wallId, decision] of Object.entries(plan.layoutDefinitions || {})) {
      applyLayoutDecision(db, wallId, decision);
    }
    for (const [wallId, decision] of Object.entries(plan.leaders || {})) {
      if (decision.deviceId == null) {
        const count = db.prepare('SELECT COUNT(*) AS n FROM video_wall_devices WHERE wall_id = ?').get(wallId).n;
        if (count !== 0) throw new Error(`${wallId}: cannot clear leader while members remain`);
      } else if (!db.prepare(
        'SELECT 1 FROM video_wall_devices WHERE wall_id = ? AND device_id = ?'
      ).get(wallId, decision.deviceId)) {
        throw new Error(`${wallId}: selected leader is no longer a wall member`);
      }
      db.prepare('UPDATE video_walls SET leader_device_id = ? WHERE id = ?').run(decision.deviceId, wallId);
    }

    const afterReport = analyzeTopology(db);
    if (afterReport.issueCount !== 0) {
      throw new Error(`Repair plan left ${afterReport.issueCount} topology issue(s): ${JSON.stringify(afterReport)}`);
    }
    const guards = installTopologyGuards(db);
    const afterSnapshot = snapshotTopology(db);
    const afterHash = snapshotHash(afterSnapshot);
    db.prepare(`
      INSERT INTO ${AUDIT_TABLE}
        (id, migration_id, schema_version, actor, plan_json, before_json, after_json,
         before_hash, after_hash, status, applied_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'applied', ?)
    `).run(
      runId, MIGRATION_ID, REPAIR_SCHEMA_VERSION, actor, JSON.stringify(plan),
      JSON.stringify(beforeSnapshot), JSON.stringify(afterSnapshot), beforeHash, afterHash,
      Math.floor(Date.now() / 1000)
    );
    return { afterReport, afterHash, guards };
  });

  const result = execute.immediate();
  return {
    runId,
    noChanges: false,
    before: beforeReport,
    after: result.afterReport,
    beforeHash,
    afterHash: result.afterHash,
    guards: result.guards,
  };
}

function restoreRows(db, table, snapshotRows, keyColumns, options = {}) {
  if (!snapshotRows.length) return;
  const columns = Object.keys(snapshotRows[0]);
  const updateColumns = columns.filter((column) => !keyColumns.includes(column));
  const where = keyColumns.map((column) => `${column} = ?`).join(' AND ');
  const insert = options.allowInsert
    ? db.prepare(`INSERT INTO ${table} (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`)
    : null;
  const update = updateColumns.length
    ? db.prepare(`UPDATE ${table} SET ${updateColumns.map((column) => `${column} = ?`).join(', ')} WHERE ${where}`)
    : null;
  for (const row of snapshotRows) {
    const keyValues = keyColumns.map((column) => row[column]);
    const exists = db.prepare(`SELECT 1 FROM ${table} WHERE ${where}`).get(...keyValues);
    if (exists && update) update.run(...updateColumns.map((column) => row[column]), ...keyValues);
    else if (!exists && insert) insert.run(...columns.map((column) => row[column]));
    else if (!exists) throw new Error(`Rollback row is missing: ${table} ${JSON.stringify(keyValues)}`);
  }
}

function rollbackTopologyRepair(db, runId, options = {}) {
  assertRequiredSchema(db);
  ensureAuditSchema(db);
  const actor = options.actor || 'operator';
  const execute = db.transaction(() => {
    const run = db.prepare(`SELECT * FROM ${AUDIT_TABLE} WHERE id = ?`).get(runId);
    if (!run) throw new Error(`Unknown topology repair run: ${runId}`);
    if (run.status !== 'applied') throw new Error(`Topology repair run is not rollback-eligible: ${run.status}`);
    const currentHash = snapshotHash(snapshotTopology(db));
    if (currentHash !== run.after_hash) {
      throw new Error('Topology changed after repair; refusing to overwrite newer state');
    }
    const before = JSON.parse(run.before_json);
    dropTopologyGuards(db);
    db.prepare('DELETE FROM device_group_members').run();
    db.prepare('DELETE FROM video_wall_devices').run();
    restoreRows(db, 'device_groups', before.device_groups, ['id'], { allowInsert: true });
    restoreRows(db, 'video_walls', before.video_walls, ['id']);
    restoreRows(db, 'devices', before.devices, ['id']);
    restoreRows(db, 'device_group_members', before.device_group_members, ['device_id', 'group_id'], { allowInsert: true });
    restoreRows(db, 'video_wall_devices', before.video_wall_devices, ['wall_id', 'device_id'], { allowInsert: true });
    restoreRows(db, 'schedules', before.schedules, ['id']);
    const restoredHash = snapshotHash(snapshotTopology(db));
    if (restoredHash !== run.before_hash) throw new Error('Rollback verification hash mismatch');
    db.prepare(`UPDATE ${AUDIT_TABLE} SET status = 'rolled_back', rolled_back_at = ?, rolled_back_by = ? WHERE id = ?`)
      .run(Math.floor(Date.now() / 1000), actor, runId);
  });
  execute.immediate();
  return { runId, status: 'rolled_back', guardsRemoved: true };
}

module.exports = {
  AUDIT_TABLE,
  MIGRATION_ID,
  REPAIR_SCHEMA_VERSION,
  analyzeTopology,
  applyTopologyRepair,
  assertRequiredSchema,
  dropTopologyGuards,
  installTopologyGuards,
  rollbackTopologyRepair,
  snapshotTopology,
  snapshotHash,
};
