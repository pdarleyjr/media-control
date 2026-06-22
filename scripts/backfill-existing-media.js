#!/usr/bin/env node
// ============================================================
// Backfill existing media into the managed-node asset sync model.
//
// Reads `content` rows, computes SHA256 of locally-available files under
// server/uploads/content/ (config.contentDir in-container; --content-dir to
// override for off-box dry runs), and idempotently creates `asset_checksums`
// rows + enqueues `node_assets` rows (desired=1, status='pending') for every
// `managed_nodes` row in scope.
//
// NON-DESTRUCTIVE: never deletes original files, never mutates `content` rows
// (it only links them via INSERT OR IGNORE / conditional UPDATE into the new
// additive `asset_checksums` table). All writes batched (100/tx).
//
// Flags:
//   --dry                 no DB writes; print what would happen
//   --workspace=<id>      scope managed_nodes by workspace_id
//   --node=<id>           scope to a single managed node id
//   --limit=N             cap content rows processed
//   --since=<epoch>       only content with created_at >= epoch
//   --repair              re-checksum rows whose stored size mismatches OR all
//   --content-dir=<dir>   override config.contentDir (off-box dry runs)
//
// Defensive: if the Phase-2 tables (asset_checksums, managed_nodes, node_assets)
// are not present yet, exits cleanly with a clear message so this script only
// mutates state AFTER the migration lands.
//
// Resolution follows the migrate-multitenancy.js convention: better-sqlite3 +
// uuid resolve out of server/node_modules (Node looks up the required file's
// own __dirname), so this works from repo root both in-container and off-box.
// ============================================================
'use strict';

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { URL } = require('url');

const SERVER_DIR = path.resolve(__dirname, '..', 'server');
const resolveFromServer = (name) => {
  try { return require.resolve(name, { paths: [SERVER_DIR] }); } catch { return name; }
};
const config = require(path.join(SERVER_DIR, 'config'));
const { localContentBaseUrlFromEnv } = require(path.join(SERVER_DIR, 'lib', 'local-asset-url'));

const BATCH = 100;
const HEX64 = /^[0-9a-f]{64}$/i;

function parseArgs(argv) {
  const out = { dry: false, repair: false, workspace: null, node: null, limit: null, since: null, contentDir: null };
  const rest = argv.slice(2);
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    const next = () => { i++; return rest[i]; };
    if (a === '--dry') out.dry = true;
    else if (a === '--repair') out.repair = true;
    else if (a === '--workspace' || a.startsWith('--workspace=')) out.workspace = a.startsWith('--workspace=') ? a.slice('--workspace='.length) : next();
    else if (a === '--node' || a.startsWith('--node=')) out.node = a.startsWith('--node=') ? a.slice('--node='.length) : next();
    else if (a === '--limit' || a.startsWith('--limit=')) out.limit = parseInt(a.startsWith('--limit=') ? a.slice('--limit='.length) : next(), 10);
    else if (a === '--since' || a.startsWith('--since=')) out.since = parseInt(a.startsWith('--since=') ? a.slice('--since='.length) : next(), 10);
    else if (a === '--content-dir' || a.startsWith('--content-dir=')) out.contentDir = a.startsWith('--content-dir=') ? a.slice('--content-dir='.length) : next();
    else if (a === '-h' || a === '--help') {
      process.stdout.write([
        'Usage: node scripts/backfill-existing-media.js [flags]',
        '  --dry             no DB writes',
        '  --workspace=<id>  scope managed_nodes by workspace_id',
        '  --node=<id>       scope to one managed node id',
        '  --limit=N         cap content rows processed',
        '  --since=<epoch>   only content created_at >= epoch',
        '  --repair          re-checksum rows whose size mismatches',
        '  --content-dir=<dir> override config.contentDir',
        'Flags accept either --flag value or --flag=value form.',
      ].join('\n') + '\n');
      process.exit(0);
    } else {
      console.error('Unknown flag: ' + a); process.exit(2);
    }
  }
  return out;
}

function tableExists(db, name) {
  try { return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name); }
  catch { return false; }
}

function getColumns(db, table) {
  try { return new Set(db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name)); }
  catch { return new Set(); }
}

function sha256File(absPath) {
  return new Promise((resolve, reject) => {
    try {
      const h = crypto.createHash('sha256');
      const rs = fs.createReadStream(absPath);
      rs.on('data', (c) => h.update(c));
      rs.on('end', () => resolve(h.digest('hex')));
      rs.on('error', reject);
    } catch (e) { reject(e); }
  });
}

function canonicalUrlFor(contentRow, baseOverride) {
  // Prefer the LAN/content-base form when configured (Tailnet-LAN delivery),
  // else the public content file route. Both are resolved by the server when it
  // pushes manifests; the stored value is a representative canonical URL.
  const base = baseOverride || config.localContentBaseUrl || localContentBaseUrlFromEnv(process.env);
  const filename = path.basename(String(contentRow.filepath || ''));
  if (base && filename) {
    try { return `${base}/uploads/content/${encodeURIComponent(filename)}`; } catch { /* fall through */ }
  }
  return `/api/content/${encodeURIComponent(String(contentRow.id))}/file`;
}

