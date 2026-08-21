'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const run = promisify(execFile);
const renderer = path.join(__dirname, '..', 'services', 'pptx.js');
const renderScript = `
const [renderer, filePath, mime] = process.argv.slice(1);
const { renderDeckToPptxBuffer } = require(renderer);
renderDeckToPptxBuffer(
  { title: 'Policy', slides: [{ title: 'Image', images: [{ content_id: 'fixture' }] }] },
  { allowedContentIds: new Set(['fixture']), resolveContentAsset: async () => ({ path: filePath, mime }) },
).then((buffer) => process.stdout.write('RENDERED:' + buffer.length))
  .catch((error) => { process.stderr.write(String(error.message || error)); process.exitCode = 2; });
`;

function onePixelBmp() {
  return Buffer.from(
    '424d3a0000000000000036000000280000000100000001000000010018000000000004000000000000000000000000000000000000000000ff00',
    'hex',
  );
}

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

test('clean-process PPTX rendering accepts every supported raster byte format', async (t) => {
  const sharp = require('sharp');
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'pptx-safe-raster-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const base = sharp({
    create: { width: 1, height: 1, channels: 4, background: { r: 208, g: 44, b: 44, alpha: 1 } },
  });
  const fixtures = [
    ['image/jpeg', 'jpg', await base.clone().jpeg().toBuffer()],
    ['image/png', 'png', await base.clone().png().toBuffer()],
    ['image/gif', 'gif', await base.clone().gif().toBuffer()],
    ['image/webp', 'webp', await base.clone().webp().toBuffer()],
    ['image/bmp', 'bmp', onePixelBmp()],
  ];

  for (const [mime, extension, bytes] of fixtures) {
    const fixture = path.join(temp, `fixture.${extension}`);
    fs.writeFileSync(fixture, bytes);
    const result = await run(process.execPath, ['-e', renderScript, renderer, fixture, mime], { timeout: 5000 });
    assert.match(result.stdout, /RENDERED:\d+/, mime);
  }
});

test('clean-process PPTX rendering promptly rejects disabled parser signatures mislabeled as allowed PNG', async (t) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'pptx-disabled-raster-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const fixtures = [
    ['icns', '69636e7300000010'],
    ['jxl-stream', 'ff0a000000000000'],
    ['jxl', '0000000c4a584c200d0a870a00000014667479706a786c20000000006a786c20'],
    ['heif', '000000186674797068656963000000000000000000000000'],
  ];

  for (const [type, hex] of fixtures) {
    const fixture = path.join(temp, `${type}.bin`);
    fs.writeFileSync(fixture, Buffer.from(hex, 'hex'));
    await assert.rejects(
      run(process.execPath, ['-e', renderScript, renderer, fixture, 'image/png'], { timeout: 5000 }),
      (error) => error.code === 2 && String(error.stderr).includes(`disabled file type: ${type}`),
      type,
    );
  }
});
