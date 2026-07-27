const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const upload = require('../middleware/upload');
const contentRoutePath = path.join(__dirname, '..', 'routes', 'content.js');

test('uploadedFileHasBytes requires both positive multipart metadata and real file bytes', () => {
  const realFile = { path: '/tmp/media.mp4', size: 25 };
  const positiveStat = () => ({ isFile: () => true, size: 25 });

  assert.equal(upload.uploadedFileHasBytes(realFile, positiveStat), true);
  assert.equal(upload.uploadedFileHasBytes(null, positiveStat), false);
  assert.equal(upload.uploadedFileHasBytes({ path: '/tmp/media.mp4', size: 0 }, positiveStat), false);
  assert.equal(upload.uploadedFileHasBytes(realFile, () => ({ isFile: () => true, size: 0 })), false);
  assert.equal(upload.uploadedFileHasBytes(realFile, () => ({ isFile: () => false, size: 25 })), false);
  assert.equal(upload.uploadedFileHasBytes(realFile, () => { throw new Error('missing'); }), false);
});

test('create and replace routes reject and remove empty uploads before content writes', () => {
  const source = fs.readFileSync(contentRoutePath, 'utf8');
  const checks = source.match(/uploadedFileHasBytes\(req\.file\)/g) || [];
  const responses = source.match(/code:\s*'EMPTY_UPLOAD'/g) || [];

  assert.equal(checks.length, 2);
  assert.equal(responses.length, 2);
  assert.match(source, /fs\.unlinkSync\(req\.file\.path\)/);
  assert.match(source, /Uploaded file is empty/);
});
