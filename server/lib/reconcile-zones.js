// Pure: reconcile a layout's EXISTING zone rows against a DESIRED zone set
// (e.g. a preset) by slot index (sort_order), so existing zone ids are reused
// instead of deleted+recreated. This preserves playlist_items.zone_id bindings.
// Returns { updates:[{id, ...desiredFields}], inserts:[...desiredZones], deleteIds:[...] }.
function reconcileZones(existing, desired) {
  const ex = [...(existing || [])].sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0));
  const want = [...(desired || [])].sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0));
  const updates = [];
  const inserts = [];
  for (let i = 0; i < want.length; i++) {
    if (i < ex.length) updates.push({ id: ex[i].id, ...want[i] });
    else inserts.push(want[i]);
  }
  const deleteIds = ex.slice(want.length).map(z => z.id);
  return { updates, inserts, deleteIds };
}

module.exports = { reconcileZones };
