const { test } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');

const {
  analyzeTopology,
  applyTopologyRepair,
  rollbackTopologyRepair,
  snapshotHash,
  snapshotTopology,
} = require('../lib/topology-repair');

function fixture() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE workspaces (id TEXT PRIMARY KEY, name TEXT NOT NULL);
    CREATE TABLE workspace_members (
      workspace_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'workspace_viewer',
      PRIMARY KEY (workspace_id, user_id)
    );
    CREATE TABLE users (id TEXT PRIMARY KEY);
    CREATE TABLE devices (
      id TEXT PRIMARY KEY,
      user_id TEXT,
      workspace_id TEXT,
      name TEXT NOT NULL,
      wall_id TEXT,
      screen_on INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE device_groups (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      workspace_id TEXT,
      name TEXT NOT NULL,
      color TEXT,
      playlist_id TEXT
    );
    CREATE TABLE device_group_members (
      device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
      group_id TEXT NOT NULL REFERENCES device_groups(id) ON DELETE CASCADE,
      PRIMARY KEY (device_id, group_id)
    );
    CREATE TABLE video_walls (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      workspace_id TEXT,
      name TEXT NOT NULL,
      grid_cols INTEGER NOT NULL,
      grid_rows INTEGER NOT NULL,
      leader_device_id TEXT,
      layout_mode TEXT NOT NULL DEFAULT 'span',
      layout_json TEXT,
      layout_revision INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE video_wall_devices (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      wall_id TEXT NOT NULL REFERENCES video_walls(id) ON DELETE CASCADE,
      device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
      grid_col INTEGER NOT NULL,
      grid_row INTEGER NOT NULL,
      rotation INTEGER NOT NULL DEFAULT 0,
      UNIQUE(wall_id, device_id),
      UNIQUE(wall_id, grid_col, grid_row)
    );
    CREATE TABLE schedules (
      id TEXT PRIMARY KEY,
      group_id TEXT REFERENCES device_groups(id) ON DELETE SET NULL,
      title TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE schema_migrations (id TEXT PRIMARY KEY, ran_at INTEGER);
  `);
  db.prepare("INSERT INTO workspaces VALUES ('ws-1', 'Classroom 1')").run();
  db.prepare("INSERT INTO users VALUES ('user-1')").run();
  db.prepare("INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ('ws-1', 'user-1', 'workspace_admin')").run();
  const insertDevice = db.prepare('INSERT INTO devices VALUES (?, ?, ?, ?, ?, ?)');
  insertDevice.run('tv-1', 'user-1', 'ws-1', 'Front Left', 'wall-1', 1);
  insertDevice.run('tv-2', 'user-1', 'ws-1', 'Front Center', 'wall-1', 0);
  insertDevice.run('tv-3', 'user-1', 'ws-1', 'Front Right', null, 1);
  db.prepare("INSERT INTO video_walls VALUES ('wall-1', 'user-1', 'ws-1', 'Primary', 2, 1, NULL, 'span', NULL, 0)").run();
  db.prepare("INSERT INTO video_wall_devices (wall_id, device_id, grid_col, grid_row) VALUES ('wall-1', 'tv-1', 0, 0)").run();
  db.prepare("INSERT INTO video_wall_devices (wall_id, device_id, grid_col, grid_row) VALUES ('wall-1', 'tv-2', 1, 0)").run();
  db.prepare("INSERT INTO device_groups VALUES ('group-orphan', 'user-1', NULL, 'All Displays', '#fff', NULL)").run();
  db.prepare("INSERT INTO device_group_members VALUES ('tv-1', 'group-orphan')").run();
  return db;
}

function planFor(db, overrides = {}) {
  return {
    schemaVersion: 1,
    expectedSnapshotHash: snapshotHash(snapshotTopology(db)),
    orphanGroups: {
      'group-orphan': { action: 'assign_workspace', workspaceId: 'ws-1' },
    },
    membershipConflicts: {
      'tv-1': { action: 'wall_wins' },
    },
    screenState: {
      'tv-2': { action: 'set_on' },
    },
    leaders: {
      'wall-1': { deviceId: 'tv-1' },
    },
    groupNames: {
      'group-orphan': { name: 'Classroom 1 Independent Displays' },
    },
    ...overrides,
  };
}

test('topology analysis reports every unsafe current-state category without mutating', () => {
  const db = fixture();
  const before = db.serialize();

  const report = analyzeTopology(db);

  assert.deepEqual(report.orphanGroups.map((row) => row.id), ['group-orphan']);
  assert.deepEqual(report.wallGroupConflicts.map((row) => row.deviceId), ['tv-1']);
  assert.deepEqual(report.wallMembersScreenOff.map((row) => row.deviceId), ['tv-2']);
  assert.deepEqual(report.invalidLeaders.map((row) => row.wallId), ['wall-1']);
  assert.equal(report.misleadingGroups[0].groupId, 'group-orphan');
  assert.deepEqual(db.serialize(), before, 'dry-run analysis must not change the database');
});

test('apply fails closed until the plan resolves every destructive ambiguity', () => {
  const db = fixture();

  assert.throws(
    () => applyTopologyRepair(db, {
      schemaVersion: 1,
      expectedSnapshotHash: snapshotHash(snapshotTopology(db)),
      orphanGroups: {},
      membershipConflicts: {},
      screenState: {},
      leaders: {},
    }, { actor: 'test' }),
    /group-orphan.*explicit orphan-group decision/i
  );
});

test('explicit repair is idempotent, audited, integrity-checked, and reversible', () => {
  const db = fixture();
  const plan = planFor(db);

  const applied = applyTopologyRepair(db, plan, { actor: 'test', runId: 'run-1' });
  assert.equal(applied.runId, 'run-1');
  assert.equal(applied.after.issueCount, 0);
  assert.equal(db.prepare("SELECT workspace_id FROM device_groups WHERE id = 'group-orphan'").get().workspace_id, 'ws-1');
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM device_group_members WHERE device_id = 'tv-1'").get().n, 0);
  assert.equal(db.prepare("SELECT screen_on FROM devices WHERE id = 'tv-2'").get().screen_on, 1);
  assert.equal(db.prepare("SELECT leader_device_id FROM video_walls WHERE id = 'wall-1'").get().leader_device_id, 'tv-1');

  const second = applyTopologyRepair(db, plan, { actor: 'test', runId: 'run-2' });
  assert.equal(second.noChanges, true);

  const rolledBack = rollbackTopologyRepair(db, 'run-1', { actor: 'test' });
  assert.equal(rolledBack.status, 'rolled_back');
  assert.equal(db.prepare("SELECT workspace_id FROM device_groups WHERE id = 'group-orphan'").get().workspace_id, null);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM device_group_members WHERE device_id = 'tv-1'").get().n, 1);
  assert.equal(db.prepare("SELECT screen_on FROM devices WHERE id = 'tv-2'").get().screen_on, 0);
  assert.equal(db.prepare("SELECT leader_device_id FROM video_walls WHERE id = 'wall-1'").get().leader_device_id, null);
});

test('rollback refuses to overwrite topology changed after the repair', () => {
  const db = fixture();
  const plan = planFor(db);
  applyTopologyRepair(db, plan, { actor: 'test', runId: 'run-guard' });
  db.prepare("UPDATE devices SET screen_on = 0 WHERE id = 'tv-3'").run();

  assert.throws(
    () => rollbackTopologyRepair(db, 'run-guard', { actor: 'test' }),
    /topology changed after repair/i
  );
});

test('analysis fails closed when the required topology schema is absent', () => {
  const db = new Database(':memory:');
  assert.throws(() => analyzeTopology(db), /required topology (table|column)/i);
});

test('apply rejects unexpected plan keys and a stale snapshot hash', () => {
  const db = fixture();
  const unexpected = planFor(db, {
    groupNames: {
      'group-orphan': { name: 'Classroom 1 Independent Displays' },
      'unreported-group': { name: 'Unauthorized mutation' },
    },
  });
  assert.throws(() => applyTopologyRepair(db, unexpected, { actor: 'test' }), /unexpected.*unreported-group/i);

  const stale = planFor(db, { expectedSnapshotHash: '0'.repeat(64) });
  assert.throws(() => applyTopologyRepair(db, stale, { actor: 'test' }), /snapshot hash/i);
});

test('deleting and rolling back an orphan group restores dependent schedule links', () => {
  const db = fixture();
  db.prepare("INSERT INTO schedules (id, group_id, title) VALUES ('schedule-1', 'group-orphan', 'Morning')").run();
  const plan = planFor(db, {
    expectedSnapshotHash: snapshotHash(snapshotTopology(db)),
    orphanGroups: { 'group-orphan': { action: 'delete' } },
    membershipConflicts: {},
    groupNames: {},
  });

  applyTopologyRepair(db, plan, { actor: 'test', runId: 'run-delete' });
  assert.equal(db.prepare("SELECT group_id FROM schedules WHERE id = 'schedule-1'").get().group_id, null);

  rollbackTopologyRepair(db, 'run-delete', { actor: 'test' });
  assert.equal(db.prepare("SELECT group_id FROM schedules WHERE id = 'schedule-1'").get().group_id, 'group-orphan');
});

test('repair installs durable guards for one group, one wall, mutual exclusion, and unique names', () => {
  const db = fixture();
  applyTopologyRepair(db, planFor(db), { actor: 'test', runId: 'run-guards' });

  db.prepare("INSERT INTO device_groups VALUES ('group-2', 'user-1', 'ws-1', 'Second Group', '#fff', NULL)").run();
  db.prepare("INSERT INTO device_group_members VALUES ('tv-3', 'group-orphan')").run();
  assert.throws(
    () => db.prepare("INSERT INTO device_group_members VALUES ('tv-3', 'group-2')").run(),
    /one independent group/i
  );
  assert.throws(
    () => db.prepare("INSERT INTO device_group_members VALUES ('tv-1', 'group-2')").run(),
    /wall and an independent group/i
  );
  assert.throws(
    () => db.prepare("INSERT INTO device_groups VALUES ('group-3', 'user-1', 'ws-1', ' second group ', '#fff', NULL)").run(),
    /unique/i
  );

  assert.throws(
    () => db.prepare("INSERT INTO video_walls VALUES ('wall-invalid-leader', 'user-1', 'ws-1', 'Invalid Leader', 1, 1, 'tv-1', 'span', NULL, 0)").run(),
    /leader must be assigned after wall membership/i
  );

  db.prepare("INSERT INTO video_walls VALUES ('wall-2', 'user-1', 'ws-1', 'Secondary', 1, 1, NULL, 'span', NULL, 0)").run();
  assert.throws(
    () => db.prepare("INSERT INTO video_wall_devices (wall_id, device_id, grid_col, grid_row) VALUES ('wall-2', 'tv-1', 0, 0)").run(),
    /one wall/i
  );
});

test('member-changing repair requires an explicit stored-layout decision', () => {
  const db = fixture();
  db.prepare(`UPDATE video_walls SET layout_json = ?, leader_device_id = 'tv-1' WHERE id = 'wall-1'`).run(JSON.stringify({
    version: 1,
    groups: [{ layout: 'span', member_ids: ['tv-1', 'tv-2'] }],
  }));
  const base = planFor(db, {
    expectedSnapshotHash: snapshotHash(snapshotTopology(db)),
    membershipConflicts: { 'tv-1': { action: 'group_wins' } },
    leaders: {},
  });
  assert.throws(() => applyTopologyRepair(db, base, { actor: 'test' }), /wall-1.*explicit stored-layout/i);

  const repaired = {
    ...base,
    leaders: { 'wall-1': { deviceId: 'tv-2' } },
    layoutDefinitions: { 'wall-1': { action: 'regenerate_legacy' } },
  };
  const result = applyTopologyRepair(db, repaired, { actor: 'test', runId: 'run-layout' });
  assert.equal(result.after.issueCount, 0);
  const wall = db.prepare("SELECT layout_json, layout_revision, leader_device_id FROM video_walls WHERE id = 'wall-1'").get();
  assert.equal(wall.layout_json, null);
  assert.equal(wall.layout_revision, 1);
  assert.equal(wall.leader_device_id, 'tv-2');
});

test('wall-alias groups require explicit deletion or an accurate independent-group rename', () => {
  const db = fixture();
  db.prepare("INSERT INTO device_groups VALUES ('group-wall-alias', 'user-1', 'ws-1', 'Primary', '#fff', NULL)").run();
  const report = analyzeTopology(db);
  assert.deepEqual(report.wallAliasGroups.map((row) => row.groupId), ['group-wall-alias']);

  const withoutDecision = planFor(db, { expectedSnapshotHash: snapshotHash(snapshotTopology(db)) });
  assert.throws(() => applyTopologyRepair(db, withoutDecision, { actor: 'test' }), /group-wall-alias.*wall-alias disposition/i);

  const plan = {
    ...withoutDecision,
    groupDispositions: { 'group-wall-alias': { action: 'delete' } },
  };
  const applied = applyTopologyRepair(db, plan, { actor: 'test', runId: 'run-alias' });
  assert.equal(applied.after.issueCount, 0);
  assert.equal(db.prepare("SELECT 1 FROM device_groups WHERE id = 'group-wall-alias'").get(), undefined);
});
