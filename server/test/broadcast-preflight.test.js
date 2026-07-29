const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const fs = require('node:fs');
const path = require('node:path');

const { buildBroadcastPreflight } = require('../lib/broadcast-preflight');

function fixtureDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE devices (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      status TEXT NOT NULL,
      app_version TEXT,
      capabilities_json TEXT
    );
    CREATE TABLE asset_checksums (
      asset_id TEXT PRIMARY KEY,
      content_id TEXT UNIQUE,
      generation INTEGER,
      sha256 TEXT,
      size_bytes INTEGER,
      canonical_path TEXT
    );
    CREATE TABLE managed_nodes (
      node_id TEXT PRIMARY KEY,
      node_name TEXT,
      workspace_id TEXT,
      last_heartbeat INTEGER,
      sync_status TEXT,
      telemetry_json TEXT
    );
    CREATE TABLE node_assets (
      asset_id TEXT NOT NULL,
      node_id TEXT NOT NULL,
      desired INTEGER NOT NULL,
      sync_status TEXT NOT NULL,
      checksum_verified INTEGER NOT NULL,
      bytes_downloaded INTEGER,
      error_message TEXT,
      PRIMARY KEY (asset_id, node_id)
    );
    CREATE TABLE content_media_metadata (
      content_id TEXT PRIMARY KEY,
      source_type TEXT,
      container TEXT,
      video_codec TEXT,
      audio_codec TEXT,
      audio_channels INTEGER,
      duration_sec REAL,
      bitrate_bps INTEGER,
      remote_health_status TEXT
    );
  `);
  return db;
}

test('broadcast preflight reports exact targets, generation, audio, and verified classroom state', () => {
  const db = fixtureDb();
  const now = Math.floor(Date.now() / 1000);
  db.prepare('INSERT INTO devices VALUES (?, ?, ?, ?, ?)').run(
    'display-1',
    'Front Left',
    'online',
    '1.1.0',
    JSON.stringify({ content: true }),
  );
  db.prepare('INSERT INTO devices VALUES (?, ?, ?, ?, ?)').run(
    'display-2',
    'Front Right',
    'online',
    '1.1.0',
    JSON.stringify({ content: true }),
  );
  db.prepare('INSERT INTO asset_checksums VALUES (?, ?, ?, ?, ?, ?)').run(
    'asset-1',
    'content-1',
    7,
    'a'.repeat(64),
    4096,
    'content/video.mp4',
  );
  db.prepare('INSERT INTO managed_nodes VALUES (?, ?, ?, ?, ?, ?)').run(
    'classroom-1-p3',
    'Classroom P3',
    'workspace-1',
    now,
    'ready',
    JSON.stringify({ cache: { hits: 31, misses: 6 } }),
  );
  db.prepare('INSERT INTO node_assets VALUES (?, ?, ?, ?, ?, ?, ?)').run(
    'asset-1',
    'classroom-1-p3',
    1,
    'ready',
    1,
    4096,
    null,
  );
  db.prepare('INSERT INTO content_media_metadata VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
    'content-1',
    'upload',
    'mov,mp4',
    'h264',
    'aac',
    2,
    12.5,
    2_000_000,
    null,
  );

  const result = buildBroadcastPreflight(db, {
    workspaceId: 'workspace-1',
    content: {
      id: 'content-1',
      filename: 'Training.mp4',
      mime_type: 'video/mp4',
      file_size: 4096,
      version: 7,
      processing_status: 'ready',
    },
    routes: [
      { type: 'wall', device_id: 'display-1', wall_id: 'wall-1', layout_revision: 42 },
      { type: 'wall', device_id: 'display-2', wall_id: 'wall-1', layout_revision: 42 },
    ],
    readiness: { ready: true, state: 'ready' },
  });

  assert.equal(result.can_send, true);
  assert.equal(result.expected_target_count, 2);
  assert.deepEqual(result.targets.map((target) => target.name), ['Front Left', 'Front Right']);
  assert.equal(result.targets.every((target) => target.online), true);
  assert.deepEqual(result.layout_revisions, [{ wall_id: 'wall-1', layout_revision: 42 }]);
  assert.equal(result.content.generation, 7);
  assert.equal(result.content.audio.codec, 'aac');
  assert.equal(result.content.audio.channels, 2);
  assert.equal(result.p3.state, 'classroom_ready');
  assert.equal(result.p3.checksum_verified, true);
  assert.equal(result.p3.cache_hit_observed, false);
  assert.match(result.p3.note, /playback cache hit/i);
  assert.equal(result.estimated_cold_transfer_bytes, 0);
});

test('broadcast preflight never calls server-ready media classroom-ready without node proof', () => {
  const db = fixtureDb();
  db.prepare('INSERT INTO devices VALUES (?, ?, ?, ?, ?)').run(
    'display-1',
    'Front Left',
    'offline',
    null,
    null,
  );
  db.prepare('INSERT INTO asset_checksums VALUES (?, ?, ?, ?, ?, ?)').run(
    'asset-1',
    'content-1',
    3,
    'b'.repeat(64),
    8192,
    'content/video.mp4',
  );

  const result = buildBroadcastPreflight(db, {
    workspaceId: 'workspace-1',
    content: {
      id: 'content-1',
      filename: 'Cold.mp4',
      mime_type: 'video/mp4',
      file_size: 8192,
      version: 3,
      processing_status: 'ready',
    },
    routes: [{ type: 'display', device_id: 'display-1' }],
    readiness: { ready: true, state: 'ready' },
  });

  assert.equal(result.can_send, false);
  assert.equal(result.p3.state, 'not_requested');
  assert.equal(result.p3.checksum_verified, false);
  assert.equal(result.p3.cache_hit_observed, false);
  assert.equal(result.estimated_cold_transfer_bytes, 8192);
  assert.ok(result.warnings.some((warning) => warning.code === 'TARGET_OFFLINE'));
  assert.ok(result.warnings.some((warning) => warning.code === 'P3_NOT_VERIFIED'));
});

test('broadcast preflight treats a localized remote source as locally healthy', () => {
  const db = fixtureDb();
  db.prepare('INSERT INTO devices VALUES (?, ?, ?, ?, ?)').run(
    'display-1',
    'Front Left',
    'online',
    '1.1.0',
    JSON.stringify({ content: true }),
  );
  db.prepare('INSERT INTO content_media_metadata VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
    'content-1',
    'youtube',
    'mov,mp4',
    'h264',
    'aac',
    2,
    72,
    1_200_000,
    'localized',
  );

  const result = buildBroadcastPreflight(db, {
    workspaceId: 'workspace-1',
    content: {
      id: 'content-1',
      filename: 'Localized YouTube.mp4',
      mime_type: 'video/mp4',
      file_size: 10_000_000,
      version: 2,
      processing_status: 'ready',
    },
    routes: [{ type: 'display', device_id: 'display-1' }],
    readiness: { ready: true, state: 'ready' },
  });

  assert.equal(
    result.warnings.some((warning) => warning.code === 'REMOTE_SOURCE_UNHEALTHY'),
    false,
  );
});

test('broadcast preflight fails closed for missing devices and processing failures', () => {
  const db = fixtureDb();
  const result = buildBroadcastPreflight(db, {
    workspaceId: 'workspace-1',
    content: {
      id: 'content-1',
      filename: 'Broken.mov',
      mime_type: 'video/quicktime',
      file_size: 0,
      version: 2,
      processing_status: 'failed',
    },
    routes: [{ type: 'display', device_id: 'missing-display' }],
    missingDeviceIds: ['missing-display'],
    readiness: {
      ready: false,
      state: 'failed',
      code: 'CONTENT_PROCESSING_FAILED',
      error: 'Media processing failed',
    },
  });

  assert.equal(result.can_send, false);
  assert.equal(result.expected_target_count, 1);
  assert.equal(result.targets[0].online, false);
  assert.equal(result.content.server_ready, false);
  assert.ok(result.warnings.some((warning) => warning.code === 'CONTENT_NOT_READY'));
  assert.ok(result.warnings.some((warning) => warning.code === 'TARGET_MISSING'));
});

test('broadcast route exposes a read-only typed-target preflight before dispatch', () => {
  const source = fs.readFileSync(path.join(__dirname, '../routes/broadcast.js'), 'utf8');
  assert.match(source, /router\.post\(['"]\/preflight['"]/);
  assert.match(source, /resolveTypedBroadcastTargets/);
  assert.match(source, /buildBroadcastPreflight/);
  assert.match(source, /contentBroadcastReadiness/);
});
