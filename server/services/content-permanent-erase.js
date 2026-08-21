const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const Multiview = require('../player/multiview-core');
const { migrateContentEraseLedger } = require('../db/migrations/content-erase-ledger');

// Every identifier in these statements is static source code. If a future
// migration adds a content foreign key, erase fails closed until its lifecycle
// is reviewed and added here; schema-derived names are never interpolated into
// SQL.
const CONTENT_FOREIGN_KEY_COUNTS = new Map([
  ['activity_asset_placements.content_id', 'SELECT COUNT(*) AS count FROM activity_asset_placements WHERE content_id = ?'],
  ['assignments.content_id', 'SELECT COUNT(*) AS count FROM assignments WHERE content_id = ?'],
  ['asset_checksums.content_id', 'SELECT COUNT(*) AS count FROM asset_checksums WHERE content_id = ?'],
  ['asset_variants.content_id', 'SELECT COUNT(*) AS count FROM asset_variants WHERE content_id = ?'],
  ['content.source_content_id', 'SELECT COUNT(*) AS count FROM content WHERE source_content_id = ?'],
  ['content_captions.content_id', 'SELECT COUNT(*) AS count FROM content_captions WHERE content_id = ?'],
  ['content_favorites.content_id', 'SELECT COUNT(*) AS count FROM content_favorites WHERE content_id = ?'],
  ['content_media_metadata.content_id', 'SELECT COUNT(*) AS count FROM content_media_metadata WHERE content_id = ?'],
  ['content_publication_requests.content_id', 'SELECT COUNT(*) AS count FROM content_publication_requests WHERE content_id = ?'],
  ['content_template_assignments.content_id', 'SELECT COUNT(*) AS count FROM content_template_assignments WHERE content_id = ?'],
  ['devices.default_content_id', 'SELECT COUNT(*) AS count FROM devices WHERE default_content_id = ?'],
  ['download_jobs.content_id', 'SELECT COUNT(*) AS count FROM download_jobs WHERE content_id = ?'],
  ['media_jobs.content_id', 'SELECT COUNT(*) AS count FROM media_jobs WHERE content_id = ?'],
  ['nextcloud_sync_jobs.content_id', 'SELECT COUNT(*) AS count FROM nextcloud_sync_jobs WHERE content_id = ?'],
  ['peertube_replays.content_id', 'SELECT COUNT(*) AS count FROM peertube_replays WHERE content_id = ?'],
  ['play_logs.content_id', 'SELECT COUNT(*) AS count FROM play_logs WHERE content_id = ?'],
  ['playlist_items.content_id', 'SELECT COUNT(*) AS count FROM playlist_items WHERE content_id = ?'],
  ['presentation_assets.content_id', 'SELECT COUNT(*) AS count FROM presentation_assets WHERE content_id = ?'],
  ['presentation_conversion_runs.source_content_id', 'SELECT COUNT(*) AS count FROM presentation_conversion_runs WHERE source_content_id = ?'],
  ['presentation_exports.content_id', 'SELECT COUNT(*) AS count FROM presentation_exports WHERE content_id = ?'],
  ['schedules.content_id', 'SELECT COUNT(*) AS count FROM schedules WHERE content_id = ?'],
  ['video_walls.content_id', 'SELECT COUNT(*) AS count FROM video_walls WHERE content_id = ?'],
]);

function tableExists(db, name) {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));
}

function rows(db, sql, ...params) {
  try { return db.prepare(sql).all(...params); } catch (error) {
    if (/no such table|no such column/i.test(error.message)) return [];
    throw error;
  }
}

function one(db, sql, ...params) {
  try { return db.prepare(sql).get(...params); } catch (error) {
    if (/no such table|no such column/i.test(error.message)) return undefined;
    throw error;
  }
}

function run(db, sql, ...params) {
  try { return db.prepare(sql).run(...params); } catch (error) {
    if (/no such table|no such column/i.test(error.message)) return { changes: 0 };
    throw error;
  }
}

function contentUrlMatches(value, contentId) {
  if (typeof value !== 'string') return false;
  if (value === contentId) return true;
  return new RegExp(`(?:^|/)api/content/${contentId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:/|$|[?#])`).test(value);
}

function jsonReferences(value, contentId) {
  if (contentUrlMatches(value, contentId)) return true;
  if (Array.isArray(value)) return value.some((entry) => jsonReferences(entry, contentId));
  if (value && typeof value === 'object') {
    return Object.entries(value).some(([key, entry]) => (
      (key === 'content_id' || key === 'contentId') && String(entry) === contentId
    ) || jsonReferences(entry, contentId));
  }
  return false;
}

function scrubJson(value, contentId) {
  if (contentUrlMatches(value, contentId)) return { value: null, changed: true };
  if (Array.isArray(value)) {
    let changed = false;
    const next = [];
    for (const entry of value) {
      const scrubbed = scrubJson(entry, contentId);
      changed = changed || scrubbed.changed;
      if (scrubbed.value !== null && scrubbed.value !== undefined) next.push(scrubbed.value);
    }
    return { value: next, changed };
  }
  if (value && typeof value === 'object') {
    if (String(value.content_id || value.contentId || '') === contentId) {
      const next = {};
      for (const [key, entry] of Object.entries(value)) {
        if (key === 'content_id' || key === 'contentId') continue;
        const scrubbed = scrubJson(entry, contentId);
        if (scrubbed.value !== null && scrubbed.value !== undefined) next[key] = scrubbed.value;
      }
      next.media_status = 'permanently_erased';
      next.erased_content_id = contentId;
      return { value: next, changed: true };
    }
    let changed = false;
    const next = {};
    for (const [key, entry] of Object.entries(value)) {
      if ((key === 'content_id' || key === 'contentId') && String(entry) === contentId) {
        changed = true;
        continue;
      }
      const scrubbed = scrubJson(entry, contentId);
      changed = changed || scrubbed.changed;
      if (scrubbed.value !== null && scrubbed.value !== undefined) next[key] = scrubbed.value;
    }
    return { value: next, changed };
  }
  return { value, changed: false };
}

