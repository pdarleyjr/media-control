const { test } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');

const {
  TopologyConflictError,
  assertCanJoinIndependentGroup,
  assertCanJoinWall,
} = require('../lib/topology-membership');

function fixture() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE devices (id TEXT PRIMARY KEY, wall_id TEXT);
    CREATE TABLE device_group_members (device_id TEXT, group_id TEXT);
    CREATE TABLE video_wall_devices (wall_id TEXT, device_id TEXT);
    INSERT INTO devices VALUES ('free', NULL), ('grouped', NULL), ('walled', 'wall-1');
    INSERT INTO device_group_members VALUES ('grouped', 'group-1');
    INSERT INTO video_wall_devices VALUES ('wall-1', 'walled');
  `);
  return db;
}

test('group assignment rejects wall membership and a second independent group', () => {
  const db = fixture();
  assert.throws(
    () => assertCanJoinIndependentGroup(db, 'walled', 'group-1'),
    (error) => error instanceof TopologyConflictError && error.code === 'DEVICE_ALREADY_IN_WALL' && error.statusCode === 409
  );
  assert.throws(
    () => assertCanJoinIndependentGroup(db, 'grouped', 'group-2'),
    (error) => error instanceof TopologyConflictError && error.code === 'DEVICE_ALREADY_IN_GROUP' && error.statusCode === 409
  );
  assert.deepEqual(assertCanJoinIndependentGroup(db, 'grouped', 'group-1'), { alreadyMember: true });
  assert.deepEqual(assertCanJoinIndependentGroup(db, 'free', 'group-1'), { alreadyMember: false });
});

test('wall assignment rejects a second wall but reports group membership for atomic transfer', () => {
  const db = fixture();
  assert.throws(
    () => assertCanJoinWall(db, 'walled', 'wall-2'),
    (error) => error instanceof TopologyConflictError && error.code === 'DEVICE_ALREADY_IN_WALL' && error.statusCode === 409
  );
  assert.deepEqual(assertCanJoinWall(db, 'grouped', 'wall-1'), { groupIdsToRemove: ['group-1'] });
  assert.deepEqual(assertCanJoinWall(db, 'free', 'wall-1'), { groupIdsToRemove: [] });
});
