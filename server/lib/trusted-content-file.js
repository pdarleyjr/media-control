'use strict';

const fs = require('node:fs');
const path = require('node:path');

function isInsideRoot(root, candidate) {
  const relative = path.relative(root, candidate);
  return Boolean(relative) && !relative.startsWith('..') && !path.isAbsolute(relative);
}

function resolveStoredContentFile(contentDir, storedPath, { allowAbsolute = true } = {}) {
  if (typeof storedPath !== 'string') return null;
  const value = storedPath.trim();
  if (!value || /^[a-z][a-z0-9+.-]*:\/\//i.test(value)) return null;

  try {
    const root = fs.realpathSync(path.resolve(contentDir));
    if (path.isAbsolute(value) && !allowAbsolute) return null;
    const candidate = path.isAbsolute(value) ? path.resolve(value) : path.resolve(root, value);
    if (!isInsideRoot(root, candidate)) return null;

    const stat = fs.lstatSync(candidate);
    if (stat.isSymbolicLink() || !stat.isFile()) return null;
    const realPath = fs.realpathSync(candidate);
    if (!isInsideRoot(root, realPath)) return null;
    return realPath;
  } catch {
    return null;
  }
}

module.exports = { resolveStoredContentFile };
