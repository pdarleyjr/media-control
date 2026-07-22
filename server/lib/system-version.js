'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { CONTRACT_VERSION } = require('../player/device-contract');
const STARTED_AT = new Date().toISOString();

function fileText(filePath, fallback = '') {
  try { return fs.readFileSync(filePath, 'utf8').trim(); } catch { return fallback; }
}

function gitValue(args, cwd) {
  try { return execFileSync('git', args, { cwd, timeout: 1500, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); }
  catch { return ''; }
}

function buildSystemVersion(options = {}) {
  const env = options.env || process.env;
  const repoRoot = path.join(__dirname, '..', '..');
  const db = options.db;
  let databaseSchema = { count: 0, latest: null };
  try {
    const row = db.prepare(`
      SELECT COUNT(*) AS count,
        (SELECT id FROM schema_migrations ORDER BY rowid DESC LIMIT 1) AS latest
      FROM schema_migrations
    `).get();
    databaseSchema = { count: Number(row?.count) || 0, latest: row?.latest || null };
  } catch (_) {}

  const gitCommit = env.GIT_COMMIT || env.COMMIT_SHA || gitValue(['rev-parse', 'HEAD'], repoRoot) || 'unknown';
  const gitTree = env.GIT_TREE || gitValue(['rev-parse', 'HEAD^{tree}'], repoRoot) || 'unknown';

  return {
    api_version: fileText(path.join(repoRoot, 'VERSION'), '0.0.0'),
    version: fileText(path.join(repoRoot, 'VERSION'), '0.0.0'),
    git_commit: gitCommit,
    git_tree: gitTree,
    branch: env.GIT_BRANCH || gitValue(['rev-parse', '--abbrev-ref', 'HEAD'], repoRoot) || 'unknown',
    build_id: env.BUILD_ID || env.BUILD_TIMESTAMP || env.BUILD_TIME || 'unknown',
    build_timestamp: env.BUILD_TIMESTAMP || env.BUILD_TIME || (env.SERVER_STARTED_AT
      ? new Date(Number(env.SERVER_STARTED_AT)).toISOString()
      : STARTED_AT),
    image_digest: env.IMAGE_DIGEST || env.IMAGE_ID || 'unknown',
    image_tag: env.IMAGE_TAG || 'unknown',
    frontend_bundle_hash: options.frontendHash || 'unknown',
    // Back-compat: clients historically poll /api/version.hash as the frontend MIME/bundle soft-reload trigger.
    hash: options.frontendHash || 'unknown',
    player_bundle_hash: options.playerHash || 'unknown',
    player_hash: options.playerHash || 'unknown',
    command_contract_version: CONTRACT_VERSION,
    contract_version: CONTRACT_VERSION,
    database_schema: databaseSchema,
    runtime: {
      node: process.version,
      platform: process.platform,
      container_or_host: os.hostname(),
    },
  };
}

module.exports = { buildSystemVersion };
