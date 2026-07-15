'use strict';

const fs = require('fs');
const path = require('path');

const MODULE_NAME_RE = /^[A-Za-z0-9_-]+$/;

function commonModuleCandidates(moduleName, baseDir = __dirname) {
  if (!MODULE_NAME_RE.test(String(moduleName || ''))) {
    throw new TypeError('invalid appliance common module name');
  }
  return [
    path.resolve(baseDir, '../../common', `${moduleName}.js`),
    path.resolve(baseDir, '../common', `${moduleName}.js`),
  ];
}

function resolveCommonModulePath(moduleName, options = {}) {
  const candidates = commonModuleCandidates(moduleName, options.baseDir || __dirname);
  const existsSync = options.existsSync || fs.existsSync;
  const resolved = candidates.find((candidate) => existsSync(candidate));
  if (resolved) return resolved;

  const error = new Error(`Unable to locate appliance common module ${moduleName}; checked ${candidates.join(', ')}`);
  error.code = 'MODULE_NOT_FOUND';
  throw error;
}

function loadCommonModule(moduleName, options = {}) {
  return require(resolveCommonModulePath(moduleName, options));
}

module.exports = { commonModuleCandidates, loadCommonModule, resolveCommonModulePath };
