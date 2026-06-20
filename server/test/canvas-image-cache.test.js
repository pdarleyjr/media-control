const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');
const sharp = require('sharp');
const { getCanvasImageVariant } = require('../lib/canvas-image-cache');

test('canvas image variants are bounded to the target layer and cached', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'canvas-image-'));
  const source = path.join(dir, 'source.png');
  try {
    await sharp({ create: { width: 4000, height: 2000, channels: 3, background: '#1677ff' } })
      .png()
      .toFile(source);
    const first = await getCanvasImageVariant('image-1', source, 1920, 1080, dir);
    const second = await getCanvasImageVariant('image-1', source, 1920, 1080, dir);
    const metadata = await sharp(fs.readFileSync(first)).metadata();
    assert.equal(first, second);
    assert.equal(metadata.width, 1920);
    assert.equal(metadata.height, 960);
    assert.equal(metadata.format, 'webp');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});
