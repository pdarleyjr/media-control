'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { resolveStoredContentFile } = require('../lib/trusted-content-file');

test('stored content resolver preserves safe nested and compatible absolute paths', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stored-content-'));
  const nested = path.join(root, 'nested', 'asset.png');
  fs.mkdirSync(path.dirname(nested));
  fs.writeFileSync(nested, 'asset');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  assert.equal(resolveStoredContentFile(root, path.join('nested', 'asset.png')), fs.realpathSync(nested));
  assert.equal(resolveStoredContentFile(root, nested), fs.realpathSync(nested));
  assert.equal(resolveStoredContentFile(root, nested, { allowAbsolute: false }), null);
});

test('stored content resolver rejects traversal, URL, directory, and outside absolute paths', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stored-content-'));
  const outside = path.join(path.dirname(root), `${path.basename(root)}-outside.png`);
  fs.writeFileSync(outside, 'outside');
  fs.mkdirSync(path.join(root, 'directory'));
  t.after(() => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { force: true });
  });

  assert.equal(resolveStoredContentFile(root, '../outside.png'), null);
  assert.equal(resolveStoredContentFile(root, outside), null);
  assert.equal(resolveStoredContentFile(root, 'https://example.test/asset.png'), null);
  assert.equal(resolveStoredContentFile(root, 'directory'), null);
  assert.equal(resolveStoredContentFile(root, ''), null);
});

test('stored content resolver rejects symlink leaves and symlinked ancestor escapes', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stored-content-'));
  const outsideRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'stored-content-outside-'));
  const outside = path.join(outsideRoot, 'outside.png');
  fs.writeFileSync(outside, 'outside');
  t.after(() => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outsideRoot, { recursive: true, force: true });
  });

  try {
    fs.symlinkSync(outside, path.join(root, 'leaf.png'), 'file');
    fs.symlinkSync(outsideRoot, path.join(root, 'nested'), process.platform === 'win32' ? 'junction' : 'dir');
  } catch (error) {
    t.skip(`symlinks unavailable: ${error.code || error.message}`);
    return;
  }
  assert.equal(resolveStoredContentFile(root, 'leaf.png'), null);
  assert.equal(resolveStoredContentFile(root, path.join('nested', 'outside.png')), null);
});
