'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('PPTX rendering passes only the presentation raster allowlist to image-size', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'services', 'pptx.js'), 'utf8');
  for (const mime of ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/bmp']) {
    assert.match(source, new RegExp(`['"]${mime.replace('/', '\\/')}['"]`));
  }
  assert.match(source, /PPTX_IMAGE_MIME\.has\(asset\.mime\)/);
  assert.doesNotMatch(source, /c\.mime_type\.startsWith\(['"]image\//);
});

test('PPTX rendering disables every image-size parser named by the open loop advisories', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'services', 'pptx.js'), 'utf8');

  assert.match(source, /disableTypes\(\['heif', 'icns', 'jxl', 'jxl-stream'\]\)/);
  assert.match(source, /require\('image-size'\)/);
  assert.match(source, /disableTypes[\s\S]*require\('pptxgenjs'\)/);
});
