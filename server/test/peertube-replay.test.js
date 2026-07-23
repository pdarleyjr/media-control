const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');

// Isolated temp DB so this test never touches the real one. Set BEFORE
// requiring anything that opens the database.
const tempBase = process.env.KILO_TEMP || path.join(os.tmpdir(), 'kilo');
fs.mkdirSync(tempBase, { recursive: true });
const dbDir = fs.mkdtempSync(path.join(tempBase, 'mc-peertube-db-'));
process.env.DB_PATH = path.join(dbDir, 'test.db');

const svc = require('../services/peertube-replay');
const { db } = require('../db/database');

process.on('exit', () => {
  try { db.close(); } catch {}
  fs.rmSync(dbDir, { recursive: true, force: true });
});

const READY_VIDEO = {
  uuid: 'vid-ready-001', id: 101, name: 'Classroom Replay 1',
  description: 'desc', duration: 1800, isLive: false,
  state: { id: 5, label: 'Published' }, privacy: 1,
  thumbnailPath: '/static/thumbnails/101.jpg', path: '/w/vid-ready-001',
};

const PROCESSING_VIDEO = {
  uuid: 'vid-proc-002', id: 102, name: 'Classroom Replay 2', isLive: false,
  state: { id: 3, label: 'To transcode' }, privacy: 1, duration: 600,
};

const LIVE_VIDEO = { uuid: 'vid-live-003', id: 103, isLive: true, state: { id: 1 }, privacy: 1, name: 'live' };

test('migration created the peertube_replays table', () => {
  const row = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='peertube_replays'").get();
  assert.ok(row, 'peertube_replays table exists');
});

// Seed a user + workspace so content FKs (user_id → users, workspace_id →
// workspaces) hold for the add-to-media-control tests. Conditional on the
// multitenancy migration having created workspaces.
test('seed user + workspace for content FKs', () => {
  db.prepare(`INSERT OR IGNORE INTO users (id, email, name, role, plan_id) VALUES (?, ?, ?, 'admin', 'enterprise')`)
    .run('u1', 'u1@mbfd.test', 'Test Operator');
  db.prepare(`INSERT OR IGNORE INTO users (id, email, name, role, plan_id) VALUES (?, ?, ?, 'admin', 'enterprise')`)
    .run('u2', 'u2@mbfd.test', 'Test Operator Two');
  const hasWorkspaces = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='workspaces'").get();
  if (hasWorkspaces) {
    db.prepare(`INSERT OR IGNORE INTO organizations (id, name, owner_user_id) VALUES (?, ?, ?)`).run('org1', 'Test Org', 'u1');
    db.prepare(`INSERT OR IGNORE INTO workspaces (id, organization_id, name) VALUES (?, ?, ?)`).run('ws1', 'org1', 'Test Workspace');
    db.prepare(`INSERT OR IGNORE INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, ?)`).run('ws1', 'u1', 'owner');
  }
  assert.ok(true);
});

test('upsert is idempotent — duplicate poll never duplicates a row', () => {
  svc.upsertReplay(READY_VIDEO);
  svc.upsertReplay(READY_VIDEO);
  svc.upsertReplay(READY_VIDEO);
  const rows = db.prepare('SELECT * FROM peertube_replays WHERE peertube_video_uuid = ?').all('vid-ready-001');
  assert.equal(rows.length, 1, 'exactly one row per video uuid');
});

test('processing-state mapping: published video → ready, transcode pending → processing, live → processing', () => {
  assert.equal(svc._mapProcessingState(READY_VIDEO), 'ready');
  assert.equal(svc._mapProcessingState(PROCESSING_VIDEO), 'processing');
  assert.equal(svc._mapProcessingState(LIVE_VIDEO), 'processing');
});

test('live videos are not discovered as replays', () => {
  // The worker skips isLive; simulate by checking the state is processing not ready.
  assert.notEqual(svc._mapProcessingState(LIVE_VIDEO), 'ready');
});

test('delayed replay: processing row advances to ready when PeerTube finishes', () => {
  svc.upsertReplay(PROCESSING_VIDEO);
  const before = db.prepare("SELECT processing_state FROM peertube_replays WHERE peertube_video_uuid='vid-proc-002'").get();
  assert.equal(before.processing_state, 'processing');
  // PeerTube finishes transcoding.
  const finished = { ...PROCESSING_VIDEO, state: { id: 5, label: 'Published' } };
  svc.upsertReplay(finished);
  const after = db.prepare("SELECT processing_state FROM peertube_replays WHERE peertube_video_uuid='vid-proc-002'").get();
  assert.equal(after.processing_state, 'ready');
});