function parseJson(raw, fallback = null) {
  try { return JSON.parse(raw); } catch { return fallback; }
}

function gridReference(grid, contentId) {
  try {
    const url = new URL(grid.remote_url, 'http://media-control.local');
    const cells = Multiview.decodeCells(url.searchParams.get('cells'));
    return Object.values(cells).some((cell) => contentUrlMatches(cell.u, contentId));
  } catch { return false; }
}

function rewriteGridUrl(remoteUrl, contentId) {
  const url = new URL(remoteUrl, 'http://media-control.local');
  const cells = Multiview.decodeCells(url.searchParams.get('cells'));
  let changed = false;
  for (const [slotId, cell] of Object.entries(cells)) {
    if (contentUrlMatches(cell.u, contentId)) {
      delete cells[slotId];
      changed = true;
    }
  }
  if (!changed) return null;
  url.searchParams.set('cells', Multiview.encodeCells(cells));
  return remoteUrl.startsWith('/') ? `${url.pathname}${url.search}${url.hash}` : url.toString();
}

function foreignKeyImpact(db, contentId) {
  const impact = [];
  const tables = rows(db, "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'");
  for (const { name } of tables) {
    for (const fk of rows(db, 'SELECT * FROM pragma_foreign_key_list(?)', name)) {
      if (fk.table !== 'content') continue;
      const countSql = CONTENT_FOREIGN_KEY_COUNTS.get(`${name}.${fk.from}`);
      const count = countSql ? Number(one(db, countSql, contentId)?.count || 0) : null;
      if (countSql && !count) continue;
      const action = String(fk.on_delete || 'NO ACTION').toUpperCase();
      impact.push({ table: name, column: fk.from, action, count, handled: Boolean(countSql) });
    }
  }
  return impact;
}

const FILE_SIDECAR_SUFFIXES = [
  '', '.part', '.meta', '.previous',
  '.meta.part', '.meta.previous',
  '.part.meta', '.previous.meta',
];

