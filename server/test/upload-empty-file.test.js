const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const upload = require('../middleware/upload');
const config = require('../config');
const contentRoutePath = path.join(__dirname, '..', 'routes', 'content.js');

test('uploadedFileHasBytes requires both positive multipart metadata and real file bytes', () => {
  const realFile = { filename: '3a53eb20-baf8-4f4d-8eca-d0546643f310.mp4', path: '/tmp/ignored.mp4', size: 25 };
  const expectedPath = path.join(path.resolve(config.contentDir), realFile.filename);
  const positiveStat = candidate => {
    assert.equal(candidate, expectedPath);
    return { isFile: () => true, size: 25 };
  };

  assert.equal(upload.uploadedFileHasBytes(realFile, positiveStat), true);
  assert.equal(upload.uploadedFileHasBytes(null, positiveStat), false);
  assert.equal(upload.uploadedFileHasBytes({ ...realFile, size: 0 }, positiveStat), false);
  assert.equal(upload.uploadedFileHasBytes({ ...realFile, filename: '../../outside.mp4' }, positiveStat), false);
  assert.equal(upload.uploadedFileHasBytes(realFile, () => ({ isFile: () => true, size: 0 })), false);
  assert.equal(upload.uploadedFileHasBytes(realFile, () => ({ isFile: () => false, size: 25 })), false);
  assert.equal(upload.uploadedFileHasBytes(realFile, () => { throw new Error('missing'); }), false);
});

test('generated upload paths are direct children of the configured content root', () => {
  const filename = '3a53eb20-baf8-4f4d-8eca-d0546643f310.pptx';
  assert.equal(upload.resolveUploadedFilePath({ filename }), path.join(path.resolve(config.contentDir), filename));
  assert.equal(upload.resolveUploadedFilePath({ filename: '../outside.pptx' }), null);
  assert.equal(upload.resolveUploadedFilePath({ filename: 'not-a-generated-name.pptx' }), null);
});

test('create and replace routes reject and remove empty uploads before content writes', () => {
  const source = fs.readFileSync(contentRoutePath, 'utf8');
  const checks = source.match(/uploadedFileHasBytes\(req\.file\)/g) || [];
  const responses = source.match(/code:\s*'EMPTY_UPLOAD'/g) || [];

  assert.equal(checks.length, 2);
  assert.equal(responses.length, 2);
  // Empty uploads must be removed from disk, but the removal must go through the
  // validated path resolver (never req.file.path, which is tainted upload input).
  assert.match(source, /discardUploadedFile\(req\.file\)/);
  assert.match(source, /Uploaded file is empty/);
});
