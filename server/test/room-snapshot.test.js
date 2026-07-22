'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');

const {
  ROOM_SNAPSHOT_SCHEMA_VERSION,
  ensureRoomRevisionSchema,
  getRoomRevision,
  bumpRoomRevision,
  buildRoomSnapshot,
} = require('../lib/room-snapshot');

function createFixtureDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE devices (
      id TEXT PRIMARY KEY,
      workspace_id TEXT,
      name TEXT,
      status TEXT,
      last_heartbeat INTEGER,
      screen_on INTEGER,
      screen_width INTEGER,
      screen_height INTEGER,
      wall_id TEXT,
      layout_id TEXT,
      playlist_id TEXT,
      updated_at INTEGER,
      device_token TEXT
    );
    CREATE TABLE display_states (
      target_type TEXT,
      target_id TEXT,
      workspace_id TEXT,
      current_content_id TEXT,
      current_asset_id TEXT,
      content_type TEXT,
      layout_mode TEXT,
      slide_index INTEGER,
      slide_count INTEGER,
      current_time REAL,
      duration REAL,
      paused INTEGER,
      muted INTEGER,
      volume INTEGER,
      local_asset_ready INTEGER,
      last_ack_at INTEGER,
      last_heartbeat_at INTEGER,
      render_state TEXT,
      error_state TEXT,
      wall_id TEXT,
      layout_id TEXT,
      group_id TEXT,
      member_id TEXT,
      playback_revision INTEGER,
      command_revision TEXT,
      state_revision INTEGER,
      updated_at INTEGER,
      PRIMARY KEY (target_type, target_id)
    );
    CREATE TABLE managed_nodes (
      node_id TEXT PRIMARY KEY,
      node_name TEXT,
      node_type TEXT,
      room_id TEXT,
      workspace_id TEXT,
      last_heartbeat INTEGER,
      software_version TEXT,
      free_disk INTEGER,
      cache_size INTEGER,
      sync_status TEXT,
      audio_endpoint TEXT,
      network_state_json TEXT,
      telemetry_json TEXT,
      node_token TEXT,
      updated_at INTEGER
    );
    CREATE TABLE video_walls (
      id TEXT PRIMARY KEY,
      workspace_id TEXT,
      name TEXT,
      grid_cols INTEGER,
      grid_rows INTEGER,
      sync_mode TEXT,
      layout_mode TEXT,
      is_locked INTEGER,
      leader_device_id TEXT,
      content_id TEXT,
      playlist_id TEXT,
      layout_json TEXT,
      layout_revision INTEGER,
      updated_at INTEGER
    );
    CREATE TABLE video_wall_devices (
      wall_id TEXT,
      device_id TEXT,
      grid_col INTEGER,
      grid_row INTEGER,
      rotation INTEGER,
      canvas_x REAL,
      canvas_y REAL,
      canvas_width REAL,
      canvas_height REAL
    );
    CREATE TABLE device_groups (
      id TEXT PRIMARY KEY,
      workspace_id TEXT,
      name TEXT,
      color TEXT,
      playlist_id TEXT
    );
    CREATE TABLE device_group_members (device_id TEXT, group_id TEXT);
    CREATE TABLE command_logs (
      command_id TEXT PRIMARY KEY,
      target_type TEXT,
      target_id TEXT,
      command_type TEXT,
      revision INTEGER,
      parent_command_id TEXT,
      issued_by TEXT,
      created_at INTEGER,
      requires_ack INTEGER,
      ack_deadline INTEGER,
      status TEXT,
      ack_at INTEGER,
      ack_error TEXT,
      payload TEXT
    );
  `);
  return db;
}

test('room revisions are room-scoped, monotonic, and survive a database reopen', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mbfd-room-revision-'));
  const dbPath = path.join(tempDir, 'state.db');
  let db = new Database(dbPath);
  try {
    ensureRoomRevisionSchema(db);
    assert.equal(getRoomRevision(db, 'ws-1', 'classroom-1'), 0);
    assert.equal(bumpRoomRevision(db, 'ws-1', 'classroom-1', 'command:sent'), 1);
    assert.equal(bumpRoomRevision(db, 'ws-1', 'classroom-1', 'device:ack'), 2);
    assert.equal(bumpRoomRevision(db, 'ws-1', 'eoc', 'layout:changed'), 1);
    db.close();

    db = new Database(dbPath);
    ensureRoomRevisionSchema(db);
    assert.equal(getRoomRevision(db, 'ws-1', 'classroom-1'), 2);
    assert.equal(getRoomRevision(db, 'ws-1', 'eoc'), 1);
    const columns = db.prepare('PRAGMA table_info(room_state_revisions)').all();
    assert.deepEqual(columns.filter((column) => column.pk).map((column) => column.name), [
      'workspace_id',
      'room_id',
    ]);
  } finally {
    if (db.open) db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('room revision helpers reject missing workspace or room identities', () => {
  const db = new Database(':memory:');
  try {
    ensureRoomRevisionSchema(db);
    assert.throws(() => getRoomRevision(db, '', 'classroom-1'), /workspaceId/);
    assert.throws(() => bumpRoomRevision(db, 'ws-1', '  '), /roomId/);
  } finally {
    db.close();
  }
});

test('hot revision reads initialize an unprepared database only once', () => {
  const sqlite = new Database(':memory:');
  let schemaExecs = 0;
  const db = {
    exec(sql) {
      schemaExecs += 1;
      return sqlite.exec(sql);
    },
    prepare: sqlite.prepare.bind(sqlite),
    transaction: sqlite.transaction.bind(sqlite),
  };
  try {
    assert.equal(getRoomRevision(db, 'ws-1', 'classroom-1'), 0);
    assert.equal(getRoomRevision(db, 'ws-1', 'classroom-1'), 0);
    assert.equal(getRoomRevision(db, 'ws-1', 'eoc'), 0);
    assert.equal(schemaExecs, 1, 'schema DDL must not run on every resume cursor read');
  } finally {
    sqlite.close();
  }
});

test('authoritative snapshot loads workspace and room state without leaking credentials', () => {
  const db = createFixtureDb();
  try {
    ensureRoomRevisionSchema(db);
    db.prepare(`INSERT INTO devices VALUES
      ('display-a', 'ws-1', 'Front Left', 'online', 1700000000, 1, 3840, 2160,
       'wall-a', 'layout-a', 'playlist-a', 1700000001, 'device-secret'),
      ('live-stream-program-abc', 'ws-1', 'Content for live stream', 'online', 1700000000,
       1, 1920, 1080, NULL, NULL, 'playlist-live', 1700000001, 'live-secret'),
      ('other-display', 'ws-2', 'Other', 'online', 1700000000, 1, 1920, 1080,
       NULL, NULL, NULL, 1700000001, 'other-secret')`).run();
    const insertState = db.prepare(`INSERT INTO display_states
      (target_type, target_id, workspace_id, current_content_id, current_asset_id,
       content_type, layout_mode, slide_index, slide_count, current_time, duration,
       paused, muted, volume, local_asset_ready, last_ack_at, last_heartbeat_at,
       render_state, error_state, wall_id, layout_id, group_id, member_id,
       playback_revision, command_revision, state_revision, updated_at)
      VALUES
      (@target_type, @target_id, @workspace_id, @current_content_id, @current_asset_id,
       @content_type, @layout_mode, @slide_index, @slide_count, @current_time, @duration,
       @paused, @muted, @volume, @local_asset_ready, @last_ack_at, @last_heartbeat_at,
       @render_state, @error_state, @wall_id, @layout_id, @group_id, @member_id,
       @playback_revision, @command_revision, @state_revision, @updated_at)`);
    insertState.run({
      target_type: 'display', target_id: 'display-a', workspace_id: 'ws-1',
      current_content_id: 'content-a', current_asset_id: 'asset-a', content_type: 'video',
      layout_mode: 'wall-member', slide_index: 0, slide_count: 1, current_time: 12.5,
      duration: 60, paused: 0, muted: 1, volume: 50, local_asset_ready: 1,
      last_ack_at: 1700000000100, last_heartbeat_at: 1700000000200,
      render_state: 'playing', error_state: null, wall_id: 'wall-a', layout_id: 'layout-a',
      group_id: 'group-a', member_id: 'member-a', playback_revision: 8,
      command_revision: 'cmd-1', state_revision: 9, updated_at: 1700000000300,
    });
    insertState.run({
      target_type: 'display', target_id: 'other-display', workspace_id: 'ws-2',
      current_content_id: 'private-content', current_asset_id: null, content_type: 'video',
      layout_mode: null, slide_index: null, slide_count: null, current_time: null,
      duration: null, paused: null, muted: null, volume: null, local_asset_ready: null,
      last_ack_at: null, last_heartbeat_at: null, render_state: null, error_state: null,
      wall_id: null, layout_id: null, group_id: null, member_id: null,
      playback_revision: null, command_revision: null, state_revision: 1,
      updated_at: 1700000000300,
    });
    db.prepare(`INSERT INTO managed_nodes VALUES
      ('p3', 'Podium', 'cache-agent', 'classroom-1', 'ws-1', 1700000000, '1.2.3',
       1000, 500, 'ready', 'hdmi', '{"wired":true,"token":"hidden"}',
       '{"cpu":10,"password":"hidden"}', 'node-secret', 1700000001),
      ('eoc-node', 'EOC', 'cache-agent', 'eoc', 'ws-1', 1700000000, '1.2.3',
       1000, 500, 'ready', 'hdmi', '{}', '{}', 'node-secret', 1700000001)`).run();
    db.prepare(`INSERT INTO video_walls VALUES
      ('wall-a', 'ws-1', 'Primary Wall', 3, 1, 'leader', 'span', 1, 'display-a',
       'content-a', 'playlist-a', '{"version":1,"groups":[]}', 7, 1700000001)`).run();
    db.prepare(`INSERT INTO video_wall_devices VALUES
      ('wall-a', 'display-a', 0, 0, 0, 0, 0, 3840, 2160)`).run();
    db.prepare(`INSERT INTO device_groups VALUES
      ('group-a', 'ws-1', 'Independent Podium', '#fff', NULL)`).run();
    db.prepare(`INSERT INTO device_group_members VALUES ('display-a', 'group-a')`).run();
    db.prepare(`INSERT INTO command_logs VALUES
      ('cmd-1', 'display', 'display-a', 'play', 1, NULL, 'operator', 1700000000000,
       1, 1700000008000, 'sent', NULL, NULL, '{"device_token":"must-not-leak"}'),
      ('cmd-other', 'display', 'other-display', 'play', 1, NULL, 'other', 1700000001000,
       1, 1700000009000, 'sent', NULL, NULL, '{"secret":"must-not-leak"}')`).run();
    bumpRoomRevision(db, 'ws-1', 'classroom-1', 'fixture');

    const snapshot = buildRoomSnapshot({
      db,
      workspaceId: 'ws-1',
      roomId: 'classroom-1',
      serverTimestamp: 1700000005000,
      recordingState: { status: 'recording', accessToken: 'recording-secret' },
      streamState: {
        status: 'live', active: true, viewers: 12,
        nested: { password: 'stream-secret', viewers: 99 },
      },
    });

    assert.equal(ROOM_SNAPSHOT_SCHEMA_VERSION, 1);
    assert.deepEqual(Object.keys(snapshot), [
      'schemaVersion', 'workspaceId', 'roomId', 'revision', 'serverTimestamp',
      'confirmedState', 'pendingCommands', 'lastCommandId', 'deviceStates',
      'layoutState', 'classroomProgram', 'livestreamProgram', 'recordingState',
      'streamState',
    ]);
    assert.equal(snapshot.revision, 1);
    assert.equal(snapshot.serverTimestamp, 1700000005000);
    assert.deepEqual(snapshot.confirmedState.displays.map((display) => display.id), ['display-a']);
    assert.equal(snapshot.confirmedState.displays[0].name, 'Front Left');
    assert.deepEqual(snapshot.deviceStates.displays.map((display) => display.id), ['display-a']);
    assert.deepEqual(snapshot.deviceStates.nodes.map((node) => node.id), ['p3']);
    assert.equal(snapshot.layoutState.walls[0].leaderDeviceId, 'display-a');
    assert.deepEqual(snapshot.layoutState.walls[0].members.map((member) => member.deviceId), ['display-a']);
    assert.deepEqual(snapshot.layoutState.groups[0].memberIds, ['display-a']);
    assert.deepEqual(snapshot.pendingCommands.map((command) => command.commandId), ['cmd-1']);
    assert.equal(snapshot.lastCommandId, 'cmd-1');
    assert.equal(snapshot.classroomProgram.targets[0].contentId, 'content-a');
    assert.equal(snapshot.livestreamProgram.displayId, 'live-stream-program-abc');
    assert.deepEqual(snapshot.recordingState, { status: 'recording' });
    assert.deepEqual(snapshot.streamState, { status: 'live', active: true, viewers: 12 });

    const serialized = JSON.stringify(snapshot).toLowerCase();
    assert.doesNotMatch(serialized, /must-not-leak|device-secret|node-secret|recording-secret|stream-secret/);
    assert.doesNotMatch(serialized, /device_token|accesstoken|password/);
  } finally {
    db.close();
  }
});

test('explicit state overrides are normalized and cannot change contract identity or revision', () => {
  const db = createFixtureDb();
  try {
    ensureRoomRevisionSchema(db);
    bumpRoomRevision(db, 'ws-1', 'classroom-1', 'fixture');
    const snapshot = buildRoomSnapshot({
      db,
      workspaceId: 'ws-1',
      roomId: 'classroom-1',
      serverTimestamp: 42,
      confirmedState: {
        displays: [{
          id: 'override', name: 'Override display', status: 'online', api_key: 'hidden',
          arbitraryOperationalData: { authorization: 'hidden' },
        }],
        privateSection: { secret: 'hidden' },
      },
      pendingCommands: [{
        commandId: 'override-command', targetType: 'display', targetId: 'override',
        commandType: 'play', status: 'sent', authorization: 'hidden',
        arbitraryOperationalData: 'must-not-survive',
      }],
      lastCommandId: 'override-command',
      deviceStates: {
        displays: [{ id: 'override', name: 'Override display', status: 'online', password: 'hidden' }],
        nodes: [{
          id: 'p3', name: 'Podium', type: 'cache-agent', roomId: 'classroom-1',
          networkState: {
            adapter_name: 'Ethernet', link_status: 'healthy', unexpected: 'drop-me',
          },
          telemetry: {
            agent_uptime_sec: 120,
            cache: { cache_hits: 9, sessionToken: 'hidden', unexpected: 'drop-me' },
            arbitraryOperationalData: 'drop-me',
          },
          nodeToken: 'hidden',
        }],
        unexpected: [{ credential: 'hidden' }],
      },
      layoutState: {
        walls: [{
          id: 'wall-a', name: 'Primary', layoutMode: 'span', layoutRevision: 3,
          layout: {
            version: 1, preset: 'span-all',
            groups: [{
              id: 'group-1', name: 'All', layout: 'span', member_ids: ['override'],
              token: 'hidden',
            }],
            privateData: 'drop-me',
          },
          members: [{
            deviceId: 'override', gridColumn: 0, gridRow: 0,
            viewport: { x: 0, y: 0, width: 1920, height: 1080, secret: 'hidden' },
          }],
          credential: 'hidden',
        }],
        groups: [{ id: 'device-group', name: 'Group', memberIds: ['override'], token: 'hidden' }],
      },
      classroomProgram: null,
      livestreamProgram: null,
      recordingState: { status: 'unknown', active: null, password: 'hidden', nested: { viewers: 1 } },
      streamState: { status: 'unknown', active: null, accessToken: 'hidden', nested: { viewers: 1 } },
    });
    assert.equal(snapshot.workspaceId, 'ws-1');
    assert.equal(snapshot.roomId, 'classroom-1');
    assert.equal(snapshot.revision, 1);
    assert.equal(snapshot.confirmedState.displays[0].id, 'override');
    assert.equal('api_key' in snapshot.confirmedState.displays[0], false);
    assert.deepEqual(snapshot.deviceStates.nodes[0].networkState, {
      adapter_name: 'Ethernet',
      link_status: 'healthy',
    });
    assert.deepEqual(snapshot.deviceStates.nodes[0].telemetry, {
      agent_uptime_sec: 120,
      cache: { cache_hits: 9 },
    });
    assert.deepEqual(snapshot.layoutState.walls[0].layout, {
      version: 1,
      preset: 'span-all',
      groups: [{
        id: 'group-1', name: 'All', layout: 'span', member_ids: ['override'],
      }],
    });
    assert.deepEqual(snapshot.recordingState, { status: 'unknown', active: null });
    assert.deepEqual(snapshot.streamState, { status: 'unknown', active: null });
    assert.doesNotMatch(JSON.stringify(snapshot), /drop-me|must-not-survive|hidden/);
  } finally {
    db.close();
  }
});

test('pending commands are never hidden behind newer completed command history', () => {
  const db = createFixtureDb();
  try {
    ensureRoomRevisionSchema(db);
    db.prepare(`INSERT INTO devices
      (id, workspace_id, name, status, last_heartbeat, screen_on, screen_width,
       screen_height, wall_id, layout_id, playlist_id, updated_at, device_token)
      VALUES ('display-a', 'ws-1', 'Front', 'online', 1, 1, 1920, 1080,
              NULL, NULL, NULL, 1, 'secret')`).run();
    const insert = db.prepare(`INSERT INTO command_logs
      (command_id, target_type, target_id, command_type, revision,
       parent_command_id, issued_by, created_at, requires_ack, ack_deadline,
       status, ack_at, ack_error, payload)
      VALUES (?, 'display', 'display-a', 'play', 1, NULL, 'operator', ?, 1,
              NULL, ?, NULL, NULL, '{}')`);
    insert.run('pending-old', 1, 'sent');
    const addHistory = db.transaction(() => {
      for (let index = 0; index < 1001; index += 1) {
        insert.run(`completed-${String(index).padStart(4, '0')}`, index + 2, 'acked');
      }
    });
    addHistory();

    const snapshot = buildRoomSnapshot({ db, workspaceId: 'ws-1', roomId: 'classroom-1' });

    assert.deepEqual(snapshot.pendingCommands.map((command) => command.commandId), ['pending-old']);
    assert.equal(snapshot.lastCommandId, 'completed-1000');
  } finally {
    db.close();
  }
});

test('boot schema and self-heal both declare the persisted room revision table', () => {
  const schema = fs.readFileSync(path.join(__dirname, '../db/schema.sql'), 'utf8');
  const databaseBoot = fs.readFileSync(path.join(__dirname, '../db/database.js'), 'utf8');
  assert.match(schema, /CREATE TABLE IF NOT EXISTS room_state_revisions/);
  assert.match(databaseBoot, /ensureRoomRevisionSchema\(db\)/);
});
