'use strict';

const LIVE_SOURCES_SCHEMA_MIGRATION_ID = 'live_sources_schema_v1';
const LIVE_SOURCES_PODIUM_GUEST_MIGRATION_ID = 'live_sources_podium_guest_v1';

const CANONICAL_SOURCES = [
  {
    id: 'anpviz',
    sourceType: 'camera',
    displayName: 'Anpviz Camera',
    streamPath: 'anpviz-main',
    playerPath: '/player/live-source.html?source=anpviz',
    visibilityPolicy: 'always',
  },
  {
    // The ZowieBox is a permanent installed source. Its former
    // guest-computer identity is migrated once, below, before this canonical
    // row is asserted.
    id: 'podium-computer',
    sourceType: 'guest_computer',
    displayName: 'Podium Computer',
    streamPath: 'podium-computer',
    playerPath: '/player/live-source.html?source=podium-computer',
    visibilityPolicy: 'always',
  },
  {
    // This is a separately published, transient wired laptop source. It must
    // never inherit a previous ZowieBox availability or signal state.
    id: 'guest-computer',
    sourceType: 'guest_computer',
    displayName: 'Guest Computer',
    streamPath: 'guest-computer',
    playerPath: '/player/live-source.html?source=guest-computer',
    visibilityPolicy: 'always',
  },
];

const CANONICAL_SOURCE_IDS = CANONICAL_SOURCES.map((source) => source.id);
const LEGACY_SOURCE_ID = 'guest-computer';
const PODIUM_SOURCE_ID = 'podium-computer';
// These are the only public application origins that historically stored
// absolute player URLs. The migration normalizes them to a local player path;
// it must never reinterpret an arbitrary upstream URL as a Media Control source.
const CANONICAL_PLAYER_ORIGINS = new Set([
  'https://media.mbfdhub.com',
  'https://media-control.mbfdhub.com',
]);

function tableHasColumn(db, tableName, columnName) {
  const table = db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?",
  ).get(tableName);
  if (!table) return false;
  return db.prepare(`PRAGMA table_info(${tableName})`)
    .all()
    .some((column) => column.name === columnName);
}

function parseCanonicalPlayerUrl(value) {
  if (typeof value !== 'string' || !value) return null;
  const rootRelative = value.startsWith('/') && !value.startsWith('//');
  if (!rootRelative && !/^https:\/\//i.test(value)) return null;
  let parsed;
  try {
    parsed = new URL(value, 'http://media-control.local');
  } catch {
    return null;
  }
  if (!rootRelative && (
    parsed.username
    || parsed.password
    || !CANONICAL_PLAYER_ORIGINS.has(parsed.origin)
  )) return null;
  return { parsed, rootRelative };
}

function decodeGridCells(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value)) return null;
  try {
    const cells = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
    return cells && typeof cells === 'object' && !Array.isArray(cells) ? cells : null;
  } catch {
    return null;
  }
}

function encodeGridCells(cells) {
  return Buffer.from(JSON.stringify(cells), 'utf8').toString('base64url');
}

// A saved Multiview wall is itself a durable /player/grid.html URL. Its cell
// URLs are base64url JSON, so rewrite only the explicit `u` fields after a
// successful parse. Malformed grids and non-player cell values remain intact.
function rewriteLegacyGridCells(value) {
  const cells = decodeGridCells(value);
  if (!cells) return value;
  let changed = false;
  for (const cell of Object.values(cells)) {
    if (!cell || typeof cell !== 'object' || Array.isArray(cell) || typeof cell.u !== 'string') continue;
    const rewritten = rewriteLegacyPlayerUrl(cell.u);
    if (rewritten === cell.u) continue;
    cell.u = rewritten;
    changed = true;
  }
  return changed ? encodeGridCells(cells) : value;
}

// Rewrite only the canonical embedded-player identity. This deliberately does
// not perform a global text replacement: historical audit/event details remain
// evidence of the old label, and unrelated URLs cannot be repurposed.
function rewriteLegacyPlayerUrl(value) {
  const playerUrl = parseCanonicalPlayerUrl(value);
  if (!playerUrl) return value;
  const { parsed } = playerUrl;
  if (parsed.pathname === '/player/live-source.html'
      && parsed.searchParams.get('source') === LEGACY_SOURCE_ID) {
    parsed.searchParams.set('source', PODIUM_SOURCE_ID);
    return `${parsed.pathname}${parsed.search}${parsed.hash}`;
  }
  if (parsed.pathname !== '/player/grid.html') return value;
  const cells = parsed.searchParams.get('cells');
  const rewrittenCells = rewriteLegacyGridCells(cells);
  if (rewrittenCells === cells) return value;
  parsed.searchParams.set('cells', rewrittenCells);
  return `${parsed.pathname}${parsed.search}${parsed.hash}`;
}

