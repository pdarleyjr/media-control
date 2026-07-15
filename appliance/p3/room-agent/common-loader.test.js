const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { resolveCommonModulePath } = require('./common-loader');

function touch(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, 'module.exports = {};\n');
}

test('common module resolver supports the repository appliance layout', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mbfd-common-repo-'));
  try {
    const baseDir = path.join(root, 'appliance', 'p3', 'room-agent');
    const expected = path.join(root, 'appliance', 'common', 'server-url.js');
    touch(expected);
    assert.equal(resolveCommonModulePath('server-url', { baseDir }), expected);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('common module resolver supports the flattened Windows appliance layout', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mbfd-common-flat-'));
  try {
    const baseDir = path.join(root, 'MBFD', 'RoomAgent');
    const expected = path.join(root, 'MBFD', 'common', 'network-state.js');
    touch(expected);
    assert.equal(resolveCommonModulePath('network-state', { baseDir }), expected);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('common module resolver rejects traversal and reports missing dependencies', () => {
  assert.throws(() => resolveCommonModulePath('../secret'), /invalid appliance common module name/);
  assert.throws(
    () => resolveCommonModulePath('server-url', { baseDir: path.join(os.tmpdir(), 'missing-mbfd-layout') }),
    (error) => error && error.code === 'MODULE_NOT_FOUND',
  );
});