test('addToMediaControl creates a default-private content row and links it', () => {
  svc.upsertReplay(READY_VIDEO);
  const replay = db.prepare("SELECT id FROM peertube_replays WHERE peertube_video_uuid='vid-ready-001'").get();
  const result = svc.addToMediaControl({ replayId: replay.id, userId: 'u1', workspaceId: 'ws1' });
  assert.equal(result.created, true);
  assert.ok(result.content_id);
  const content = db.prepare('SELECT * FROM content WHERE id = ?').get(result.content_id);
  assert.ok(content.remote_url, 'content row references the PeerTube watch URL');
  assert.equal(content.access_level, 'private', 'default private');
  assert.equal(content.content_type, 'peertube-replay');
  assert.equal(content.processing_status, 'remote');
  const linked = db.prepare('SELECT content_id, processing_state FROM peertube_replays WHERE id=?').get(replay.id);
  assert.equal(linked.processing_state, 'added');
  assert.equal(linked.content_id, result.content_id);
});

test('operator double-click (duplicate add) does not create a second content row', () => {
  svc.upsertReplay(READY_VIDEO);
  const replay = db.prepare("SELECT id FROM peertube_replays WHERE peertube_video_uuid='vid-ready-001'").get();
  const first = svc.addToMediaControl({ replayId: replay.id, userId: 'u1', workspaceId: 'ws1' });
  const second = svc.addToMediaControl({ replayId: replay.id, userId: 'u1', workspaceId: 'ws1' });
  assert.equal(second.created, false, 'second add returns existing, not created');
  assert.equal(second.content_id, first.content_id, 'same content_id');
  const count = db.prepare('SELECT COUNT(*) c FROM content WHERE content_type = ?').get('peertube-replay').c;
  assert.equal(count, 1, 'still one content row');
});

test('cannot add a replay that is not yet ready', () => {
  svc.upsertReplay(PROCESSING_VIDEO);
  const replay = db.prepare("SELECT id FROM peertube_replays WHERE peertube_video_uuid='vid-proc-002'").get();
  assert.throws(() => svc.addToMediaControl({ replayId: replay.id, userId: 'u1', workspaceId: 'ws1' }),
    /not ready/i);
});

test('discard marks a replay failed without adding content', () => {
  const v = { ...READY_VIDEO, uuid: 'vid-discard-004', id: 104, state: { id: 5, label: 'Published' } };
  svc.upsertReplay(v);
  const replay = db.prepare("SELECT id FROM peertube_replays WHERE peertube_video_uuid='vid-discard-004'").get();
  svc.discard({ replayId: replay.id, userId: 'u1' });
  const row = db.prepare("SELECT processing_state, content_id FROM peertube_replays WHERE id=?").get(replay.id);
  assert.equal(row.processing_state, 'failed');
  assert.equal(row.content_id, null);
});

test('cannot discard a replay already linked to content', () => {
  const v = { ...READY_VIDEO, uuid: 'vid-linked-005', id: 105, state: { id: 5, label: 'Published' } };
  svc.upsertReplay(v);
  const replay = db.prepare("SELECT id FROM peertube_replays WHERE peertube_video_uuid='vid-linked-005'").get();
  svc.addToMediaControl({ replayId: replay.id, userId: 'u1', workspaceId: 'ws1' });
  assert.throws(() => svc.discard({ replayId: replay.id, userId: 'u1' }), /already linked/i);
});

test('organization-publication request: privacy=3 marks content public', () => {
  const v = { ...READY_VIDEO, uuid: 'vid-pub-006', id: 106, state: { id: 5, label: 'Published' } };
  svc.upsertReplay(v);
  const replay = db.prepare("SELECT id FROM peertube_replays WHERE peertube_video_uuid='vid-pub-006'").get();
  const result = svc.addToMediaControl({ replayId: replay.id, userId: 'u1', workspaceId: 'ws1', privacy: 3 });
  const content = db.prepare('SELECT access_level FROM content WHERE id=?').get(result.content_id);
  // Governed visibility vocabulary (main): PeerTube privacy=3 (public/org-wide)
  // maps to organization_shared. 'public' is rejected by the visibility trigger.
  assert.equal(content.access_level, 'organization_shared');
});

test('secrets are never persisted in replay rows', () => {
  svc.upsertReplay(READY_VIDEO);
  const rows = db.prepare("SELECT * FROM peertube_replays WHERE peertube_video_uuid='vid-ready-001'").all();
  const blob = JSON.stringify(rows);
  assert.ok(!/token|secret|password|stream.?key/i.test(blob), 'no credential-like fields in row');
});

test('worker restart resumes without data loss (state persists across restart)', () => {
  svc.upsertReplay(READY_VIDEO);
  const before = svc.listPending({ limit: 100 });
  svc.stop();
  // Simulate restart by re-requiring the module (state lives in the DB, not memory).
  delete require.cache[require.resolve('../services/peertube-replay')];
  const svc2 = require('../services/peertube-replay');
  const after = svc2.listPending({ limit: 100 });
  assert.equal(after.length, before.length, 'pending list survives restart');
});

test('listPending only returns ready, unlinked replays', () => {
  const all = svc.listAll({ limit: 500 });
  const pending = svc.listPending({ limit: 500 });
  for (const p of pending) {
    assert.equal(p.processing_state, 'ready');
    assert.equal(p.content_id, null);
  }
  assert.ok(pending.length <= all.length);
});
