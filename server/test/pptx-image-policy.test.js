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
  assert.match(source, /PPTX_IMAGE_MIME\.has\(c\.mime_type\)/);
  assert.doesNotMatch(source, /c\.mime_type\.startsWith\(['"]image\//);
});
