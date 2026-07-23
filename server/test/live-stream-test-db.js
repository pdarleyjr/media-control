'use strict';

// Isolates Media Control SQLite for Node test files that load server/db/database.
// Each test worker must own a unique DB_PATH BEFORE requiring config/database;
// otherwise parallel workers race on migrations against remote_display.db
// ("database is locked").

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function installIsolatedTestDatabase(label = 'live-stream') {
  const safeLabel = String(label || 'live-stream').replace(/[^a-zA-Z0-9._-]+/g, '-').slice(0, 48);
  const tempBase = process.env.KILO_TEMP || path.join(os.tmpdir(), 'mbfd-mc-tests');
  fs.mkdirSync(tempBase, { recursive: true });
  const dbDir = fs.mkdtempSync(path.join(tempBase, `${safeLabel}-`));
  const dbPath = path.join(dbDir, 'test.db');
  process.env.DB_PATH = dbPath;

  // Drop cached config so a later require sees DB_PATH. Database itself must not
  // have been required yet in this process.
  try {
    delete require.cache[require.resolve('../config')];
  } catch (_) {}

  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    try {
      const databaseModulePath = require.resolve('../db/database');
      const cached = require.cache[databaseModulePath];
      if (cached && cached.exports && cached.exports.db && typeof cached.exports.db.close === 'function') {
        try { cached.exports.db.close(); } catch (_) {}
      }
    } catch (_) {}
    try {
      fs.rmSync(dbDir, { recursive: true, force: true });
    } catch (_) {}
  };

  process.on('exit', cleanup);
  return { dbDir, dbPath, cleanup };
}

module.exports = {
  installIsolatedTestDatabase,
};
