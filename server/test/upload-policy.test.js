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
