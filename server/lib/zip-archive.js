'use strict';

const { ZipArchive } = require('archiver');

function createZipArchive(options = {}) {
  return new ZipArchive(options);
}

module.exports = { createZipArchive };
