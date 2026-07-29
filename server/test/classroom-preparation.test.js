const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const fs = require('node:fs');
const path = require('node:path');

const {
  cancelPreparation,
  preparationStatus,
  queuePreparation,
  recordPreparationResult,
} = require('../lib/classroom-preparation');

function fixtureDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE content (
      id TEXT PRIMARY KEY,
      workspace_id TEXT,
      processing_status TEXT
    );
    CREATE TABLE asset_checksums (
      asset_id TEXT PRIMARY KEY,
      content_id TEXT UNIQUE,
      generation INTEGER NOT NULL,
      sha256 TEXT,
      size_bytes INTEGER,
      canonical_path TEXT,
      canonical_url TEXT
    );
    CREATE TABLE node_assets (
      asset_id TEXT NOT NULL,
      node_id TEXT NOT NULL,
      desired INTEGER NOT NULL DEFAULT 1,
      sync_status TEXT NOT NULL DEFAULT 'pending',
      generation INTEGER,
      local_path TEXT,
      checksum_verified INTEGER NOT NULL DEFAULT 0,
      bytes_downloaded INTEGER,
      last_attempt_at INTEGER,
      last_success_at INTEGER,
      error_message TEXT,
      updated_at INTEGER,
      PRIMARY KEY (asset_id, node_id)
    );
    CREATE TABLE managed_nodes (
      node_id TEXT PRIMARY KEY,
      node_name TEXT,
      workspace_id TEXT,
      last_heartbeat INTEGER,
      sync_status TEXT
    );
  `);
  db.prepare('INSERT INTO content VALUES (?, ?, ?)').run('content-1', 'workspace-1', 'ready');
  db.prepare('INSERT INTO asset_checksums VALUES (?, ?, ?, ?, ?, ?, ?)').run(
    'asset-1',
    'content-1',
    4,
    'a'.repeat(64),
    2048,
    'content-1.mp4',
    '/api/content/content-1/file',
  );
  db.prepare('INSERT INTO managed_nodes VALUES (?, ?, ?, ?, ?)').run(
    'classroom-1-p3',
    'Classroom P3',
    'workspace-1',
    Math.floor(Date.now() / 1000),
    'ready',
  );
  return db;
}

test('prepare for class persists an exact generation before emitting priority work', () => {
  const db = fixtureDb();
  const queued = queuePreparation(db, {
    contentId: 'content-1',
    workspaceId: 'workspace-1',
    nodeId: 'classroom-1-p3',
  });

  assert.equal(queued.ok, true);
  assert.equal(queued.state, 'queued');
  assert.equal(queued.item.generation, 4);
  assert.equal(queued.item.sha256, 'a'.repeat(64));
  assert.deepEqual(
    db.prepare('SELECT desired, sync_status, generation, checksum_verified FROM node_assets').get(),
    { desired: 1, sync_status: 'pending', generation: 4, checksum_verified: 0 },
  );
});

test('node completion marks only the matching generation classroom ready', () => {
  const db = fixtureDb();
  queuePreparation(db, {
    contentId: 'content-1',
    workspaceId: 'workspace-1',
    nodeId: 'classroom-1-p3',
  });

  const stale = recordPreparationResult(db, 'classroom-1-p3', {
    content_id: 'content-1',
    generation: 3,
    ok: true,
    elapsed_ms: 200,
  });
  assert.equal(stale.applied, false);
  assert.equal(stale.reason, 'generation_mismatch');

  const current = recordPreparationResult(db, 'classroom-1-p3', {
    content_id: 'content-1',
    generation: 4,
    ok: true,
    elapsed_ms: 350,
  });
  assert.equal(current.applied, true);
  const status = preparationStatus(db, {
    contentId: 'content-1',
    workspaceId: 'workspace-1',
  });
  assert.equal(status.state, 'classroom_ready');
  assert.equal(status.checksum_verified, true);
  assert.equal(status.cache_hit_observed, false);
  assert.match(status.note, /cache hit/i);
});

test('generation change invalidates prior readiness and failure remains retryable', () => {
  const db = fixtureDb();
  queuePreparation(db, {
    contentId: 'content-1',
    workspaceId: 'workspace-1',
    nodeId: 'classroom-1-p3',
  });
  recordPreparationResult(db, 'classroom-1-p3', {
    content_id: 'content-1',
    generation: 4,
    ok: true,
  });
  db.prepare('UPDATE asset_checksums SET generation = 5, sha256 = ? WHERE content_id = ?')
    .run('b'.repeat(64), 'content-1');

  const requeued = queuePreparation(db, {
    contentId: 'content-1',
    workspaceId: 'workspace-1',
    nodeId: 'classroom-1-p3',
  });
  assert.equal(requeued.item.generation, 5);
  assert.equal(preparationStatus(db, {
    contentId: 'content-1',
    workspaceId: 'workspace-1',
  }).state, 'queued');

  recordPreparationResult(db, 'classroom-1-p3', {
    content_id: 'content-1',
    generation: 5,
    ok: false,
    error: 'checksum_mismatch',
  });
  const failed = preparationStatus(db, {
    contentId: 'content-1',
    workspaceId: 'workspace-1',
  });
  assert.equal(failed.state, 'failed');
  assert.equal(failed.retryable, true);
});

test('cancellation is permitted only before node work starts', () => {
  const db = fixtureDb();
  queuePreparation(db, {
    contentId: 'content-1',
    workspaceId: 'workspace-1',
    nodeId: 'classroom-1-p3',
  });
  assert.equal(cancelPreparation(db, {
    contentId: 'content-1',
    workspaceId: 'workspace-1',
  }).cancelled, true);
  assert.equal(preparationStatus(db, {
    contentId: 'content-1',
    workspaceId: 'workspace-1',
  }).state, 'cancelled');

  queuePreparation(db, {
    contentId: 'content-1',
    workspaceId: 'workspace-1',
    nodeId: 'classroom-1-p3',
  });
  db.prepare("UPDATE node_assets SET sync_status = 'downloading'").run();
  const refused = cancelPreparation(db, {
    contentId: 'content-1',
    workspaceId: 'workspace-1',
  });
  assert.equal(refused.cancelled, false);
  assert.equal(refused.reason, 'already_started');
});

test('P3 result protocol carries generation and persists it through the authenticated node socket', () => {
  const cacheAgent = fs.readFileSync(
    path.join(__dirname, '../../appliance/p3/room-agent/cache-agent.js'),
    'utf8',
  );
  const socket = fs.readFileSync(path.join(__dirname, '../ws/deviceSocket.js'), 'utf8');
  assert.match(cacheAgent, /generation:\s*Number\(item\s*&&\s*item\.generation\)/);
  assert.match(socket, /socket\.on\(['"]node:prewarm-result['"]/);
  assert.match(socket, /recordPreparationResult\(db,\s*nodeId,\s*payload\)/);
});

test('authenticated preparation API supports bulk queue, status, retry, and safe cancellation', () => {
  const route = fs.readFileSync(
    path.join(__dirname, '../routes/classroom-preparation.js'),
    'utf8',
  );
  const server = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');
  assert.match(server, /app\.use\(['"]\/api\/classroom-preparation['"]/);
  assert.match(route, /router\.post\(['"]\/['"]/);
  assert.match(route, /router\.get\(['"]\/:contentId['"]/);
  assert.match(route, /router\.post\(['"]\/:contentId\/retry['"]/);
  assert.match(route, /router\.delete\(['"]\/:contentId['"]/);
  assert.match(route, /emitContentPrewarm/);
});
