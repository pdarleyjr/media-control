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
const { isAllowedUploadMime } = require('../middleware/upload');
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