function resolveStoredFiles(values, contentDir) {
  const candidates = new Set();
  const root = path.resolve(contentDir);
  for (const value of values.filter(Boolean)) {
    if (/^https?:\/\//i.test(String(value))) continue;
    const candidate = path.isAbsolute(String(value))
      ? path.resolve(String(value))
      : path.resolve(root, String(value));
    if (candidate !== root && !candidate.startsWith(`${root}${path.sep}`)) continue;
    for (const suffix of FILE_SIDECAR_SUFFIXES) candidates.add(`${candidate}${suffix}`);
  }
  return candidates;
}

function contentFileValues(db, content) {
  return [
    content.filepath,
    content.original_filepath,
    content.thumbnail_path,
    ...rows(db, 'SELECT file_path FROM asset_variants WHERE content_id = ?', content.id).map((row) => row.file_path),
    ...rows(db, 'SELECT canonical_path, poster_path FROM asset_checksums WHERE content_id = ?', content.id)
      .flatMap((row) => [row.canonical_path, row.poster_path]),
    ...rows(db, 'SELECT thumbnail_source_filepath FROM content_media_metadata WHERE content_id = ?', content.id)
      .map((row) => row.thumbnail_source_filepath),
    ...rows(db, 'SELECT local_path FROM download_jobs WHERE content_id = ?', content.id).map((row) => row.local_path),
    ...rows(db, 'SELECT file_path FROM media_job_artifacts WHERE content_id = ?', content.id).map((row) => row.file_path),
  ];
}

function otherContentFileValues(db, contentId) {
  return [
    ...rows(db, 'SELECT filepath, original_filepath, thumbnail_path FROM content WHERE id <> ?', contentId)
      .flatMap((row) => [row.filepath, row.original_filepath, row.thumbnail_path]),
    ...rows(db, 'SELECT file_path FROM asset_variants WHERE content_id IS NULL OR content_id <> ?', contentId).map((row) => row.file_path),
    ...rows(db, 'SELECT canonical_path, poster_path FROM asset_checksums WHERE content_id IS NULL OR content_id <> ?', contentId)
      .flatMap((row) => [row.canonical_path, row.poster_path]),
    ...rows(db, 'SELECT thumbnail_source_filepath FROM content_media_metadata WHERE content_id <> ?', contentId)
      .map((row) => row.thumbnail_source_filepath),
    ...rows(db, 'SELECT local_path FROM download_jobs WHERE content_id IS NULL OR content_id <> ?', contentId)
      .map((row) => row.local_path),
    ...rows(db, 'SELECT file_path FROM media_job_artifacts WHERE content_id <> ?', contentId)
      .map((row) => row.file_path),
  ];
}

function classifyLocalFiles(db, content, contentDir) {
  const root = path.resolve(contentDir);
  const realRoot = fs.realpathSync(root);
  const candidates = resolveStoredFiles(contentFileValues(db, content), contentDir);
  const otherFiles = resolveStoredFiles(otherContentFileValues(db, content.id), contentDir);
  const shared = new Set([...candidates].filter((candidate) => otherFiles.has(candidate)));
  const otherIdentities = new Set();
  for (const candidate of otherFiles) {
    try {
      const stat = fs.lstatSync(candidate);
      const real = fs.realpathSync(candidate);
      const relative = path.relative(realRoot, real);
      const contained = relative && !relative.startsWith('..') && !path.isAbsolute(relative);
      if (contained && stat.isFile() && !stat.isSymbolicLink()) otherIdentities.add(`${stat.dev}:${stat.ino}`);
    } catch { /* absent sidecar */ }
  }
  const blocked_files = [];
  for (const candidate of candidates) {
    if (shared.has(candidate)) continue;
    try {
      const stat = fs.lstatSync(candidate);
      if (stat.isSymbolicLink() || !stat.isFile()) {
        blocked_files.push({ type: 'unsafe_file', path: candidate, reason: stat.isSymbolicLink() ? 'symbolic_link' : 'not_regular_file' });
        continue;
      }
      const real = fs.realpathSync(candidate);
      const relative = path.relative(realRoot, real);
      if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
        blocked_files.push({ type: 'unsafe_file', path: candidate, reason: 'resolved_outside_content_root' });
        continue;
      }
      if (otherIdentities.has(`${stat.dev}:${stat.ino}`)) shared.add(candidate);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  return {
    files: [...candidates].filter((candidate) => !shared.has(candidate)
      && !blocked_files.some((blocked) => blocked.path === candidate)),
    shared_files: [...candidates].filter((candidate) => shared.has(candidate)),
    blocked_files,
  };
}

function collectLocalFiles(db, content, contentDir) {
  return classifyLocalFiles(db, content, contentDir).files;
}

function deviceIdsUsingContent(db, contentId) {
  return [
    ...rows(db, 'SELECT device_id FROM assignments WHERE content_id=?', contentId).map((row) => row.device_id),
    ...rows(db, 'SELECT id AS device_id FROM devices WHERE default_content_id=?', contentId).map((row) => row.device_id),
    ...rows(db, `SELECT DISTINCT d.id AS device_id
      FROM devices d JOIN playlists p ON d.playlist_id=p.id
      JOIN playlist_items pi ON pi.playlist_id=p.id WHERE pi.content_id=?`, contentId).map((row) => row.device_id),
    ...rows(db, `SELECT DISTINCT vwd.device_id FROM video_walls vw
      JOIN video_wall_devices vwd ON vwd.wall_id=vw.id WHERE vw.content_id=?`, contentId).map((row) => row.device_id),
    ...rows(db, 'SELECT DISTINCT device_id FROM schedules WHERE content_id=? AND device_id IS NOT NULL', contentId).map((row) => row.device_id),
    ...rows(db, `SELECT DISTINCT dgm.device_id FROM schedules s
      JOIN device_group_members dgm ON dgm.group_id=s.group_id WHERE s.content_id=?`, contentId).map((row) => row.device_id),
    ...rows(db, `SELECT DISTINCT dgm.device_id FROM playlist_items pi
      JOIN device_groups dg ON dg.playlist_id=pi.playlist_id
      JOIN device_group_members dgm ON dgm.group_id=dg.id WHERE pi.content_id=?`, contentId).map((row) => row.device_id),
    ...rows(db, `SELECT DISTINCT vwd.device_id FROM playlist_items pi
      JOIN video_walls vw ON vw.playlist_id=pi.playlist_id
      JOIN video_wall_devices vwd ON vwd.wall_id=vw.id WHERE pi.content_id=?`, contentId).map((row) => row.device_id),
    ...rows(db, `SELECT DISTINCT s.device_id FROM schedules s
      JOIN playlist_items pi ON pi.playlist_id=s.playlist_id
      WHERE pi.content_id=? AND s.device_id IS NOT NULL`, contentId).map((row) => row.device_id),
    ...rows(db, `SELECT DISTINCT dgm.device_id FROM schedules s
      JOIN playlist_items pi ON pi.playlist_id=s.playlist_id
      JOIN device_group_members dgm ON dgm.group_id=s.group_id WHERE pi.content_id=?`, contentId).map((row) => row.device_id),
    ...rows(db, 'SELECT DISTINCT device_id FROM activity_asset_placements WHERE content_id=? AND device_id IS NOT NULL', contentId).map((row) => row.device_id),
    ...rows(db, `SELECT DISTINCT vwd.device_id FROM activity_asset_placements aap
      JOIN video_wall_devices vwd ON vwd.wall_id=aap.wall_id
      WHERE aap.content_id=? AND aap.wall_id IS NOT NULL`, contentId).map((row) => row.device_id),
  ].filter(Boolean);
}

function deviceIdsUsingWidgets(db, widgetIds) {
  const deviceIds = [];
  for (const widgetId of widgetIds) {
    deviceIds.push(
      ...rows(db, 'SELECT DISTINCT device_id FROM assignments WHERE widget_id=?', widgetId).map((row) => row.device_id),
      ...rows(db, 'SELECT DISTINCT device_id FROM schedules WHERE widget_id=? AND device_id IS NOT NULL', widgetId).map((row) => row.device_id),
      ...rows(db, `SELECT DISTINCT dgm.device_id FROM schedules s
        JOIN device_group_members dgm ON dgm.group_id=s.group_id WHERE s.widget_id=?`, widgetId).map((row) => row.device_id),
      ...rows(db, `SELECT DISTINCT d.id AS device_id FROM playlist_items pi
        JOIN devices d ON d.playlist_id=pi.playlist_id WHERE pi.widget_id=?`, widgetId).map((row) => row.device_id),
      ...rows(db, `SELECT DISTINCT dgm.device_id FROM playlist_items pi
        JOIN device_groups dg ON dg.playlist_id=pi.playlist_id
        JOIN device_group_members dgm ON dgm.group_id=dg.id WHERE pi.widget_id=?`, widgetId).map((row) => row.device_id),
      ...rows(db, `SELECT DISTINCT vwd.device_id FROM playlist_items pi
        JOIN video_walls vw ON vw.playlist_id=pi.playlist_id
        JOIN video_wall_devices vwd ON vwd.wall_id=vw.id WHERE pi.widget_id=?`, widgetId).map((row) => row.device_id),
      ...rows(db, `SELECT DISTINCT s.device_id FROM playlist_items pi
        JOIN schedules s ON s.playlist_id=pi.playlist_id
        WHERE pi.widget_id=? AND s.device_id IS NOT NULL`, widgetId).map((row) => row.device_id),
      ...rows(db, `SELECT DISTINCT dgm.device_id FROM playlist_items pi
        JOIN schedules s ON s.playlist_id=pi.playlist_id
        JOIN device_group_members dgm ON dgm.group_id=s.group_id WHERE pi.widget_id=?`, widgetId).map((row) => row.device_id),
    );
  }
  return deviceIds.filter(Boolean);
}

function eraseImpact(db, contentId, options = {}) {
  const content = one(db, 'SELECT * FROM content WHERE id = ?', contentId);
  if (!content) return null;
  const playlists = rows(db, `SELECT DISTINCT p.id, p.name, p.workspace_id
    FROM playlist_items pi JOIN playlists p ON p.id = pi.playlist_id WHERE pi.content_id = ?`, contentId);
  const assignments = rows(db, 'SELECT id, device_id FROM assignments WHERE content_id = ?', contentId);
  const schedules = rows(db, 'SELECT id, title, widget_id, playlist_id FROM schedules WHERE content_id = ?', contentId);
  const walls = rows(db, 'SELECT id, name FROM video_walls WHERE content_id = ?', contentId);
  const scenes = rows(db, 'SELECT id, activity_id, device_id, wall_id FROM activity_asset_placements WHERE content_id = ?', contentId);
  const presentationLinks = rows(db, `SELECT pa.id, pa.presentation_id, p.title
    FROM presentation_assets pa LEFT JOIN presentations p ON p.id = pa.presentation_id
    WHERE pa.content_id = ?`, contentId);
  const canvases = rows(db, `SELECT acl.id, acl.endpoint_id, acl.label, acl.source_json, acl.render_json
    FROM advanced_canvas_layers acl WHERE acl.source_json LIKE ? OR acl.render_json LIKE ?`, `%${contentId}%`, `%${contentId}%`)
    .filter((row) => jsonReferences(parseJson(row.source_json), contentId)
      || jsonReferences(parseJson(row.render_json), contentId));
  const devices = rows(db, 'SELECT id, name FROM devices WHERE default_content_id = ?', contentId);
  const widgets = rows(db, 'SELECT id, name, config FROM widgets WHERE config LIKE ?', `%${contentId}%`)
    .filter((row) => jsonReferences(parseJson(row.config), contentId));
  const grids = rows(db, `SELECT id, filename, remote_url FROM content
    WHERE id <> ? AND remote_url LIKE '%/player/grid.html%cells=%'`, contentId)
    .filter((row) => gridReference(row, contentId));
  const affectedDevices = deviceIdsUsingContent(db, contentId);
  affectedDevices.push(
    ...grids.flatMap((grid) => deviceIdsUsingContent(db, grid.id)),
    ...deviceIdsUsingWidgets(db, widgets.map((widget) => widget.id)),
  );
  const checksum = one(db, 'SELECT asset_id, generation FROM asset_checksums WHERE content_id = ?', contentId);
  const nodeRows = checksum
    ? rows(db, 'SELECT node_id FROM node_assets WHERE asset_id = ?', checksum.asset_id)
    : [];
  const foreignKeys = foreignKeyImpact(db, contentId);
  const localFiles = classifyLocalFiles(db, content, options.contentDir || process.cwd());
  const blockers = [...foreignKeys.filter((fk) => !fk.handled), ...localFiles.blocked_files];
  const categories = {
    playlists: playlists.length,
    assignments: assignments.length,
    schedules: schedules.length,
    walls: walls.length,
    scenes: scenes.length,
    presentations: presentationLinks.length,
    canvases: canvases.length,
    device_defaults: devices.length,
    widgets: widgets.length,
    composite_grids: grids.length,
  };
  return {
    content: { id: content.id, filename: content.filename, mime_type: content.mime_type, workspace_id: content.workspace_id },
    dependency_count: Object.values(categories).reduce((sum, count) => sum + count, 0),
    categories,
    dependencies: { playlists, assignments, schedules, walls, scenes, presentationLinks, canvases, devices, widgets, grids },
    affected_device_ids: [...new Set(affectedDevices)],
    affected_canvas_endpoint_ids: [...new Set(canvases.map((canvas) => canvas.endpoint_id).filter(Boolean))],
    files: localFiles.files,
    shared_files: localFiles.shared_files,
    blocked_files: localFiles.blocked_files,
    cache: {
      asset_id: checksum?.asset_id || content.id,
      generation: Number(checksum?.generation) || Number(content.version) || 1,
      node_ids: nodeRows.map((row) => row.node_id),
    },
    foreign_keys: foreignKeys,
    blockers,
  };
}

function publicEraseImpact(impact) {
  if (!impact) return null;
  const safeDependencies = {};
  const fields = {
    playlists: ['id', 'name', 'workspace_id'],
    assignments: ['id', 'device_id'],
    schedules: ['id', 'title', 'widget_id', 'playlist_id'],
    walls: ['id', 'name'],
    scenes: ['id', 'activity_id'],
    presentationLinks: ['id', 'presentation_id', 'title'],
    canvases: ['id', 'endpoint_id', 'label'],
    devices: ['id', 'name'],
    widgets: ['id', 'name'],
    grids: ['id', 'filename'],
  };
  for (const [category, allowedFields] of Object.entries(fields)) {
    safeDependencies[category] = (impact.dependencies?.[category] || []).map((entry) => Object.fromEntries(
      allowedFields.filter((field) => entry[field] != null).map((field) => [field, entry[field]]),
    ));
  }
  const safeBlocker = (blocker) => Object.fromEntries(
    ['type', 'reason', 'table', 'column', 'action', 'count', 'handled']
      .filter((field) => blocker?.[field] != null)
      .map((field) => [field, blocker[field]]),
  );
  return {
    content: impact.content,
    dependency_count: impact.dependency_count,
    categories: impact.categories,
    dependencies: safeDependencies,
    affected_device_ids: impact.affected_device_ids,
    files: (impact.files || []).map((value) => path.basename(value)),
    shared_files: (impact.shared_files || []).map((value) => path.basename(value)),
    blocked_files: (impact.blocked_files || []).map(safeBlocker),
    blockers: (impact.blockers || []).map(safeBlocker),
    foreign_keys: (impact.foreign_keys || []).map(safeBlocker),
  };
}

function publicEraseResult(result) {
  if (!result) return null;
  const files = result.files || [];
  const cachePurge = result.cache_purge;
  return {
    success: result.success,
    operation_id: result.operation_id,
    content_id: result.content_id,
    impact: publicEraseImpact(result.impact),
    detachments: result.detachments,
    file_cleanup: {
      attempted: files.length,
      removed: files.filter((file) => file.removed).length,
      pending: files.filter((file) => !file.removed).length,
    },
    cache_purge: cachePurge ? {
      requested: cachePurge.requested,
      content_id: cachePurge.content_id,
      generation: cachePurge.generation,
      reason: cachePurge.reason,
      deferred_reconciliation: cachePurge.deferred_reconciliation,
      nodes: (cachePurge.nodes || []).map((node) => ({
        node_id: node.node_id,
        requested: node.requested,
        acknowledged: node.acknowledged,
        purged: node.purged,
        offline: node.offline,
        protocol_unsupported: node.protocol_unsupported,
        reason: node.reason,
        deferred_reconciliation: node.deferred_reconciliation,
        error: node.error || null,
      })),
    } : null,
    device_refresh_warning: result.device_refresh_warning || null,
  };
}

function scrubPublishedSnapshot(raw, contentId) {
  const parsed = parseJson(raw);
  if (!Array.isArray(parsed)) return raw;
  const filtered = parsed.filter((item) => String(item?.content_id || '') !== contentId);
  return filtered.length === parsed.length ? raw : JSON.stringify(filtered);
}

function addPresentationReviewFlag(deck, contentId, force = false) {
  const scrubbed = scrubJson(deck, contentId);
  if (!scrubbed.changed && !force) return scrubbed;
  const next = scrubbed.value && typeof scrubbed.value === 'object' ? scrubbed.value : {};
  const flag = 'Media was permanently erased from the Media Library; review this deck before presenting.';
  const flags = Array.isArray(next.review_flags) ? next.review_flags : [];
  if (!flags.includes(flag)) flags.push(flag);
  next.review_flags = flags;
  return { value: next, changed: true };
}

function setEraseOperationState(db, operationId, state, error = null) {
  const now = Math.floor(Date.now() / 1000);
  const committedAt = state === 'catalog_committed' ? now : null;
  const completedAt = ['completed', 'rolled_back'].includes(state) ? now : null;
  db.prepare(`UPDATE content_erase_operations SET state=?, error=?, updated_at=?,
    catalog_committed_at=COALESCE(catalog_committed_at, ?),
    completed_at=COALESCE(completed_at, ?) WHERE id=?`)
    .run(state, error ? String(error).slice(0, 1000) : null, now, committedAt, completedAt, operationId);
}

function restoreStagedFiles(stagedFiles, renameFile = fs.renameSync) {
  const errors = [];
  for (const staged of [...stagedFiles].reverse()) {
    if (!fs.existsSync(staged.stagedPath)) continue;
    try {
      if (fs.existsSync(staged.originalPath)) {
        errors.push(`original_exists:${staged.originalPath}`);
        continue;
      }
      renameFile(staged.stagedPath, staged.originalPath);
    } catch (error) {
      errors.push(`${error.code || error.message}:${staged.originalPath}`);
    }
  }
  return errors;
}

function validRecoveryManifest(operation, contentDir) {
  let manifest;
  try { manifest = JSON.parse(operation.file_manifest_json || '[]'); } catch { return null; }
  if (!Array.isArray(manifest)) return null;
  const root = path.resolve(contentDir);
  for (const entry of manifest) {
    if (!entry || typeof entry.originalPath !== 'string' || typeof entry.stagedPath !== 'string') return null;
    const original = path.resolve(entry.originalPath);
    const staged = path.resolve(entry.stagedPath);
    if (!original.startsWith(`${root}${path.sep}`) || !staged.startsWith(`${root}${path.sep}`)) return null;
    if (!staged.endsWith(`.erasing-${operation.id}`)) return null;
  }
  return manifest;
}

function realPathWithinRoot(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || !relative.startsWith('..') && !path.isAbsolute(relative);
}

function recoveryEntryIsSafe(entry, realRoot) {
  for (const filePath of [entry.originalPath, entry.stagedPath]) {
    let realParent;
    try { realParent = fs.realpathSync(path.dirname(filePath)); } catch { return false; }
    if (!realPathWithinRoot(realRoot, realParent)) return false;
    try {
      const stat = fs.lstatSync(filePath);
      if (stat.isSymbolicLink() || !stat.isFile()) return false;
      if (!realPathWithinRoot(realRoot, fs.realpathSync(filePath))) return false;
    } catch (error) {
      if (error.code !== 'ENOENT') return false;
    }
  }
  return true;
}

function reconcileEraseOperations(db, contentDir, options = {}) {
  const renameFile = options.renameFile || fs.renameSync;
  migrateContentEraseLedger(db);
  let realRoot = null;
  try { realRoot = fs.realpathSync(path.resolve(contentDir)); } catch { /* handled per operation */ }
  const operations = db.prepare(`SELECT * FROM content_erase_operations
    WHERE state IN ('prepared','staged','catalog_committed','cleanup_pending','recovery_failed')
    ORDER BY created_at,id`).all();
  const results = [];
  for (const operation of operations) {
    const manifest = validRecoveryManifest(operation, contentDir);
    if (!manifest || !realRoot) {
      setEraseOperationState(db, operation.id, 'recovery_failed', 'Invalid erase recovery manifest');
      results.push({ operation_id: operation.id, state: 'recovery_failed' });
      continue;
    }
    const contentExists = Boolean(one(db, 'SELECT 1 FROM content WHERE id=?', operation.content_id));
    if (contentExists) {
      let recoveryError = null;
      for (const entry of [...manifest].reverse()) {
        if (!recoveryEntryIsSafe(entry, realRoot)) {
          recoveryError = 'Unsafe erase recovery path';
          break;
        }
        if (!fs.existsSync(entry.stagedPath)) continue;
        if (fs.existsSync(entry.originalPath)) {
          recoveryError = 'Both original and staged erase files exist; automatic overwrite refused';
          break;
        }
        try { renameFile(entry.stagedPath, entry.originalPath); } catch (error) { recoveryError = error.code || error.message; break; }
      }
      const state = recoveryError ? 'recovery_failed' : 'rolled_back';
      setEraseOperationState(db, operation.id, state, recoveryError);
      results.push({ operation_id: operation.id, state });
      continue;
    }
    let cleanupError = null;
    let unsafeRecovery = false;
    for (const entry of manifest) {
      if (!recoveryEntryIsSafe(entry, realRoot)) {
        cleanupError = 'Unsafe erase recovery path';
        unsafeRecovery = true;
        break;
      }
      try { if (fs.existsSync(entry.stagedPath)) fs.unlinkSync(entry.stagedPath); } catch (error) { cleanupError = error.code || error.message; }
    }
    const state = unsafeRecovery ? 'recovery_failed' : cleanupError ? 'cleanup_pending' : 'completed';
    setEraseOperationState(db, operation.id, state, cleanupError);
    results.push({ operation_id: operation.id, state });
  }
  return results;
}

function eraseContent(db, contentId, options = {}) {
  const renameFile = options.renameFile || fs.renameSync;
  const restoreFile = options.restoreFile || fs.renameSync;
  migrateContentEraseLedger(db);
  let impact = eraseImpact(db, contentId, options);
  if (!impact) return null;
  if (impact.blockers.length) {
    const error = new Error('An unhandled database dependency prevents permanent erase.');
    error.code = 'ERASE_DEPENDENCY_BLOCKED';
    error.impact = impact;
    throw error;
  }

  const detachments = {};
  const preparedOperation = one(db, `SELECT id FROM content_erase_operations
    WHERE content_id=? AND state='prepared' ORDER BY created_at,id LIMIT 1`, contentId);
  const operationId = String(preparedOperation?.id || options.operationId || randomUUID());
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(operationId)) {
    const error = new Error('Invalid erase operation identity.');
    error.code = 'ERASE_OPERATION_ID_INVALID';
    throw error;
  }
  const now = Math.floor(Date.now() / 1000);
  const beginBarrier = db.transaction(() => {
    if (!preparedOperation) {
      db.prepare(`INSERT INTO content_erase_operations
        (id,content_id,state,file_manifest_json,created_at,updated_at)
        VALUES (?,?,'prepared','[]',?,?)`).run(operationId, contentId, now, now);
    }
    run(db, `UPDATE media_jobs SET cancel_requested=1,updated_at=strftime('%s','now')
      WHERE content_id=? AND status IN ('queued','running','retry_wait')`, contentId);
    run(db, `UPDATE download_jobs SET status='error',error_msg='Content permanently erased',
      completed_at=strftime('%s','now') WHERE content_id=?`, contentId);
    // Reconcile a crashed worker's stale lease: a `running` job whose lease has
    // already expired was never going to heartbeat again, so cancel it now using
    // the same clock units (Unix seconds) and cancellation semantics as
    // MediaJobStore.settleExpiredCancellations. This prevents a dead row from
    // blocking permanent erase forever.
    run(db, `UPDATE media_jobs SET status='cancelled', stage='cancelled', retryable=0,
        error_code='media_job_cancelled', error_message='Media job cancelled after expired lease during permanent erase',
        lease_owner=NULL, lease_expires_at=NULL, completed_at=?, updated_at=?
      WHERE content_id=? AND status='running' AND cancel_requested=1
        AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?`, now, now, contentId, now);
  });
  beginBarrier();
  const activeJobs = rows(db, `SELECT id,lease_owner,lease_expires_at FROM media_jobs
    WHERE content_id=? AND status='running'
      AND (lease_expires_at IS NULL OR lease_expires_at > ?)`, contentId, now);
  if (activeJobs.length) {
    const error = new Error('Permanent erase is waiting for active media processing to stop safely.');
    error.code = 'ERASE_JOB_QUIESCENCE_REQUIRED';
    error.operation_id = operationId;
    error.impact = impact;
    error.active_job_count = activeJobs.length;
    throw error;
  }
  impact = eraseImpact(db, contentId, options);
  if (!impact || impact.blockers.length) {
    setEraseOperationState(db, operationId, 'rolled_back', 'Erase impact changed after job cancellation barrier');
    const error = new Error('An unhandled database dependency prevents permanent erase.');
    error.code = 'ERASE_DEPENDENCY_BLOCKED';
    error.impact = impact;
    throw error;
  }
  const fileManifest = impact.files.filter((originalPath) => fs.existsSync(originalPath)).map((originalPath) => ({
    originalPath,
    stagedPath: `${originalPath}.erasing-${operationId}`,
  }));
  db.prepare('UPDATE content_erase_operations SET file_manifest_json=?,updated_at=? WHERE id=?')
    .run(JSON.stringify(fileManifest), now, operationId);
  const stagedFiles = [];
  try {
    for (const { originalPath, stagedPath } of fileManifest) {
      renameFile(originalPath, stagedPath);
      stagedFiles.push({ originalPath, stagedPath });
    }
    setEraseOperationState(db, operationId, 'staged');
  } catch (error) {
    const recoveryErrors = restoreStagedFiles(stagedFiles, restoreFile);
    setEraseOperationState(
      db,
      operationId,
      recoveryErrors.length ? 'recovery_failed' : 'rolled_back',
      [error.code || error.message, ...recoveryErrors].join('; '),
    );
    const failure = new Error('Media bytes could not be staged safely for permanent erase.');
    failure.code = 'ERASE_FILE_STAGE_FAILED';
    failure.cause = error;
    throw failure;
  }

  const commit = db.transaction(() => {
    run(db, `UPDATE media_jobs SET cancel_requested = 1, status = 'cancelled', stage = 'cancelled',
      lease_owner = NULL, lease_expires_at = NULL, completed_at = strftime('%s','now'), updated_at = strftime('%s','now')
      WHERE content_id = ? AND status IN ('queued','retry_wait')`, contentId);
    run(db, `UPDATE download_jobs SET status = 'error', error_msg = 'Content permanently erased',
      completed_at = strftime('%s','now') WHERE content_id = ?`, contentId);

    detachments.assignments = run(db, 'DELETE FROM assignments WHERE content_id = ?', contentId).changes;
    const scheduleUpdate = run(db, `UPDATE schedules SET content_id = NULL, updated_at = strftime('%s','now')
      WHERE content_id = ?`, contentId).changes;
    detachments.schedules_preserved = scheduleUpdate;
    detachments.schedules_removed = 0;
    detachments.walls = run(db, `UPDATE video_walls SET content_id = NULL, updated_at = strftime('%s','now')
      WHERE content_id = ?`, contentId).changes;
    let sceneCount = 0;
    for (const scene of impact.dependencies.scenes) {
      const current = one(db, 'SELECT custom_properties_json FROM activity_asset_placements WHERE id=?', scene.id);
      const properties = parseJson(current?.custom_properties_json, {});
      properties.media_status = 'permanently_erased';
      properties.erased_content_id = contentId;
      sceneCount += run(db, `UPDATE activity_asset_placements
        SET content_id=NULL,custom_properties_json=? WHERE id=?`, JSON.stringify(properties), scene.id).changes;
    }
    detachments.scenes = sceneCount;
    detachments.device_defaults = run(db, `UPDATE devices SET default_content_id = NULL,
      updated_at = strftime('%s','now') WHERE default_content_id = ?`, contentId).changes;

    for (const playlist of impact.dependencies.playlists) {
      run(db, 'DELETE FROM playlist_items WHERE playlist_id = ? AND content_id = ?', playlist.id, contentId);
      const remaining = rows(db, 'SELECT id FROM playlist_items WHERE playlist_id = ? ORDER BY sort_order, id', playlist.id);
      remaining.forEach((item, index) => run(db, `UPDATE playlist_items SET sort_order = ?,
        updated_at = strftime('%s','now') WHERE id = ?`, index, item.id));
      const current = one(db, 'SELECT published_snapshot FROM playlists WHERE id = ?', playlist.id);
      const snapshot = scrubPublishedSnapshot(current?.published_snapshot, contentId);
      run(db, `UPDATE playlists SET published_snapshot = ?, updated_at = strftime('%s','now') WHERE id = ?`, snapshot, playlist.id);
    }
    detachments.playlists = impact.dependencies.playlists.length;

    for (const widget of impact.dependencies.widgets) {
      const scrubbed = scrubJson(parseJson(widget.config, {}), contentId);
      if (scrubbed.changed) run(db, `UPDATE widgets SET config = ?, updated_at = strftime('%s','now') WHERE id = ?`, JSON.stringify(scrubbed.value || {}), widget.id);
    }
    detachments.widgets = impact.dependencies.widgets.length;

    for (const grid of impact.dependencies.grids) {
      const rewritten = rewriteGridUrl(grid.remote_url, contentId);
      if (rewritten) run(db, `UPDATE content SET remote_url = ?, version = COALESCE(version, 1) + 1,
        updated_at = strftime('%s','now') WHERE id = ?`, rewritten, grid.id);
    }
    detachments.composite_grids = impact.dependencies.grids.length;

    for (const layer of impact.dependencies.canvases) {
      const source = scrubJson(parseJson(layer.source_json, {}), contentId);
      const render = scrubJson(parseJson(layer.render_json, {}), contentId);
      const safeSource = source.changed ? source.value : {
        media_status: 'permanently_erased', erased_content_id: contentId,
      };
      const safeRender = render.changed ? render.value : {
        kind: 'missing', media_status: 'permanently_erased', erased_content_id: contentId,
      };
      run(db, `UPDATE advanced_canvas_layers SET source_json=?,render_json=?,
        updated_at=strftime('%s','now') WHERE id=?`, JSON.stringify(safeSource), JSON.stringify(safeRender), layer.id);
      run(db, `UPDATE advanced_canvas_endpoints SET scene_revision = scene_revision + 1,
        updated_at = strftime('%s','now') WHERE id = ?`, layer.endpoint_id);
    }
    detachments.canvases = impact.dependencies.canvases.length;

    const presentations = new Set(impact.dependencies.presentationLinks.map((link) => link.presentation_id));
    for (const presentationId of presentations) {
      const presentation = one(db, 'SELECT deck_json, published_snapshot FROM presentations WHERE id = ?', presentationId);
      const deck = addPresentationReviewFlag(parseJson(presentation?.deck_json, {}), contentId, true);
      const published = addPresentationReviewFlag(parseJson(presentation?.published_snapshot, {}), contentId, true);
      run(db, `UPDATE presentations SET deck_json = ?, published_snapshot = ?,
        updated_at = strftime('%s','now') WHERE id = ?`,
      JSON.stringify(deck.value), presentation?.published_snapshot == null ? null : JSON.stringify(published.value), presentationId);
      for (const slide of rows(db, 'SELECT id, slide_json FROM presentation_slides WHERE presentation_id = ?', presentationId)) {
        const scrubbed = addPresentationReviewFlag(parseJson(slide.slide_json, {}), contentId);
        if (scrubbed.changed) run(db, `UPDATE presentation_slides SET slide_json = ?,
          updated_at = strftime('%s','now') WHERE id = ?`, JSON.stringify(scrubbed.value), slide.id);
      }
    }
    detachments.presentations = presentations.size;

    if (impact.cache.asset_id) run(db, 'DELETE FROM node_assets WHERE asset_id = ?', impact.cache.asset_id);
    if (typeof options.audit === 'function') options.audit(impact.content, impact);
    run(db, 'DELETE FROM content WHERE id = ?', contentId);
    const violations = rows(db, 'PRAGMA foreign_key_check');
    if (violations.length) {
      const error = new Error('Foreign key integrity check failed during permanent erase.');
      error.code = 'ERASE_FOREIGN_KEY_FAILURE';
      error.violations = violations;
      throw error;
    }
    setEraseOperationState(db, operationId, 'catalog_committed');
  });
  try {
    commit();
  } catch (error) {
    const recoveryErrors = restoreStagedFiles(stagedFiles, restoreFile);
    setEraseOperationState(
      db,
      operationId,
      recoveryErrors.length ? 'recovery_failed' : 'rolled_back',
      [error.code || error.message, ...recoveryErrors].join('; '),
    );
    throw error;
  }

  const files = [];
  for (const { originalPath, stagedPath } of stagedFiles) {
    try {
      fs.unlinkSync(stagedPath);
      files.push({ path: originalPath, removed: true });
    } catch (error) {
      files.push({ path: originalPath, staged_path: stagedPath, removed: false, error: error.code || error.message });
    }
  }
  const success = files.every((file) => file.removed);
  setEraseOperationState(db, operationId, success ? 'completed' : 'cleanup_pending', success ? null : 'One or more staged files remain');
  return { success, operation_id: operationId, content_id: contentId, impact, detachments, files };
}

module.exports = {
  addPresentationReviewFlag,
  classifyLocalFiles,
  collectLocalFiles,
  contentUrlMatches,
  eraseContent,
  eraseImpact,
  gridReference,
  jsonReferences,
  publicEraseImpact,
  publicEraseResult,
  reconcileEraseOperations,
  rewriteGridUrl,
  scrubJson,
};
