const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const crypto = require('crypto');
const Database = require('better-sqlite3');

const {
  isDocThumbnailMime,
  generateDocThumbnail,
  embeddedThumbnail,
  commitGeneratedThumbnail,
} = require('../lib/doc-thumbnail');
const { migrateMediaPipeline } = require('../db/migrations/media-pipeline');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-docthumb-'));
process.on('exit', () => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} });

// Build a tiny zip (ODF/OOXML are zips) containing one entry, using Archiver's
// v8 class API (already a direct dependency, present in the container).
function makeZip(zipPath, entryName, buffer) {
  const { ZipArchive } = require('archiver');
  return new Promise((resolve, reject) => {
    const out = fs.createWriteStream(zipPath);
    const archive = new ZipArchive({});
    out.on('close', resolve);
    archive.on('error', reject);
    archive.pipe(out);
    archive.append(buffer, { name: entryName });
    archive.finalize();
  });
}

test('isDocThumbnailMime classifies PDF + Office + ODF as doc types', () => {
  for (const mt of [
    'application/pdf',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/vnd.ms-powerpoint',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    'application/vnd.oasis.opendocument.text',
    'application/vnd.oasis.opendocument.spreadsheet',
    'application/vnd.oasis.opendocument.presentation',
  ]) {
    assert.equal(isDocThumbnailMime(mt), true, `${mt} should be a doc type`);
  }
});

test('isDocThumbnailMime rejects non-document types', () => {
  for (const mt of ['image/png', 'image/jpeg', 'video/mp4', 'text/html', 'application/json', '']) {
    assert.equal(isDocThumbnailMime(mt), false, `${mt} should NOT be a doc type`);
  }
});

test('generateDocThumbnail returns null for a non-document mime', async () => {
  const out = await generateDocThumbnail({ srcPath: __filename, mimeType: 'image/png', contentDir: tmp });
  assert.equal(out, null);
});

test('generateDocThumbnail returns null when the source file is missing', async () => {
  const out = await generateDocThumbnail({
    srcPath: path.join(tmp, 'does-not-exist.pptx'),
    mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    contentDir: tmp,
  });
  assert.equal(out, null);
});

test('embeddedThumbnail extracts an ODF Thumbnails/thumbnail.png', async () => {
  const sharp = require('sharp');
  const png = await sharp({ create: { width: 160, height: 90, channels: 3, background: { r: 12, g: 34, b: 56 } } }).png().toBuffer();
  const odp = path.join(tmp, 'deck.odp');
  await makeZip(odp, 'Thumbnails/thumbnail.png', png);
  const buf = await embeddedThumbnail(odp);
  assert.ok(buf && buf.length > 0, 'should recover the embedded PNG buffer');
});

test('generateDocThumbnail renders an embedded ODF preview to a resized jpeg', async () => {
  const sharp = require('sharp');
  const png = await sharp({ create: { width: 800, height: 600, channels: 3, background: { r: 200, g: 30, b: 30 } } }).png().toBuffer();
  const odp = path.join(tmp, 'embedded.odp');
  await makeZip(odp, 'Thumbnails/thumbnail.png', png);

  const out = await generateDocThumbnail({
    srcPath: odp,
    mimeType: 'application/vnd.oasis.opendocument.presentation',
    contentDir: tmp,
    thumbnailWidth: 320,
  });
  assert.equal(out, 'thumb_embedded.jpg');
  const outPath = path.join(tmp, out);
  assert.ok(fs.existsSync(outPath), 'thumbnail file should exist');
  const meta = await sharp(outPath).metadata();
  assert.equal(meta.format, 'jpeg');
  assert.equal(meta.width, 320, 'thumbnail should be resized to thumbnailWidth');
});

