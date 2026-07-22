#!/usr/bin/env node

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');
const {
  analyzeTopology,
  applyTopologyRepair,
  rollbackTopologyRepair,
  snapshotHash,
  snapshotTopology,
} = require('../lib/topology-repair');

function parseArgs(argv) {
  const args = { apply: false };
  const safeIdentifier = /^[A-Za-z0-9._-]{1,128}$/;
  const valueFor = (option, index) => {
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`${option} requires a value`);
    return value;
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--apply') args.apply = true;
    else if (arg === '--db') args.dbPath = valueFor(arg, index++);
    else if (arg === '--plan') args.planPath = valueFor(arg, index++);
    else if (arg === '--backup-dir') args.backupDir = valueFor(arg, index++);
    else if (arg === '--actor') args.actor = valueFor(arg, index++);
    else if (arg === '--run-id') args.runId = valueFor(arg, index++);
    else if (arg === '--rollback') args.rollbackRunId = valueFor(arg, index++);
    else if (arg === '--help' || arg === '-h') args.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (args.apply && args.rollbackRunId) throw new Error('--apply and --rollback cannot be used together');
  for (const [option, value] of [['--run-id', args.runId], ['--rollback', args.rollbackRunId]]) {
    if (value && !safeIdentifier.test(value)) throw new Error(`${option} must be a safe identifier using letters, numbers, dot, underscore, or hyphen`);
  }
  return args;
}

function usage() {
  return `Usage:
  node scripts/repair-display-topology.js --db <database>                     # dry-run report
  node scripts/repair-display-topology.js --db <database> --plan <plan.json> --apply \\
    --backup-dir <durable-directory> --actor <name>
  node scripts/repair-display-topology.js --db <database> --rollback <run-id> \\
    --backup-dir <durable-directory> --actor <name>

Apply and rollback always create and verify a SQLite backup before mutation.
No implicit orphan mapping, deletion, membership precedence, screen-state, grid,
workspace, leader, or stored-layout decision is permitted. Copy the
snapshotHash from the dry-run output into plan.expectedSnapshotHash.`;
}

function sha256(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

async function createVerifiedBackup(db, sourcePath, backupDir, label) {
  if (!backupDir) throw new Error('--backup-dir is required for apply or rollback');
  if (!/^[A-Za-z0-9._-]{1,160}$/.test(label)) throw new Error('Backup label is not a safe path identifier');
  const resolvedBackupDir = path.resolve(backupDir);
  fs.mkdirSync(resolvedBackupDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = path.join(resolvedBackupDir, `${path.basename(sourcePath)}.${label}.${stamp}.db`);
  if (path.dirname(path.resolve(backupPath)) !== resolvedBackupDir) throw new Error('Backup path escaped the requested directory');
  await db.backup(backupPath);
  const verify = new Database(backupPath, { readonly: true, fileMustExist: true });
  const integrity = verify.pragma('integrity_check');
  const foreignKeys = verify.pragma('foreign_key_check');
  verify.close();
  if (integrity.length !== 1 || integrity[0].integrity_check !== 'ok') {
    throw new Error(`Backup integrity_check failed: ${JSON.stringify(integrity)}`);
  }
  if (foreignKeys.length) {
    throw new Error(`Backup foreign_key_check failed: ${JSON.stringify(foreignKeys)}`);
  }
  const manifest = {
    schemaVersion: 1,
    sourcePath: path.resolve(sourcePath),
    backupPath: path.resolve(backupPath),
    sha256: sha256(backupPath),
    bytes: fs.statSync(backupPath).size,
    integrityCheck: 'ok',
    foreignKeyViolations: 0,
    createdAt: new Date().toISOString(),
  };
  fs.writeFileSync(`${backupPath}.manifest.json`, `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx' });
  return manifest;
}

async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  if (!args.dbPath) throw new Error('--db is required');
  if (!fs.existsSync(args.dbPath)) throw new Error(`Database does not exist: ${args.dbPath}`);

  const mutating = args.apply || !!args.rollbackRunId;
  const db = new Database(args.dbPath, { readonly: !mutating, fileMustExist: true, timeout: 10000 });
  try {
    db.pragma('busy_timeout = 10000');
    db.pragma('foreign_keys = ON');
    if (!mutating) {
      const report = analyzeTopology(db);
      process.stdout.write(`${JSON.stringify({
        mode: 'dry-run',
        snapshotHash: snapshotHash(snapshotTopology(db)),
        report,
      }, null, 2)}\n`);
      return;
    }
    if (!args.actor) throw new Error('--actor is required for apply or rollback');
    const backup = await createVerifiedBackup(
      db,
      args.dbPath,
      args.backupDir,
      args.rollbackRunId ? `pre-rollback-${args.rollbackRunId}` : 'pre-repair'
    );
    if (args.rollbackRunId) {
      const result = rollbackTopologyRepair(db, args.rollbackRunId, { actor: args.actor });
      process.stdout.write(`${JSON.stringify({ mode: 'rollback', backup, result }, null, 2)}\n`);
      return;
    }
    if (!args.planPath) throw new Error('--plan is required with --apply');
    const plan = JSON.parse(fs.readFileSync(args.planPath, 'utf8'));
    const result = applyTopologyRepair(db, plan, { actor: args.actor, runId: args.runId });
    process.stdout.write(`${JSON.stringify({ mode: 'apply', backup, result }, null, 2)}\n`);
  } finally {
    db.close();
  }
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`[topology-repair] ${error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = { createVerifiedBackup, main, parseArgs, sha256, usage };