function rewriteSnapshotValue(value) {
  if (Array.isArray(value)) {
    let changed = false;
    const rewritten = value.map((entry) => {
      const result = rewriteSnapshotValue(entry);
      changed ||= result.changed;
      return result.value;
    });
    return { value: rewritten, changed };
  }
  if (!value || typeof value !== 'object') return { value, changed: false };

  let changed = false;
  const rewritten = {};
  for (const [key, nestedValue] of Object.entries(value)) {
    if (key === 'live_source_id' && nestedValue === LEGACY_SOURCE_ID) {
      rewritten[key] = PODIUM_SOURCE_ID;
      changed = true;
      continue;
    }
    if (['remote_url', 'player_url', 'url'].includes(key) && typeof nestedValue === 'string') {
      const nextUrl = rewriteLegacyPlayerUrl(nestedValue);
      rewritten[key] = nextUrl;
      changed ||= nextUrl !== nestedValue;
      continue;
    }
    const result = rewriteSnapshotValue(nestedValue);
    rewritten[key] = result.value;
    changed ||= result.changed;
  }
  return { value: rewritten, changed };
}

function rewriteLegacyReferences(db) {
  for (const [tableName, columnName] of [
    ['content', 'remote_url'],
    ['activity_asset_placements', 'remote_url'],
  ]) {
    if (!tableHasColumn(db, tableName, columnName)) continue;
    const rows = db.prepare(`SELECT rowid, ${columnName} FROM ${tableName} WHERE ${columnName} IS NOT NULL`).all();
    const update = db.prepare(`UPDATE ${tableName} SET ${columnName} = ? WHERE rowid = ?`);
    for (const row of rows) {
      const rewritten = rewriteLegacyPlayerUrl(row[columnName]);
      if (rewritten !== row[columnName]) update.run(rewritten, row.rowid);
    }
  }

  if (tableHasColumn(db, 'playlists', 'published_snapshot')) {
    const rows = db.prepare(
      'SELECT rowid, published_snapshot FROM playlists WHERE published_snapshot IS NOT NULL',
    ).all();
    const update = db.prepare('UPDATE playlists SET published_snapshot = ? WHERE rowid = ?');
    for (const row of rows) {
      try {
        const result = rewriteSnapshotValue(JSON.parse(row.published_snapshot));
        if (result.changed) update.run(JSON.stringify(result.value), row.rowid);
      } catch {
        // A malformed historical snapshot is preserved verbatim; this migration
        // must not turn a recoverable record into an unrecoverable one.
      }
    }
  }

  // Canvas scenes are re-emitted after the P3 reconnects. Rewrite their two
  // persisted descriptors while the legacy topology is still unambiguous, so
  // an old Zowie URL cannot be replayed as the new Guest Computer source.
  // Parse each field independently: one malformed historical descriptor must
  // not prevent the valid companion descriptor from being migrated.
  if (!tableHasColumn(db, 'advanced_canvas_layers', 'source_json')
      || !tableHasColumn(db, 'advanced_canvas_layers', 'render_json')) return;
  const canvasRows = db.prepare(`
    SELECT rowid, source_json, render_json
    FROM advanced_canvas_layers
  `).all();
  const updateCanvas = db.prepare(`
    UPDATE advanced_canvas_layers
    SET source_json = ?, render_json = ?
    WHERE rowid = ?
  `);
  for (const row of canvasRows) {
    let sourceJson = row.source_json;
    let renderJson = row.render_json;
    let changed = false;
    for (const [field, current] of [
      ['source_json', row.source_json],
      ['render_json', row.render_json],
    ]) {
      try {
        const result = rewriteSnapshotValue(JSON.parse(current));
        if (!result.changed) continue;
        if (field === 'source_json') sourceJson = JSON.stringify(result.value);
        else renderJson = JSON.stringify(result.value);
        changed = true;
      } catch {
        // Preserve malformed historical canvas JSON verbatim. The normal
        // canvas loader already surfaces malformed descriptors safely.
      }
    }
    if (changed) updateCanvas.run(sourceJson, renderJson, row.rowid);
  }
}

