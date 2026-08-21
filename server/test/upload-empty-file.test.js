const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const upload = require('../middleware/upload');
const { createTrustedUploadStorage } = require('../lib/trusted-upload-storage');
const config = require('../config');
const contentRoutePath = path.join(__dirname, '..', 'routes', 'content.js');
const statusRoutePath = path.join(__dirname, '..', 'routes', 'status.js');

function generatedUploadFile(originalname = 'source.mp4') {
  const file = { originalname, mimetype: 'video/mp4' };
  let filename;
  upload.storage.getFilename({}, file, (error, value) => {
    if (error) throw error;
    filename = value;
  });
  return { ...file, filename, path: '/untrusted/client/path', size: 25 };
}

test('uploadedFileHasBytes accepts only a real regular file issued by this Multer storage', (t) => {
  fs.mkdirSync(config.contentDir, { recursive: true });
  const realFile = generatedUploadFile();
  const expectedPath = path.join(path.resolve(config.contentDir), realFile.filename);
  t.after(() => fs.rmSync(expectedPath, { force: true }));
  fs.writeFileSync(expectedPath, 'real upload bytes');

  assert.equal(upload.uploadedFileHasBytes(realFile), true);
  assert.equal(upload.uploadedFileHasBytes(null), false);
  assert.equal(upload.uploadedFileHasBytes({ ...realFile, size: 0 }), false);
  assert.equal(upload.uploadedFileHasBytes({ filename: realFile.filename, size: 25 }), false);

  fs.writeFileSync(expectedPath, '');
  assert.equal(upload.uploadedFileHasBytes(realFile), false);
});

test('generated upload paths are direct regular children and cannot be forged by filename', (t) => {
  fs.mkdirSync(config.contentDir, { recursive: true });
  const realFile = generatedUploadFile('source.pptx');
  const expectedPath = path.join(fs.realpathSync(config.contentDir), realFile.filename);
  t.after(() => fs.rmSync(expectedPath, { force: true }));
  fs.writeFileSync(expectedPath, 'presentation');

  assert.equal(upload.resolveUploadedFilePath(realFile), expectedPath);
  assert.equal(upload.resolveUploadedFilePath({ filename: realFile.filename, size: 25 }), null);

  fs.rmSync(expectedPath);
  fs.mkdirSync(expectedPath);
  assert.equal(upload.resolveUploadedFilePath(realFile), null);
  fs.rmSync(expectedPath, { recursive: true, force: true });
});

test('trusted upload resolver rejects a symlink leaf', (t) => {
  const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'trusted-upload-leaf-'));
  const outsidePath = path.join(testRoot, '..', `${path.basename(testRoot)}-outside`);
  const trusted = createTrustedUploadStorage({ root: testRoot, createFilename: () => 'issued.upload' });
  const file = {};
  trusted.storage.getFilename({}, file, (error, filename) => {
    if (error) throw error;
    file.filename = filename;
  });
  fs.writeFileSync(outsidePath, 'outside');
  t.after(() => {
    fs.rmSync(testRoot, { recursive: true, force: true });
    fs.rmSync(outsidePath, { force: true });
  });

  try {
    fs.symlinkSync(outsidePath, path.join(testRoot, file.filename), 'file');
  } catch (error) {
    t.skip(`symlinks unavailable: ${error.code || error.message}`);
    return;
  }
  assert.equal(trusted.resolveUploadedFilePath(file), null);
});

test('trusted upload resolver keeps the original real root after its configured link is swapped', (t) => {
  const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'trusted-upload-root-'));
  const originalRoot = path.join(testRoot, 'original');
  const replacementRoot = path.join(testRoot, 'replacement');
  const configuredLink = path.join(testRoot, 'uploads');
  fs.mkdirSync(originalRoot);
  fs.mkdirSync(replacementRoot);
  t.after(() => fs.rmSync(testRoot, { recursive: true, force: true }));

  try {
    fs.symlinkSync(originalRoot, configuredLink, process.platform === 'win32' ? 'junction' : 'dir');
  } catch (error) {
    t.skip(`directory links unavailable: ${error.code || error.message}`);
    return;
  }
  const trusted = createTrustedUploadStorage({ root: configuredLink, createFilename: () => 'issued.upload' });
  const file = {};
  trusted.storage.getFilename({}, file, (error, filename) => {
    if (error) throw error;
    file.filename = filename;
  });
  const originalFile = path.join(originalRoot, file.filename);
  fs.writeFileSync(originalFile, 'trusted');
  fs.rmSync(configuredLink);
  fs.symlinkSync(replacementRoot, configuredLink, process.platform === 'win32' ? 'junction' : 'dir');
  fs.writeFileSync(path.join(replacementRoot, file.filename), 'replacement');

  assert.equal(trusted.resolveUploadedFilePath(file), fs.realpathSync(originalFile));
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

test('status import resolves its independently issued temp upload before opening it', () => {
  const source = fs.readFileSync(statusRoutePath, 'utf8');

  assert.match(source, /const uploadedPath = importStorage\.resolveUploadedFilePath\(req\.file\)/);
  assert.match(source, /if \(!uploadedPath\)/);
  assert.match(source, /fs\.createReadStream\(uploadedPath\)/);
  assert.doesNotMatch(source, /fs\.createReadStream\(upload\.resolveUploadedFilePath\(req\.file\)\)/);
});
