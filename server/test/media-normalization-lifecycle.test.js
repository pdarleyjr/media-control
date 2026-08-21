'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');

const { normalizeVideoJob } = require('../lib/media-transcode');
const { finalizeContentAsset } = require('../lib/content-finalization');
const { buildContentManifest } = require('../lib/node-registry');

function createDb(filepath, mimeType = 'video/mp4') {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE content (
      id TEXT PRIMARY KEY,
      workspace_id TEXT,
      filepath TEXT,
      mime_type TEXT,
      file_size INTEGER,
      duration_sec REAL,
      width INTEGER,
      height INTEGER,
      thumbnail_path TEXT,
      original_filepath TEXT,
      original_sha256 TEXT,
      processing_status TEXT NOT NULL DEFAULT 'uploaded',
      processing_error TEXT,
      media_probe_json TEXT,
      version INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL DEFAULT 1,
      updated_at INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE asset_checksums (
      asset_id TEXT PRIMARY KEY,
      content_id TEXT NOT NULL UNIQUE,
      generation INTEGER NOT NULL,
      sha256 TEXT NOT NULL,
      size_bytes INTEGER NOT NULL,
      canonical_path TEXT NOT NULL,
      canonical_url TEXT NOT NULL,
      poster_path TEXT,
      duration_sec REAL,
      width INTEGER,
      height INTEGER,
      computed_at INTEGER NOT NULL
    );
    CREATE TABLE content_publication_requests (
      content_id TEXT,
      status TEXT,
      decided_by TEXT,
      decision_reason TEXT,
      decided_at INTEGER,
      updated_at INTEGER
    );
    CREATE TABLE processing_transitions (status TEXT NOT NULL);
    CREATE TRIGGER record_processing_transition
    AFTER UPDATE OF processing_status ON content
    WHEN OLD.processing_status <> NEW.processing_status
    BEGIN
      INSERT INTO processing_transitions(status) VALUES (NEW.processing_status);
    END;
  `);
  db.prepare(`
    INSERT INTO content (id, workspace_id, filepath, mime_type, processing_status, version)
    VALUES ('video-id', 'workspace-1', ?, ?, 'uploaded', 1)
  `).run(filepath, mimeType);
  return db;
}

function safeProbe(overrides = {}) {
  return {
    ext: '.mp4',
    vcodec: 'h264',
    video_codec: 'h264',
    audio_codec: 'aac',
    audio_channels: 2,
    duration_seconds: 12.5,
    width: 1920,
    height: 1080,
    pixfmt: 'yuv420p',
    transfer: 'bt709',
    colorspace: 'bt709',
    ...overrides,
  };
}

function captureIo(events) {
  return {
    of(namespace) {
      return {
        to(room) {
          return {
            emit(event, payload) {
              events.push({ namespace, room, event, payload });
            },
          };
        },
      };
    },
  };
}

function transitions(db) {
  return db.prepare('SELECT status FROM processing_transitions ORDER BY rowid').all().map((row) => row.status);
}

test('web-safe upload becomes immutable and immediately prewarms exactly its final bytes', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-safe-video-'));
  const source = path.join(dir, 'safe.mp4');
  fs.writeFileSync(source, 'already-web-safe');
  const db = createDb('safe.mp4');
  const prewarms = [];
  const socketEvents = [];

  try {
    const result = await normalizeVideoJob({
      contentId: 'video-id',
      absPath: source,
      db,
      io: captureIo(socketEvents),
      contentDir: dir,
      probeMedia: () => safeProbe(),
      prewarmContent: async (_io, _db, item) => {
        prewarms.push(item);
        return { requested: true };
      },
    });

    assert.equal(result.status, 'ready');
    assert.deepEqual(transitions(db), ['probing', 'ready']);
    const row = db.prepare('SELECT * FROM content WHERE id = ?').get('video-id');
    assert.equal(row.filepath, 'safe.mp4');
    assert.equal(row.processing_status, 'ready');
    assert.equal(row.version, 2);

    const manifest = db.prepare('SELECT * FROM asset_checksums WHERE content_id = ?').get('video-id');
    assert.equal(manifest.generation, 2);
    assert.equal(manifest.canonical_path, 'safe.mp4');
    assert.equal(manifest.sha256, crypto.createHash('sha256').update('already-web-safe').digest('hex'));
    assert.equal(prewarms.length, 1);
    assert.equal(prewarms[0].sha256, manifest.sha256);
    assert.equal(prewarms[0].generation, 2);
    assert.deepEqual(socketEvents, [{
      namespace: '/dashboard',
      room: 'workspace:workspace-1',
      event: 'content-updated',
      payload: {
        content_id: 'video-id',
        processing_status: 'ready',
        version: 2,
        generation: 2,
      },
    }]);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('HEVC normalization prewarms only the final H.264 file and retains the original master', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-hevc-video-'));
  const source = path.join(dir, 'camera-hevc.mov');
  fs.writeFileSync(source, 'incompatible-hevc-original');
  const db = createDb('camera-hevc.mov', 'video/quicktime');
  const prewarms = [];

  try {
    const result = await normalizeVideoJob({
      contentId: 'video-id',
      absPath: source,
      db,
      contentDir: dir,
      uuid: () => 'normalized-video',
      probeMedia: (file) => file === source
        ? safeProbe({ ext: '.mov', vcodec: 'hevc', video_codec: 'hevc', pixfmt: 'yuv420p10le' })
        : safeProbe(),
      transcode: async (_input, stagedPath) => {
        assert.equal(fs.existsSync(source), true);
        fs.writeFileSync(stagedPath, 'final-browser-safe-h264');
      },
      createThumbnail: async () => null,
      prewarmContent: async (_io, _db, item) => {
        assert.equal(fs.existsSync(source), true, 'source remains until final handoff is emitted');
        assert.equal(fs.readFileSync(path.join(dir, item.canonical_path), 'utf8'), 'final-browser-safe-h264');
        prewarms.push(item);
        return { requested: true };
      },
    });

    assert.equal(result.status, 'ready');
    assert.deepEqual(transitions(db), ['probing', 'processing', 'ready']);
    const row = db.prepare('SELECT * FROM content WHERE id = ?').get('video-id');
    assert.equal(row.filepath, 'normalized-video.mp4');
    assert.equal(row.mime_type, 'video/mp4');
    assert.equal(row.processing_status, 'ready');
    assert.equal(row.version, 2);
    assert.equal(fs.readFileSync(path.join(dir, row.filepath), 'utf8'), 'final-browser-safe-h264');
    assert.equal(fs.existsSync(source), true, 'master bytes remain until an explicit retention policy removes them');
    assert.equal(prewarms.length, 1);
    assert.equal(prewarms[0].canonical_path, 'normalized-video.mp4');
    assert.equal(
      prewarms[0].sha256,
      crypto.createHash('sha256').update('final-browser-safe-h264').digest('hex'),
    );
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('stale normalization never replaces or prewarms a newer uploaded original', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-stale-video-'));
  const source = path.join(dir, 'old-hevc.mov');
  const replacement = path.join(dir, 'new-upload.mp4');
  fs.writeFileSync(source, 'old-source');
  fs.writeFileSync(replacement, 'new-source');
  const db = createDb('old-hevc.mov', 'video/quicktime');
  let prewarms = 0;

  try {
    const result = await normalizeVideoJob({
      contentId: 'video-id',
      absPath: source,
      db,
      contentDir: dir,
      uuid: () => 'stale-normalized',
      probeMedia: (file) => file === source
        ? safeProbe({ ext: '.mov', vcodec: 'hevc', video_codec: 'hevc' })
        : safeProbe(),
      transcode: async (_input, stagedPath) => {
        db.prepare(`
          UPDATE content
          SET filepath='new-upload.mp4', mime_type='video/mp4',
              processing_status='uploaded', version=version + 1
          WHERE id='video-id'
        `).run();
        fs.writeFileSync(stagedPath, 'obsolete-normalization');
      },
      createThumbnail: async () => null,
      prewarmContent: async () => {
        prewarms += 1;
        return { requested: true };
      },
    });

    assert.equal(result.status, 'stale');
    assert.equal(db.prepare('SELECT filepath FROM content WHERE id=?').get('video-id').filepath, 'new-upload.mp4');
    assert.equal(fs.existsSync(source), true);
    assert.equal(fs.existsSync(path.join(dir, 'stale-normalized.mp4')), false);
    assert.equal(prewarms, 0);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('unprobeable uploads fail closed without a manifest or P3 prewarm', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-bad-video-'));
  const source = path.join(dir, 'corrupt.mp4');
  fs.writeFileSync(source, 'not-a-video');
  const db = createDb('corrupt.mp4');
  let prewarms = 0;
  const socketEvents = [];

  try {
    const result = await normalizeVideoJob({
      contentId: 'video-id',
      absPath: source,
      db,
      io: captureIo(socketEvents),
      contentDir: dir,
      probeMedia: () => null,
      prewarmContent: async () => {
        prewarms += 1;
        return { requested: true };
      },
    });

    assert.equal(result.status, 'failed');
    assert.deepEqual(transitions(db), ['probing', 'failed']);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM asset_checksums').get().count, 0);
    assert.equal(prewarms, 0);
    assert.deepEqual(socketEvents, [{
      namespace: '/dashboard',
      room: 'workspace:workspace-1',
      event: 'content-updated',
      payload: {
        content_id: 'video-id',
        processing_status: 'failed',
        processing_error: 'media_probe_failed',
        version: 1,
        generation: 1,
      },
    }]);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('single-flight completion increments one generation and emits one handoff', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-finalize-flight-'));
  const source = path.join(dir, 'safe.mp4');
  fs.writeFileSync(source, 'one-final-generation');
  const db = createDb('safe.mp4');
  let prewarms = 0;

  try {
    const options = {
      db,
      contentId: 'video-id',
      expectedFilepath: 'safe.mp4',
      candidatePath: source,
      finalPath: source,
      finalFilepath: 'safe.mp4',
      metadata: { mimeType: 'video/mp4', probe: safeProbe() },
      sha256File: async (file) => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
      },
      prewarmContent: async () => {
        prewarms += 1;
        return { requested: true };
      },
    };
    const [first, second] = await Promise.all([
      finalizeContentAsset(options),
      finalizeContentAsset(options),
    ]);

    assert.equal(first, second);
    assert.equal(first.status, 'ready');
    assert.equal(db.prepare('SELECT version FROM content WHERE id=?').get('video-id').version, 2);
    assert.equal(db.prepare('SELECT generation FROM asset_checksums').get().generation, 2);
    assert.equal(prewarms, 1);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('late finalization cannot publish during or after permanent erase', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-finalize-erase-barrier-'));
  const db = createDb('source.mp4');
  db.exec(`CREATE TABLE content_erase_operations (
    id TEXT PRIMARY KEY, content_id TEXT NOT NULL, state TEXT NOT NULL
  )`);
  const finalize = (candidatePath, finalPath) => finalizeContentAsset({
    db,
    contentId: 'video-id',
    expectedFilepath: 'source.mp4',
    candidatePath,
    finalPath,
    finalFilepath: path.basename(finalPath),
    metadata: { mimeType: 'video/mp4', probe: safeProbe() },
  });

  try {
    db.prepare("INSERT INTO content_erase_operations VALUES ('erase','video-id','prepared')").run();
    const preparedCandidate = path.join(dir, 'prepared.part');
    const preparedFinal = path.join(dir, 'prepared.mp4');
    fs.writeFileSync(preparedCandidate, 'late-prepared');
    assert.deepEqual(await finalize(preparedCandidate, preparedFinal), { status: 'stale', content_id: 'video-id' });
    assert.equal(fs.existsSync(preparedCandidate), false);
    assert.equal(fs.existsSync(preparedFinal), false);
    assert.equal(db.prepare("SELECT filepath FROM content WHERE id='video-id'").get().filepath, 'source.mp4');

    db.prepare("DELETE FROM content WHERE id='video-id'").run();
    db.prepare("UPDATE content_erase_operations SET state='completed' WHERE id='erase'").run();
    const completedCandidate = path.join(dir, 'completed.part');
    const completedFinal = path.join(dir, 'completed.mp4');
    fs.writeFileSync(completedCandidate, 'late-completed');
    assert.deepEqual(await finalize(completedCandidate, completedFinal), { status: 'stale', content_id: 'video-id' });
    assert.equal(fs.existsSync(completedCandidate), false);
    assert.equal(fs.existsSync(completedFinal), false);
    assert.equal(db.prepare("SELECT COUNT(*) count FROM content WHERE id='video-id'").get().count, 0);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('an offline P3 still receives the final generation through periodic manifest recovery', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-offline-p3-'));
  const source = path.join(dir, 'safe.mp4');
  fs.writeFileSync(source, 'recoverable-final');
  const db = createDb('safe.mp4');

  try {
    const result = await finalizeContentAsset({
      db,
      io: null,
      contentId: 'video-id',
      expectedFilepath: 'safe.mp4',
      candidatePath: source,
      finalPath: source,
      finalFilepath: 'safe.mp4',
      metadata: { mimeType: 'video/mp4', probe: safeProbe() },
      prewarmContent: async () => ({ requested: false, reason: 'socket_unavailable' }),
    });
    assert.equal(result.status, 'ready');
    assert.equal(result.prewarm.requested, false);

    const manifest = buildContentManifest(db, { queueMissing: false, allowUnscoped: true });
    assert.equal(manifest.length, 1);
    assert.equal(manifest[0].content_id, 'video-id');
    assert.equal(manifest[0].generation, 2);
    assert.equal(manifest[0].sha256, crypto.createHash('sha256').update('recoverable-final').digest('hex'));
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
