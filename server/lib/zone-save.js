// Pure: plan a FULL zone save (the layout-editor "Save" action) for a layout.
//
// The editor previously persisted by DELETE-ing every existing zone then
// POST-ing the new set as N+M separate, non-transactional HTTP calls — a
// mid-sequence failure could leave the layout half-wiped, and even a clean run
// destroyed every zone id (breaking playlist_items.zone_id / schedules.zone_id
// bindings, which are ON DELETE CASCADE / SET NULL).
//
// This planner reuses the same slot-wise reconcileZones diff the region editor
// uses for presets, so surviving zones keep their ids (no delete+recreate), and
// returns ready-to-run row params. The route runs the whole plan inside a single
// better-sqlite3 db.transaction() so it is all-or-nothing.
//
// Returns { updates:[updateRow], inserts:[insertRow], deleteIds:[id] } where
// each row is a plain object of the columns to write. Pure — no db, no throw.
const { reconcileZones } = require('./reconcile-zones');

// Coerce a desired-zone field to its stored shape, falling back to the column
// default when the editor omitted it. Mirrors the defaults used by the
// POST /:id/zones and apply-preset INSERT shapes so behaviour is unchanged.
function zoneFields(z, slotOrder) {
  return {
    name: z.name || 'Zone',
    x_percent: z.x_percent || 0,
    y_percent: z.y_percent || 0,
    width_percent: z.width_percent != null ? z.width_percent : 100,
    height_percent: z.height_percent != null ? z.height_percent : 100,
    z_index: z.z_index || 0,
    zone_type: z.zone_type || 'content',
    fit_mode: z.fit_mode || 'cover',
    background_color: z.background_color || '#000000',
    sort_order: z.sort_order != null ? z.sort_order : slotOrder,
  };
}

// existing: rows from `SELECT * FROM layout_zones WHERE layout_id = ?`.
// desired:  the editor's zone list (each may carry an `id` for clarity, but the
//           diff is by slot/sort_order — matching reconcileZones — so reordered
//           saves still reuse ids slot-wise instead of churning them).
function planZoneSave(existing, desired) {
  const { updates, inserts, deleteIds } = reconcileZones(existing, desired);
  return {
    updates: updates.map((z, i) => ({ id: z.id, ...zoneFields(z, i) })),
    inserts: inserts.map((z, i) => zoneFields(z, updates.length + i)),
    deleteIds,
  };
}

module.exports = { planZoneSave };
