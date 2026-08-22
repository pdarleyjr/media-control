'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');

const {
  buildVideoPosterArgs,
  commitThumbnail,
  normalizePosterRequest,
} = require('../lib/thumbnail-studio');
const { sha256File } = require('../lib/asset-manifest');

test('thumbnail studio validates timestamp and crop position without shell syntax', () => {
  assert.deepEqual(
    normalizePosterRequest({ timestamp_seconds: '12.5', position: 'top' }, {
      isVideo: true,
      durationSeconds: 30,
    }),
    { timestampSeconds: 12.5, position: 'top' },
  );
  assert.throws(
    () => normalizePosterRequest({ timestamp_seconds: 31, position: 'center' }, {
      isVideo: true,
      durationSeconds: 30,
    }),
    /timestamp_out_of_range/,
  );
  assert.throws(
    () => normalizePosterRequest({ timestamp_seconds: 1, position: 'left;rm' }, {
      isVideo: true,
      durationSeconds: 30,
    }),
    /invalid_poster_position/,
  );

  const args = buildVideoPosterArgs({
    inputPath: 'source video.mp4',
    outputPath: 'poster frame.png',
    timestampSeconds: 12.5,
  });
  assert.deepEqual(args.slice(0, 4), ['-y', '-ss', '12.500', '-i']);
  assert.ok(args.includes('source video.mp4'));
  assert.ok(args.includes('poster frame.png'));
  assert.ok(args.includes('1'));
  assert.equal(args.some((arg) => /[;&|`]/.test(arg)), false);
});

test('thumbnail commit is version, path, and source-hash guarded and records provenance', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-thumbnail-studio-'));
  const source = path.join(tmp, 'source.mp4');
  const candidate = path.join(tmp, 'thumb_c1_custom.jpg');
  const stale = path.join(tmp, 'thumb_old.jpg');
  fs.writeFileSync(source, 'canonical-video-bytes');
  fs.writeFileSync(candidate, 'jpeg-poster-bytes');
  fs.writeFileSync(stale, 'old-poster');
  const sourceHash = await sha256File(source);
  const db = new Database(':memory:');
  try {
    db.exec(`
      CREATE TABLE content (
        id TEXT PRIMARY KEY,
        workspace_id TEXT,
        filepath TEXT,
        version INTEGER,
        processing_status TEXT,
        thumbnail_path TEXT,
        updated_at INTEGER
      );
      CREATE TABLE content_media_metadata (
        content_id TEXT PRIMARY KEY,
        workspace_id TEXT,
        thumbnail_generation INTEGER,
        thumbnail_source_sha256 TEXT,
        thumbnail_source_filepath TEXT,
        thumbnail_provenance TEXT,
        created_at INTEGER,
        updated_at INTEGER
      );
      CREATE TABLE asset_checksums (
        asset_id TEXT PRIMARY KEY,
        content_id TEXT,
        poster_path TEXT
      );
      CREATE TABLE content_erase_operations (
        id TEXT PRIMARY KEY,
        content_id TEXT,
        state TEXT
      );
      INSERT INTO content VALUES
        ('c1', 'w1', 'source.mp4', 7, 'ready', 'thumb_old.jpg', 1);
      INSERT INTO asset_checksums VALUES ('a1', 'c1', 'thumb_old.jpg');
    `);

    const committed = await commitThumbnail({
      db,
      contentDir: tmp,
      contentId: 'c1',
      expectedFilepath: 'source.mp4',
      expectedVersion: 7,
      expectedSourceSha256: sourceHash,
      thumbnailPath: candidate,
      thumbnailFilename: path.basename(candidate),
      provenance: 'custom_upload:center',
      now: () => 200,
    });
    assert.equal(committed.status, 'ready');
    assert.equal(
      db.prepare('SELECT thumbnail_path FROM content WHERE id=?').get('c1').thumbnail_path,
      'thumb_c1_custom.jpg',
    );
    assert.deepEqual(
      db.prepare(`
        SELECT thumbnail_generation, thumbnail_source_sha256,
          thumbnail_source_filepath, thumbnail_provenance
        FROM content_media_metadata WHERE content_id=?
      `).get('c1'),
      {
        thumbnail_generation: 1,
        thumbnail_source_sha256: sourceHash,
        thumbnail_source_filepath: 'source.mp4',
        thumbnail_provenance: 'custom_upload:center',
      },
    );
    assert.equal(
      db.prepare('SELECT poster_path FROM asset_checksums WHERE content_id=?').get('c1').poster_path,
      'thumb_c1_custom.jpg',
    );
    assert.equal(fs.existsSync(stale), false);

    const staleCandidate = path.join(tmp, 'thumb_stale.jpg');
    fs.writeFileSync(staleCandidate, 'stale-poster');
    const rejected = await commitThumbnail({
      db,
      contentDir: tmp,
      contentId: 'c1',
      expectedFilepath: 'source.mp4',
      expectedVersion: 6,
      expectedSourceSha256: sourceHash,
      thumbnailPath: staleCandidate,
      thumbnailFilename: path.basename(staleCandidate),
      provenance: 'video_timestamp:center',
    });
    assert.equal(rejected.status, 'stale');
    assert.equal(fs.existsSync(staleCandidate), false);

    const eraseCandidate = path.join(tmp, 'thumb_erase_race.jpg');
    fs.writeFileSync(eraseCandidate, 'must-not-commit');
    db.prepare("INSERT INTO content_erase_operations VALUES ('erase-c1','c1','prepared')").run();
    const eraseRejected = await commitThumbnail({
      db,
      contentDir: tmp,
      contentId: 'c1',
      expectedFilepath: 'source.mp4',
      expectedVersion: 7,
      expectedSourceSha256: sourceHash,
      thumbnailPath: eraseCandidate,
      thumbnailFilename: path.basename(eraseCandidate),
      provenance: 'video_timestamp:center',
    });
    assert.deepEqual(eraseRejected, { status: 'stale', reason: 'erase_in_progress', content_id: 'c1' });
    assert.equal(fs.existsSync(eraseCandidate), false);
    assert.equal(db.prepare("SELECT thumbnail_path FROM content WHERE id='c1'").get().thumbnail_path, 'thumb_c1_custom.jpg');
  } finally {
    db.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('Media Library exposes thumbnail studio and durable processing center controls', () => {
  const view = fs.readFileSync(
    path.resolve(__dirname, '../../frontend/js/views/content-library.js'),
    'utf8',
  );
  const api = fs.readFileSync(
    path.resolve(__dirname, '../../frontend/js/api.js'),
    'utf8',
  );
  for (const contract of [
    'data-thumbnail-studio',
    'data-thumbnail-upload',
    'data-thumbnail-generate',
    'data-thumbnail-position',
    'data-thumbnail-timestamp',
    'data-processing-center',
    'data-media-job-retry',
    'data-media-job-cancel',
  ]) {
    assert.match(view, new RegExp(contract));
  }
  assert.match(api, /updateContentThumbnail/);
  assert.match(api, /getMediaJobs/);
  assert.match(api, /retryMediaJob/);
  assert.match(api, /cancelMediaJob/);
});
