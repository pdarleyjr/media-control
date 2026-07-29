const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');

const tempBase = process.env.KILO_TEMP || path.join(os.tmpdir(), 'kilo');
fs.mkdirSync(tempBase, { recursive: true });
const dbDir = fs.mkdtempSync(path.join(tempBase, 'mc-upload-policy-db-'));
process.env.DB_PATH = path.join(dbDir, 'test.db');
const { finalizeUpload } = require('../lib/finalize-upload');
const { isAllowedUploadMime, resolveUploadMime } = require('../middleware/upload');
const { db } = require('../db/database');
process.on('exit', () => {
  try { db.close(); } catch {}
  fs.rmSync(dbDir, { recursive: true, force: true });
});

test('upload policy rejects script-capable image and HTML types', () => {
  assert.equal(isAllowedUploadMime('image/svg+xml'), false);
  assert.equal(isAllowedUploadMime('text/html'), false);
  assert.equal(isAllowedUploadMime('application/javascript'), false);
});

test('upload policy allows expected media and document types', () => {
  assert.equal(isAllowedUploadMime('image/png'), true);
  assert.equal(isAllowedUploadMime('video/mp4'), true);
  assert.equal(isAllowedUploadMime('application/pdf'), true);
  assert.equal(isAllowedUploadMime('image/avif'), true);
  // iPhone HEIC/HEIF accepted (transcoded to JPEG on upload).
  assert.equal(isAllowedUploadMime('image/heic'), true);
  assert.equal(isAllowedUploadMime('image/heif'), true);
});

test('resolveUploadMime recovers iPhone HEIC from extension on a generic MIME', () => {
  assert.equal(resolveUploadMime({ mimetype: 'application/octet-stream', originalname: 'IMG_1234.HEIC' }), 'image/heic');
  assert.equal(resolveUploadMime({ mimetype: '', originalname: 'photo.heif' }), 'image/heif');
});

test('resolveUploadMime recovers the real type from the extension when the client sends a generic MIME', () => {
  // mkv/mov/avi frequently arrive as octet-stream on Windows; recover from ext.
  assert.equal(resolveUploadMime({ mimetype: 'application/octet-stream', originalname: 'clip.mkv' }), 'video/x-matroska');
  assert.equal(resolveUploadMime({ mimetype: 'application/octet-stream', originalname: 'movie.mov' }), 'video/quicktime');
  // pptx/docx may arrive as application/zip (they ARE zips) — recover from ext.
  assert.equal(resolveUploadMime({ mimetype: 'application/zip', originalname: 'deck.pptx' }),
    'application/vnd.openxmlformats-officedocument.presentationml.presentation');
  assert.equal(resolveUploadMime({ mimetype: '', originalname: 'report.pdf' }), 'application/pdf');
});

test('resolveUploadMime passes a correct specific MIME through unchanged', () => {
  assert.equal(resolveUploadMime({ mimetype: 'image/png', originalname: 'a.png' }), 'image/png');
  assert.equal(resolveUploadMime({ mimetype: 'video/mp4', originalname: 'a.mp4' }), 'video/mp4');
});

test('resolveUploadMime does NOT widen acceptance: disallowed/unknown stay rejected', () => {
  // Google Doc stub + a specific disallowed type + an unknown extension on a generic MIME.
  assert.equal(resolveUploadMime({ mimetype: 'application/octet-stream', originalname: 'doc.gdoc' }), null);
  assert.equal(resolveUploadMime({ mimetype: 'image/svg+xml', originalname: 'x.svg' }), null);
  assert.equal(resolveUploadMime({ mimetype: 'application/octet-stream', originalname: 'malware.exe' }), null);
  // A SPECIFIC disallowed MIME is never extension-recovered even with a known ext.
  assert.equal(resolveUploadMime({ mimetype: 'text/html', originalname: 'page.pdf' }), null);
});

test('TUS finalize rejects disallowed client metadata before creating content', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-upload-policy-'));
  const file = path.join(dir, 'payload.html');
  fs.writeFileSync(file, '<script>alert(1)</script>');

  await assert.rejects(
    finalizeUpload({
      absPath: file,
      originalName: 'payload.html',
      mimeType: 'text/html',
      size: 25,
      userId: 'test-user',
      workspaceId: 'test-workspace',
    }),
    /Only video, image, PDF, and Office document files are allowed/
  );

  assert.equal(fs.existsSync(file), false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('TUS finalize recovers canonical Office/PDF MIME from generic client metadata', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-upload-policy-'));
  const rows = [
    {
      name: 'deck.pptx',
      mime: 'application/zip',
      expected: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    },
    {
      name: 'incident-plan.pdf',
      mime: '',
      expected: 'application/pdf',
    },
  ];

  // Keep this test focused on finalizeUpload's policy behavior. The test DB has
  // no real users/workspaces, and FK behavior is covered elsewhere.
  db.pragma('foreign_keys = OFF');
  let jobSequence = 0;
  const pipeline = {
    enqueueVideo: () => ({ job: { id: `job-${++jobSequence}`, status: 'queued', stage: 'received', progress_pct: 0 } }),
    enqueueThumbnailFinalize: () => ({ job: { id: `job-${++jobSequence}`, status: 'queued', stage: 'received', progress_pct: 0 } }),
  };
  try {
    for (const r of rows) {
      const file = path.join(dir, r.name);
      fs.writeFileSync(
        file,
        r.name.endsWith('.pdf')
          ? Buffer.from('%PDF-1.7\n')
          : Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x00, 0x00]),
      );
      const inserted = await finalizeUpload({
        absPath: file,
        originalName: r.name,
        mimeType: r.mime,
        size: 10,
        userId: 'test-user',
        workspaceId: 'test-workspace',
        contentDir: dir,
        pipeline,
      });
      assert.equal(inserted.mime_type, r.expected);
      assert.equal(inserted.filename, r.name);
      assert.equal(fs.existsSync(file), false);
      assert.equal(inserted.media_job.status, 'queued');
    }
  } finally {
    db.pragma('foreign_keys = ON');
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('TUS finalize rolls back the catalog and removes materialized bytes when queueing fails', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-upload-queue-fail-'));
  const file = path.join(dir, 'plan.pdf');
  fs.writeFileSync(file, '%PDF-1.7\n');
  const before = db.prepare('SELECT COUNT(*) AS count FROM content').get().count;
  db.pragma('foreign_keys = OFF');
  try {
    await assert.rejects(
      finalizeUpload({
        absPath: file,
        originalName: 'plan.pdf',
        mimeType: 'application/pdf',
        size: fs.statSync(file).size,
        userId: 'test-user',
        workspaceId: 'test-workspace',
        contentDir: dir,
        pipeline: {
          enqueueThumbnailFinalize: () => {
            throw new Error('queue unavailable');
          },
        },
      }),
      /queue unavailable/,
    );
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM content').get().count, before);
    assert.deepEqual(fs.readdirSync(dir), [], 'neither assembled nor renamed partial bytes remain');
  } finally {
    db.pragma('foreign_keys = ON');
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