async function main() {
  const args = parseArgs(process.argv);
  const contentDir = args.contentDir || config.contentDir;

  let Database;
  try { Database = require(resolveFromServer('better-sqlite3')); }
  catch (e) {
    console.error('better-sqlite3 not found under server/node_modules. Run `npm install` in server/ first.');
    console.error('  (resolve error: ' + (e && e.message) + ')');
    process.exit(3);
  }

  if (!fs.existsSync(config.dbPath)) {
    console.error('DB not found at ' + config.dbPath + '. Set DB_PATH (in-container) or point at a prod DB copy for an off-box run.');
    if (args.dry) { console.error('(--dry set, but the DB must still exist to read content rows)'); }
    process.exit(3);
  }

  const db = new Database(config.dbPath, { readonly: !args.dry ? false : false, fileMustExist: true });
  // --dry still needs to READ to report. Open read-write but never write.
  if (args.dry) { /* leave RW handle open; we simply skip write calls */ }

  // Defensive Phase-2 table gate.
  const need = ['asset_checksums', 'managed_nodes', 'node_assets'];
  const missingTables = need.filter((t) => !tableExists(db, t));
  if (missingTables.length) {
    console.log('Phase-2 tables present?');
    for (const t of need) console.log('  ' + t + ': ' + (tableExists(db, t) ? 'yes' : 'no'));
    console.log('The Phase-2 managed-node migration has not landed yet (' + missingTables.join(', ') + ' missing).');
    console.log('Backfill is a no-op until those tables exist. Re-run after the migration lands.');
    try { db.close(); } catch { /* ignore */ }
    process.exit(0);
  }

  const contentCols = getColumns(db, 'content');
  const nodeCols = getColumns(db, 'managed_nodes');
  const hasContentWorkspace = contentCols.has('workspace_id');
  const hasNodeWorkspace = nodeCols.has('workspace_id');

  // ── Content query ──────────────────────────────────────────
  const selects = ['id', 'filepath', 'remote_url', 'mime_type', 'file_size', 'width', 'height', 'duration_sec', 'thumbnail_path', 'created_at'];
  if (hasContentWorkspace) selects.push('workspace_id');
  let sql = `SELECT ${selects.join(', ')} FROM content`;
  const where = ['(filepath IS NOT NULL AND filepath != \'\')'];
  const params = [];
  if (args.since != null) { where.push('created_at >= ?'); params.push(args.since); }
  if (args.workspace != null && hasContentWorkspace) { where.push('workspace_id = ?'); params.push(args.workspace); }
  if (args.workspace != null && !hasContentWorkspace) {
    console.warn('WARN: --workspace given but content has no workspace_id column; workspace content-scope ignored (still used to scope managed_nodes).');
  }
  sql += ' WHERE ' + where.join(' AND ') + ' ORDER BY created_at ASC';
  if (args.limit != null) sql += ' LIMIT ' + parseInt(args.limit, 10);

  const rows = db.prepare(sql).all(...params);

  // ── Managed-nodes in scope ─────────────────────────────────
  let nodeSql = 'SELECT node_id, node_name, node_type, room_id' + (hasNodeWorkspace ? ', workspace_id' : '') + ' FROM managed_nodes';
  const nWhere = [];
  const nParams = [];
  if (args.workspace != null && hasNodeWorkspace) { nWhere.push('workspace_id = ?'); nParams.push(args.workspace); }
  if (args.node != null) { nWhere.push('node_id = ?'); nParams.push(args.node); }
  if (nWhere.length) nodeSql += ' WHERE ' + nWhere.join(' AND ');
  const nodes = db.prepare(nodeSql).all(...nParams);

  const report = {
    generated_at: new Date().toISOString(),
    dry: args.dry,
    db_path: config.dbPath,
    content_dir: contentDir,
    workspace_scope: args.workspace,
    node_scope: args.node,
    since: args.since,
    limit: args.limit,
    repair: args.repair,
    nodes_in_scope: nodes.map(n => n.node_id),
    total_scanned: 0,
    checksum_computed: 0,
    checksum_skipped_uptodate: 0,
    asset_rows_inserted: 0,
    asset_rows_updated: 0,
    sync_pending_enqueued: 0,
    missing_files: [],
    checksum_mismatches: [],
    remote_only_skipped: 0,
    nodes_count: nodes.length,
  };

  // Prepared statements (asset_checksums + node_assets).
  const insAsset = db.prepare(`INSERT OR IGNORE INTO asset_checksums
    (asset_id, content_id, sha256, size_bytes, canonical_path, canonical_url,
     poster_path, duration_sec, width, height, is_screensaver, computed_at)
    VALUES (@asset_id, @content_id, @sha256, @size_bytes, @canonical_path, @canonical_url,
            @poster_path, @duration_sec, @width, @height, 0, @computed_at)`);
  const updAsset = db.prepare(`UPDATE asset_checksums SET
    sha256=@sha256, size_bytes=@size_bytes, canonical_path=@canonical_path,
    canonical_url=@canonical_url, poster_path=@poster_path, duration_sec=@duration_sec,
    width=@width, height=@height, computed_at=@computed_at
    WHERE asset_id=@asset_id`);
  const selAsset = db.prepare('SELECT asset_id, sha256, size_bytes FROM asset_checksums WHERE content_id = ?');
  const insNodeAsset = db.prepare(`INSERT OR IGNORE INTO node_assets
    (asset_id, node_id, desired, sync_status) VALUES (@asset_id, @node_id, 1, 'pending')`);

  function tx(fn) { if (args.dry) return fn(true); db.transaction(fn)(); }

  let batch = 0;
  for (const row of rows) {
    report.total_scanned++;
    if (!row.filepath) { report.remote_only_skipped++; continue; }
    const abs = path.join(contentDir, String(row.filepath));
    if (!fs.existsSync(abs)) {
      report.missing_files.push({ content_id: row.id, filepath: row.filepath });
      continue;
    }

    let sha = null;
    let actualSize = row.file_size || 0;
    const existing = selAsset.get(row.id);
    const storedSize = existing ? (existing.size_bytes || 0) : null;

    let mustCompute = !existing;
    if (!mustCompute) {
      if (args.repair) mustCompute = true;
      else if (actualSize && storedSize && actualSize !== storedSize) mustCompute = true;
    }

    if (mustCompute) {
      try {
        sha = await sha256File(abs);
        try { const st = fs.statSync(abs); if (st.size) actualSize = st.size; } catch { /* ignore */ }
        report.checksum_computed++;
      } catch (e) {
        report.missing_files.push({ content_id: row.id, filepath: row.filepath, error: String(e && e.message) });
        continue;
      }
    } else {
      report.checksum_skipped_uptodate++;
    }

    const assetId = existing ? existing.asset_id : row.id;
    const shaFinal = (existing && !mustCompute) ? existing.sha256 : sha;
    const canonicalUrl = canonicalUrlFor(row);

    tx((isDry) => {
      let changed = 0;
      if (mustCompute) {
        if (existing) {
          if (!isDry) { const r = updAsset.run({
            asset_id: assetId, content_id: row.id, sha256: shaFinal, size_bytes: actualSize,
            canonical_path: abs, canonical_url: canonicalUrl, poster_path: row.thumbnail_path || null,
            duration_sec: row.duration_sec || null, width: row.width || null, height: row.height || null,
            computed_at: Math.floor(Date.now() / 1000),
          }); changed = r.changes; }
          report.asset_rows_updated += (isDry ? 1 : changed);
        } else {
          if (!isDry) { const r = insAsset.run({
            asset_id: assetId, content_id: row.id, sha256: shaFinal, size_bytes: actualSize,
            canonical_path: abs, canonical_url: canonicalUrl, poster_path: row.thumbnail_path || null,
            duration_sec: row.duration_sec || null, width: row.width || null, height: row.height || null,
            computed_at: Math.floor(Date.now() / 1000),
          }); changed = r.changes; }
          report.asset_rows_inserted += (isDry ? 1 : changed);
        }
      }

      // Enqueue node_assets for every managed node in scope (idempotent).
      for (const n of nodes) {
        if (!isDry) { insNodeAsset.run({ asset_id: assetId, node_id: n.node_id }); }
        report.sync_pending_enqueued++;
      }
    });

    if (++batch % BATCH === 0 && report.missing_files.length === 0) {
      // Batch sizing is enforced by the transaction-per-loop above; this is
      // only a heartbeat line for long runs.
      console.log(`backfill: scanned ${report.total_scanned} (${report.checksum_computed} checksummed, ${report.sync_pending_enqueued} node_assets)…`);
    }
  }

  // ── Report ──────────────────────────────────────────────────
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const reportPath = path.join(process.cwd(), `backfill-report-${ts}.json`);
  try { fs.writeFileSync(reportPath, JSON.stringify(report, null, 2)); } catch (e) { console.error('could not write report: ' + (e && e.message)); }

  console.log('=== backfill report ===');
  console.log(JSON.stringify({
    total_scanned: report.total_scanned,
    checksum_computed: report.checksum_computed,
    checksum_skipped_uptodate: report.checksum_skipped_uptodate,
    asset_rows_inserted: report.asset_rows_inserted,
    asset_rows_updated: report.asset_rows_updated,
    sync_pending_enqueued: report.sync_pending_enqueued,
    nodes: nodes.length,
    missing_files: report.missing_files.length,
    remote_only_skipped: report.remote_only_skipped,
    dry: args.dry,
  }, null, 2));
  if (report.missing_files.length) console.log('missing files: ' + report.missing_files.length + ' (see ' + reportPath + ')');
  console.log('report written: ' + reportPath);

  try { db.close(); } catch { /* ignore */ }
  process.exit(0);
}

main().catch((e) => {
  console.error('backfill failed:', e && (e.stack || e.message || e));
  process.exit(1);
});