function migrateLegacyGuestComputerToPodium(db) {
  const alreadyMigrated = db.prepare(
    'SELECT 1 FROM schema_migrations WHERE id = ?',
  ).get(LIVE_SOURCES_PODIUM_GUEST_MIGRATION_ID);
  if (alreadyMigrated) return;

  const legacy = db.prepare('SELECT 1 FROM live_sources WHERE id = ?').get(LEGACY_SOURCE_ID);
  const podium = db.prepare('SELECT 1 FROM live_sources WHERE id = ?').get(PODIUM_SOURCE_ID);
  if (legacy && podium) {
    throw new Error(
      'live source topology is ambiguous: both legacy guest-computer and podium-computer exist before migration',
    );
  }
  if (podium && !legacy) {
    throw new Error(
      'live source topology is ambiguous: podium-computer exists before migration but legacy guest-computer does not',
    );
  }
  if (legacy) {
    db.prepare('UPDATE live_sources SET id = ? WHERE id = ?').run(PODIUM_SOURCE_ID, LEGACY_SOURCE_ID);
    rewriteLegacyReferences(db);
  }
  db.prepare('INSERT OR IGNORE INTO schema_migrations (id) VALUES (?)')
    .run(LIVE_SOURCES_PODIUM_GUEST_MIGRATION_ID);
}

function migrateLiveSourcesSchema(db) {
  if (!db || typeof db.prepare !== 'function') {
    throw new Error('live sources migration requires a SQLite database');
  }

  const migrate = db.transaction(() => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS live_sources (
        id                TEXT PRIMARY KEY,
        source_type       TEXT NOT NULL CHECK (source_type IN ('camera', 'guest_computer')),
        display_name      TEXT NOT NULL,
        stream_path       TEXT NOT NULL UNIQUE,
        player_path       TEXT NOT NULL,
        visibility_policy TEXT NOT NULL CHECK (visibility_policy IN ('always', 'signal')),
        enabled           INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
        availability      TEXT NOT NULL DEFAULT 'unknown'
          CHECK (availability IN ('unknown', 'available', 'unavailable', 'degraded')),
        signal_json       TEXT,
        last_seen_at      INTEGER,
        created_at        INTEGER NOT NULL DEFAULT (strftime('%s','now')),
        updated_at        INTEGER NOT NULL DEFAULT (strftime('%s','now'))
      );
      CREATE INDEX IF NOT EXISTS idx_live_sources_type
        ON live_sources(source_type, enabled);
    `);

    migrateLegacyGuestComputerToPodium(db);

    // A camera row represents physical camera hardware. The installation has
    // exactly one such device, so stale camera identities are removed
    // transactionally before the canonical row is asserted.
    db.prepare(`
      DELETE FROM live_sources
      WHERE source_type = 'camera' AND id <> 'anpviz'
    `).run();

    const upsert = db.prepare(`
      INSERT INTO live_sources (
        id, source_type, display_name, stream_path, player_path,
        visibility_policy, enabled
      ) VALUES (?, ?, ?, ?, ?, ?, 1)
      ON CONFLICT(id) DO UPDATE SET
        source_type = excluded.source_type,
        display_name = excluded.display_name,
        stream_path = excluded.stream_path,
        player_path = excluded.player_path,
        visibility_policy = excluded.visibility_policy,
        enabled = 1,
        updated_at = strftime('%s','now')
    `);
    for (const source of CANONICAL_SOURCES) {
      upsert.run(
        source.id,
        source.sourceType,
        source.displayName,
        source.streamPath,
        source.playerPath,
        source.visibilityPolicy,
      );
    }

    // No non-canonical source is allowed to persist in this installation.
    db.prepare(`
      DELETE FROM live_sources
      WHERE id NOT IN (${CANONICAL_SOURCE_IDS.map(() => '?').join(', ')})
    `).run(...CANONICAL_SOURCE_IDS);

    db.prepare(
      'INSERT OR IGNORE INTO schema_migrations (id) VALUES (?)',
    ).run(LIVE_SOURCES_SCHEMA_MIGRATION_ID);
  });

  migrate();
  return true;
}

module.exports = {
  CANONICAL_SOURCES,
  LIVE_SOURCES_SCHEMA_MIGRATION_ID,
  LIVE_SOURCES_PODIUM_GUEST_MIGRATION_ID,
  migrateLiveSourcesSchema,
  rewriteLegacyPlayerUrl,
};
