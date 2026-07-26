'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const unzipper = require('unzipper');
const { createZipArchive } = require('../lib/zip-archive');

test('createZipArchive produces a readable ZIP with the requested payload', async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mbfd-zip-archive-'));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const zipPath = path.join(tempDir, 'export.zip');

  await new Promise((resolve, reject) => {
    const output = fs.createWriteStream(zipPath);
    const archive = createZipArchive({ zlib: { level: 5 } });
    output.on('close', resolve);
    output.on('error', reject);
    archive.on('error', reject);
    archive.pipe(output);
    archive.append('verified export', { name: 'export.txt' });
    archive.finalize();
  });

  const zip = await unzipper.Open.file(zipPath);
  assert.deepEqual(zip.files.map((entry) => entry.path), ['export.txt']);
  assert.equal((await zip.files[0].buffer()).toString(), 'verified export');
});