// OOXML without an embedded preview AND without LibreOffice installed -> null
// (graceful: the row keeps its icon fallback). This mirrors the real Gamma PPTX.
test('generateDocThumbnail returns null for OOXML with no embedded preview when soffice is absent', async () => {
  const hasSoffice = (() => {
    try { require('child_process').execFileSync('soffice', ['--version'], { stdio: 'ignore', timeout: 5000 }); return true; }
    catch { return false; }
  })();
  if (hasSoffice) { return; } // when LibreOffice IS present it would render a real thumbnail; skip the negative assertion
  const pptx = path.join(tmp, 'nopreview.pptx');
  await makeZip(pptx, 'docProps/app.xml', Buffer.from('<Properties/>'));
  const out = await generateDocThumbnail({
    srcPath: pptx,
    mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    contentDir: tmp,
  });
  assert.equal(out, null);
});

function thumbnailDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE schema_migrations (id TEXT PRIMARY KEY);
    CREATE TABLE content (
      id TEXT PRIMARY KEY,
      workspace_id TEXT,
      filepath TEXT NOT NULL,
      thumbnail_path TEXT,
      original_sha256 TEXT,
      processing_status TEXT,
      processing_error TEXT,
      version INTEGER NOT NULL,
      updated_at INTEGER
    );
    INSERT INTO content
      (id, workspace_id, filepath, processing_status, version)
    VALUES ('doc-1', 'workspace-1', 'current.pdf', 'uploaded', 3);
  `);
  migrateMediaPipeline(db);
  return db;
}

test('thumbnail commit is guarded by content version, path, and current source hash', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-thumb-race-'));
  const source = path.join(dir, 'current.pdf');
  const thumb = path.join(dir, 'thumb_current.jpg');
  fs.writeFileSync(source, 'version-three-source');
  fs.writeFileSync(thumb, 'obsolete-thumbnail');
  const expectedSha = crypto.createHash('sha256').update('version-three-source').digest('hex');
  const db = thumbnailDb();
  try {
    db.prepare("UPDATE content SET filepath='replacement.pdf', version=4 WHERE id='doc-1'").run();
    const result = await commitGeneratedThumbnail({
      db,
      contentId: 'doc-1',
      expectedVersion: 3,
      expectedFilepath: 'current.pdf',
      expectedSha256: expectedSha,
      sourcePath: source,
      thumbnailPath: thumb,
      thumbnailFilename: 'thumb_current.jpg',
      provenance: 'pdf_page_1',
      contentDir: dir,
    });
    assert.equal(result.status, 'stale');
    assert.equal(fs.existsSync(thumb), false, 'stale derivative is retired');
    assert.equal(db.prepare("SELECT thumbnail_path FROM content WHERE id='doc-1'").get().thumbnail_path, null);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('matching thumbnail commit stores provenance and emits one content update', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-thumb-commit-'));
  const source = path.join(dir, 'current.pdf');
  const thumb = path.join(dir, 'thumb_current.jpg');
  fs.writeFileSync(source, 'version-three-source');
  fs.writeFileSync(thumb, 'current-thumbnail');
  const expectedSha = crypto.createHash('sha256').update('version-three-source').digest('hex');
  const events = [];
  const db = thumbnailDb();
  try {
    const result = await commitGeneratedThumbnail({
      db,
      io: {
        of: () => ({
          to: () => ({ emit: (event, payload) => events.push({ event, payload }) }),
        }),
      },
      contentId: 'doc-1',
      expectedVersion: 3,
      expectedFilepath: 'current.pdf',
      expectedSha256: expectedSha,
      sourcePath: source,
      thumbnailPath: thumb,
      thumbnailFilename: 'thumb_current.jpg',
      provenance: 'pdf_page_1',
      contentDir: dir,
    });
    assert.equal(result.status, 'ready');
    assert.equal(db.prepare("SELECT thumbnail_path FROM content WHERE id='doc-1'").get().thumbnail_path, 'thumb_current.jpg');
    const metadata = db.prepare("SELECT * FROM content_media_metadata WHERE content_id='doc-1'").get();
    assert.equal(metadata.thumbnail_generation, 3);
    assert.equal(metadata.thumbnail_source_sha256, expectedSha);
    assert.equal(metadata.thumbnail_source_filepath, 'current.pdf');
    assert.equal(metadata.thumbnail_provenance, 'pdf_page_1');
    assert.equal(events.length, 1);
    assert.equal(events[0].payload.generation, 3);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
