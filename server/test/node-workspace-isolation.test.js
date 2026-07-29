const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const Database = require('better-sqlite3');

const config = require('../config');
const {
  buildContentManifest,
  nodeAuthOk,
  nodeCanAccessContent,
  nodeWorkspaceIds,
  recordHeartbeat,
} = require('../lib/node-registry');

function createDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE workspaces (
      id TEXT PRIMARY KEY,
      organization_id TEXT
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
      created_at INTEGER,
      updated_at INTEGER
    );
    CREATE TABLE node_heartbeats (
      node_id TEXT,
      ts INTEGER,
      software_version TEXT,
      free_disk INTEGER,
      cache_size INTEGER,
      sync_status TEXT,
      active_displays TEXT,
      audio_endpoint TEXT,
      network_state_json TEXT,
      telemetry_json TEXT
    );
    CREATE TABLE video_walls (
      id TEXT PRIMARY KEY,
      workspace_id TEXT
    );
    CREATE TABLE content (
      id TEXT PRIMARY KEY,
      workspace_id TEXT,
      filepath TEXT,
      file_size INTEGER,
      mime_type TEXT,
      processing_status TEXT,
      version INTEGER,
      created_at INTEGER,
      updated_at INTEGER,
      access_level TEXT,
      archived_at INTEGER
    );
    CREATE TABLE asset_checksums (
      asset_id TEXT PRIMARY KEY,
      content_id TEXT UNIQUE,
      generation INTEGER,
      sha256 TEXT,
      size_bytes INTEGER,
      computed_at INTEGER
    );
    CREATE TABLE content_template_assignments (
      content_id TEXT,
      workspace_id TEXT,
      PRIMARY KEY (content_id, workspace_id)
    );
  `);
  db.prepare('INSERT INTO workspaces (id, organization_id) VALUES (?, ?)').run('ws-classroom', 'org-mbfd');
  db.prepare('INSERT INTO workspaces (id, organization_id) VALUES (?, ?)').run('ws-sibling', 'org-mbfd');
  db.prepare('INSERT INTO workspaces (id, organization_id) VALUES (?, ?)').run('ws-foreign', 'org-other');
  db.prepare('INSERT INTO video_walls (id, workspace_id) VALUES (?, ?)').run('wall-front', 'ws-classroom');
  db.prepare('INSERT INTO video_walls (id, workspace_id) VALUES (?, ?)').run('wall-side', 'ws-classroom');
  return db;
}

function addContent(db, {
  id,
  workspaceId,
  accessLevel = 'private',
  archivedAt = null,
  generation = 1,
  version = generation,
}) {
  db.prepare(`
    INSERT INTO content
      (id, workspace_id, filepath, file_size, mime_type, processing_status,
       version, created_at, updated_at, access_level, archived_at)
    VALUES (?, ?, ?, 128, 'video/mp4', 'ready', ?, 1, 1, ?, ?)
  `).run(id, workspaceId, `${id}.mp4`, version, accessLevel, archivedAt);
  db.prepare(`
    INSERT INTO asset_checksums
      (asset_id, content_id, generation, sha256, size_bytes, computed_at)
    VALUES (?, ?, ?, ?, 128, 1)
  `).run(
    id,
    id,
    generation,
    crypto.createHash('sha256').update(id).digest('hex'),
  );
}

function withClassroomCache(value, fn) {
  const previous = config.classroomCache;
  config.classroomCache = value;
  try {
    return fn();
  } finally {
    config.classroomCache = previous;
  }
}

test('node reconnect binds its durable workspace before subsequent manifest requests', () => {
  const db = createDb();
  try {
    db.prepare(`
      INSERT INTO managed_nodes (node_id, workspace_id, room_id, sync_status)
      VALUES ('classroom-1-p3', NULL, 'classroom-1', 'ready')
    `).run();
    withClassroomCache({
      enabled: true,
      nodeId: 'classroom-1-p3',
      roomId: 'classroom-1',
      wallIds: ['wall-front', 'wall-side'],
      workspaceId: '',
    }, () => {
      assert.deepEqual(nodeWorkspaceIds(db, { nodeId: 'classroom-1-p3' }), ['ws-classroom']);
      assert.equal(recordHeartbeat(db, 'classroom-1-p3', { sync_status: 'ready' }), true);
      assert.equal(
        db.prepare('SELECT workspace_id FROM managed_nodes WHERE node_id = ?')
          .get('classroom-1-p3').workspace_id,
        'ws-classroom',
      );
      assert.deepEqual(nodeWorkspaceIds(db, { nodeId: 'classroom-1-p3' }), ['ws-classroom']);
    });
  } finally {
    db.close();
  }
});

test('configured node token cannot be replayed under a different node identity', () => {
  withClassroomCache({
    enabled: true,
    nodeId: 'classroom-1-p3',
    nodeToken: 'test-only-node-token',
    wallIds: ['wall-front', 'wall-side'],
    workspaceId: 'ws-classroom',
  }, () => {
    assert.equal(nodeAuthOk({
      node_id: 'classroom-1-p3',
      token: 'test-only-node-token',
    }), true);
    assert.equal(nodeAuthOk({
      node_id: 'foreign-node',
      token: 'test-only-node-token',
    }), false);
  });
});

test('manifest includes only visible, current-generation classroom assets', () => {
  const db = createDb();
  try {
    db.prepare(`
      INSERT INTO managed_nodes (node_id, workspace_id, room_id, sync_status)
      VALUES ('classroom-1-p3', 'ws-classroom', 'classroom-1', 'ready')
    `).run();
    addContent(db, { id: 'private-classroom', workspaceId: 'ws-classroom' });
    addContent(db, {
      id: 'workspace-classroom',
      workspaceId: 'ws-classroom',
      accessLevel: 'workspace_shared',
    });
    addContent(db, {
      id: 'organization-sibling',
      workspaceId: 'ws-sibling',
      accessLevel: 'organization_shared',
    });
    addContent(db, {
      id: 'organization-foreign',
      workspaceId: 'ws-foreign',
      accessLevel: 'organization_shared',
    });
    addContent(db, { id: 'private-foreign', workspaceId: 'ws-foreign' });
    addContent(db, {
      id: 'platform-template',
      workspaceId: null,
      accessLevel: 'platform_template',
    });
    db.prepare(`
      INSERT INTO content_template_assignments (content_id, workspace_id)
      VALUES ('platform-template', 'ws-classroom')
    `).run();
    addContent(db, {
      id: 'archived-classroom',
      workspaceId: 'ws-classroom',
      archivedAt: 123,
    });
    addContent(db, {
      id: 'stale-generation',
      workspaceId: 'ws-classroom',
      generation: 1,
      version: 2,
    });

    const manifest = withClassroomCache({
      enabled: true,
      nodeId: 'classroom-1-p3',
      roomId: 'classroom-1',
      wallIds: ['wall-front', 'wall-side'],
      workspaceId: 'ws-classroom',
    }, () => buildContentManifest(db, {
      nodeId: 'classroom-1-p3',
      queueMissing: false,
    }));

    assert.deepEqual(
      manifest.map((item) => item.content_id).sort(),
      [
        'organization-sibling',
        'platform-template',
        'private-classroom',
        'workspace-classroom',
      ],
    );
    assert.ok(manifest.every((item) => item.generation === 1));
  } finally {
    db.close();
  }
});

test('trusted node can prewarm visible unassigned content but not foreign or archived content', () => {
  const db = createDb();
  try {
    db.prepare(`
      INSERT INTO managed_nodes (node_id, workspace_id, room_id, sync_status)
      VALUES ('classroom-1-p3', 'ws-classroom', 'classroom-1', 'ready')
    `).run();
    addContent(db, {
      id: 'unassigned-classroom',
      workspaceId: 'ws-classroom',
      accessLevel: 'workspace_shared',
    });
    addContent(db, {
      id: 'unassigned-foreign',
      workspaceId: 'ws-foreign',
      accessLevel: 'workspace_shared',
    });
    addContent(db, {
      id: 'archived-visible',
      workspaceId: 'ws-classroom',
      accessLevel: 'workspace_shared',
      archivedAt: 123,
    });

    withClassroomCache({
      enabled: true,
      nodeId: 'classroom-1-p3',
      roomId: 'classroom-1',
      wallIds: ['wall-front', 'wall-side'],
      workspaceId: 'ws-classroom',
    }, () => {
      const content = (id) => db.prepare('SELECT * FROM content WHERE id = ?').get(id);
      assert.equal(nodeCanAccessContent(db, content('unassigned-classroom')), true);
      assert.equal(nodeCanAccessContent(db, content('unassigned-foreign')), false);
      assert.equal(nodeCanAccessContent(db, content('archived-visible')), false);
    });
  } finally {
    db.close();
  }
});

test('conflicting wall or node workspace bindings fail closed', () => {
  const db = createDb();
  try {
    db.prepare('INSERT INTO video_walls (id, workspace_id) VALUES (?, ?)')
      .run('wall-foreign', 'ws-foreign');
    db.prepare(`
      INSERT INTO managed_nodes (node_id, workspace_id, room_id, sync_status)
      VALUES ('classroom-1-p3', 'ws-classroom', 'classroom-1', 'ready')
    `).run();

    withClassroomCache({
      enabled: true,
      nodeId: 'classroom-1-p3',
      roomId: 'classroom-1',
      wallIds: ['wall-front', 'wall-foreign'],
      workspaceId: '',
    }, () => {
      assert.deepEqual(nodeWorkspaceIds(db, { nodeId: 'classroom-1-p3' }), []);
      assert.deepEqual(buildContentManifest(db, {
        nodeId: 'classroom-1-p3',
        queueMissing: false,
      }), []);
    });
  } finally {
    db.close();
  }
});
